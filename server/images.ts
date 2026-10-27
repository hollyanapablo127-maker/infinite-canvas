import { Router } from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db, transaction, settings, type Row } from "./db";
import {
  asyncRoute,
  ensure,
  hash,
  sign,
  decrypt,
  apiKeyAllowsModel,
} from "./security";
import {
  validateImageGeneration,
  imageGenerationSchema,
  getSizeCategory,
  imageReserveCategory,
  IMAGE_OFFICIAL_PRICES,
  MODEL_CAPABILITIES,
  type ImageMeta,
} from "../shared/image";
import { getOwnedAsset, importAsset, saveAsset } from "./assets";
import { charge, yuan, walletEntry } from "./finance";
import { fetchPublic } from "./network";
import { inputAssetUrl, readObject } from "./storage";

import {
  ensureModel,
  refreshModelAdapters,
  modelRoutes,
  userMultiplier,
  discountedPrice,
} from "./catalog";
import { apiRoot, bailianHost } from "../shared/protocols";
import { adapterModel } from "../shared/catalog";

function jsonValue(value: unknown, fallback: any = {}) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function priceSnapshot(rows: Row[], multiplier = 1) {
  return Object.fromEntries(
    rows.map((row) => [
      row.size_category,
      {
        version: Number(row.version),
        input: discountedPrice(row.input_sale_micro, multiplier),
        output: discountedPrice(row.output_sale_micro, multiplier),
        multiplier,
      },
    ]),
  );
}

async function addImageEvent(
  tx: {
    query: <T extends Row = Row>(text: string, params?: any[]) => Promise<T[]>;
  },
  taskId: string,
  event: string,
  detail?: string,
) {
  await tx.query(
    "INSERT INTO image_task_events(id,task_id,event,detail,created_at) VALUES($1,$2,$3,$4,now())",
    [randomUUID(), taskId, event, detail || null],
  );
}

async function releaseImageTask(
  tx: {
    query: <T extends Row = Row>(text: string, params?: any[]) => Promise<T[]>;
  },
  task: Row,
  status: string,
  message: string,
) {
  if (task.settlement === "reserved" && Number(task.reserved_micro) > 0) {
    await walletEntry(tx, task.user_id, {
      type: "unfreeze",
      amount: 0,
      frozen: -Number(task.reserved_micro),
      key: `image-release:${task.id}`,
      reason: message,
      imageTaskId: task.id,
    });
  }
  await tx.query(
    "UPDATE image_tasks SET status=$2,error=$3,settlement=CASE WHEN settlement='reserved' THEN 'released' ELSE settlement END,reserved_micro=0,next_poll_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
    [task.id, status, message],
  );
  await addImageEvent(tx, task.id, status, message);
}

export function publicImageTask(task: Row) {
  return {
    id: task.id,
    project_id: task.project_id,
    node_id: task.node_id,
    model: task.model,
    mode: task.mode,
    prompt: task.prompt,
    parameters: jsonValue(task.parameters),
    status: task.status,
    settlement: task.settlement,
    size_category: task.size_category,
    input_count: Number(task.input_count || 0),
    output_count: Number(task.output_count || 0),
    actual_output_count:
      task.actual_output_count == null
        ? null
        : Number(task.actual_output_count),
    result_assets: jsonValue(task.result_assets, []),
    usage: jsonValue(task.usage, null),
    reserved: yuan(task.reserved_micro),
    charged: yuan(task.charged_micro ?? 0),
    error: task.error,
    upstream_task_id: task.upstream_task_id,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export async function prepareImageGeneration(
  raw: unknown,
  userId: string,
  options: { deferValidation?: boolean } = {},
) {
  await refreshModelAdapters();
  const input = imageGenerationSchema.parse(raw);
  await ensureModel(input.model, "image");
  const metadata: ImageMeta[] = [];
  const prepared: Row[] = [];

  for (const image of input.input.images) {
    const asset = image.asset_id
      ? await getOwnedAsset(image.asset_id, userId)
      : await importAsset(userId, image.url!);
    image.asset_id = asset.id;
    delete image.url;
    prepared.push({ asset_id: asset.id });
    metadata.push({
      ...asset.metadata,
      kind: asset.kind,
      size: Number(asset.size),
    });
  }

  const check = options.deferValidation
    ? null
    : validateImageGeneration(input, metadata);

  if (input.project_id) {
    ensure(
      (
        await db.query(
          "SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
          [input.project_id, userId],
        )
      ).length,
      "画布不存在",
      404,
    );
  }

  const category =
    check?.sizeCategory ||
    imageReserveCategory(input.parameters.size, input.model);
  const rows = await db.query(
    "SELECT * FROM image_prices WHERE model=$1 AND enabled AND deleted_at IS NULL ORDER BY size_category",
    [input.model],
  );
  const multiplier = await userMultiplier(userId);
  const snapshot = priceSnapshot(rows, multiplier);
  const basePrice = rows.find((row) => row.size_category === category);
  ensure(basePrice, "模型规格暂不可用", 503);
  const price: Row = {
    ...basePrice,
    input_sale_micro: discountedPrice(basePrice.input_sale_micro, multiplier),
    output_sale_micro: discountedPrice(basePrice.output_sale_micro, multiplier),
  };

  const inputCount = check?.inputCount ?? 0;
  const outputCount = check?.outputCount ?? input.parameters.n;
  const reserve =
    charge(price.input_sale_micro, inputCount) +
    charge(price.output_sale_micro, outputCount);

  return {
    input,
    prepared,
    inputCount,
    outputCount,
    sizeCategory: category,
    price,
    multiplier,
    priceSnapshot: snapshot,
    priceSnapshotHash: hash(JSON.stringify(snapshot)),
    reserve,
  };
}

export const imageQuoteRouter = Router();
imageQuoteRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const config = await settings();
    ensure(!config.maintenance, "系统维护中，暂不接受新任务", 503);
    const quote = await prepareImageGeneration(req.body, req.user.id);
    if (req.apiKey)
      ensure(
        apiKeyAllowsModel(req.apiKey, quote.input.model),
        "此密钥不可调用该模型",
        403,
      );
    const expires = Date.now() + 300000;
    const payload = Buffer.from(
      JSON.stringify({
        user: req.user.id,
        body: hash(JSON.stringify(quote.input)),
        price: quote.price.id,
        priceVersion: quote.price.version,
        pricesHash: quote.priceSnapshotHash,
        multiplier: quote.multiplier,
        expires,
        reserve: quote.reserve,
      }),
    ).toString("base64url");
    res.json({
      token: `${payload}.${sign(payload)}`,
      input: quote.input,
      inputPrice: yuan(quote.price.input_sale_micro),
      outputPrice: yuan(quote.price.output_sale_micro),
      inputCount: quote.inputCount,
      outputCount: quote.outputCount,
      reserved: yuan(quote.reserve),
      sizeCategory: quote.sizeCategory,
      autoSize: quote.input.parameters.size === "auto",
      expiresAt: expires,
    });
  }),
);

export async function submitImageGeneration(
  user: Row,
  key: Row | undefined,
  raw: unknown,
  quoteToken: string,
  idempotency: string,
  workflowId?: string,
) {
  await refreshModelAdapters();
  const input = imageGenerationSchema.parse(raw);
  const bodyHash = hash(JSON.stringify(input));
  ensure(
    idempotency.length >= 8 && idempotency.length <= 128,
    "请提供有效的 Idempotency-Key",
  );

  const [prior] = await db.query(
    "SELECT * FROM image_tasks WHERE user_id=$1 AND idempotency_key=$2",
    [user.id, idempotency],
  );
  if (prior) {
    ensure(prior.request_hash === bodyHash, "同一幂等键不能提交不同内容", 409);
    return prior;
  }

  const [payload, signature] = quoteToken.split(".");
  ensure(
    payload && signature && sign(payload) === signature,
    "报价无效，请重新获取",
  );
  const quote = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  ensure(
    quote.user === user.id &&
      quote.body === bodyHash &&
      quote.expires > Date.now(),
    "报价已过期或参数已修改",
  );

  const prepared = await prepareImageGeneration(input, user.id);
  ensure(
    prepared.price.id === quote.price &&
      prepared.price.version === quote.priceVersion &&
      prepared.priceSnapshotHash === quote.pricesHash &&
      prepared.reserve === quote.reserve &&
      prepared.multiplier === Number(quote.multiplier ?? 1),
    "价格或素材发生变化，请重新获取报价",
  );

  return transaction(async (tx) => {
    ensure(
      (await userMultiplier(user.id, tx, true)) === prepared.multiplier,
      "专属倍率已变化，请重新获取报价",
    );
    const catalogEntry = await ensureModel(
      input.model,
      "image",
      tx,
      false,
      true,
    );
    const livePrices = await tx.query(
      "SELECT * FROM image_prices WHERE model=$1 AND enabled AND deleted_at IS NULL ORDER BY size_category FOR SHARE",
      [input.model],
    );
    ensure(
      hash(JSON.stringify(priceSnapshot(livePrices, prepared.multiplier))) ===
        quote.pricesHash,
      "价格已变化，请重新获取报价",
    );
    const livePrice = livePrices.find((row) => row.id === prepared.price.id);
    ensure(
      livePrice?.version === prepared.price.version,
      "价格已变化，请重新获取报价",
    );

    if (workflowId) {
      const [run] = await tx.query(
        "SELECT status FROM workflow_runs WHERE id=$1 FOR UPDATE",
        [workflowId],
      );
      ensure(run?.status === "RUNNING", "批次已停止");
    }
    await tx.query("SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE", [
      user.id,
    ]);
    const [duplicate] = await tx.query(
      "SELECT * FROM image_tasks WHERE user_id=$1 AND idempotency_key=$2",
      [user.id, idempotency],
    );
    if (duplicate) {
      ensure(duplicate.request_hash === bodyHash, "幂等键冲突", 409);
      return duplicate;
    }

    const config = (await tx.query("SELECT value FROM settings WHERE id=1"))[0]
      .value;
    ensure(!config.maintenance, "系统维护中", 503);
    const [{ size }] = await tx.query(
      "SELECT COALESCE(sum(size),0) AS size FROM assets WHERE user_id=$1 AND purged_at IS NULL",
      [user.id],
    );
    const [{ pending }] = await tx.query(
      "SELECT COALESCE(sum(output_count),0)::int AS pending FROM image_tasks WHERE user_id=$1 AND status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING')",
      [user.id],
    );
    ensure(
      Number(size) + (Number(pending) + prepared.outputCount) * 20_000_000 <=
        Number(config.storageLimitGB) * 1_000_000_000,
      "存储空间不足：每张图片需要预留约 20MB 空间",
    );

    if (key) {
      const [fresh] = await tx.query(
        "SELECT * FROM api_keys WHERE id=$1 AND NOT disabled AND NOT revoked AND (expires_at IS NULL OR expires_at>now()) FOR UPDATE",
        [key.id],
      );
      ensure(
        fresh && apiKeyAllowsModel(fresh, input.model),
        "API Key 不可用",
        403,
      );
      for (const [period, limit] of [
        ["day", fresh.daily_limit],
        ["month", fresh.monthly_limit],
      ] as const) {
        if (Number(limit) <= 0) continue;
        const [{ used }] = await tx.query(
          `SELECT COALESCE(sum(CASE WHEN settlement='reserved' THEN reserved_micro ELSE charged_micro END),0) AS used FROM image_tasks WHERE api_key_id=$1 AND created_at>=date_trunc('${period}',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
          [key.id],
        );
        ensure(
          Number(used) + prepared.reserve <= Number(limit),
          `密钥${period === "day" ? "日" : "月"}额度不足`,
        );
      }
    }

    const provider = MODEL_CAPABILITIES[input.model].provider;
    const routes = await modelRoutes(input.model, "image", tx);
    const candidates = await tx.query(
      "SELECT * FROM image_credentials WHERE provider=$1 AND enabled AND NOT deleted ORDER BY priority DESC,created_at,id FOR UPDATE",
      [provider],
    );
    const credential = candidates.find((c) =>
      routes.length || catalogEntry.routing_configured
        ? routes.some((route) => route.channel_id === c.id)
        : !c.metadata?.models?.length ||
          c.metadata.models.includes(adapterModel(input.model)),
    );
    ensure(credential, "暂无可用渠道", 503);
    if (prepared.reserve > 0)
      await walletEntry(tx, user.id, {
        type: "reserve",
        amount: -prepared.reserve,
        frozen: prepared.reserve,
        key: `image-reserve:${randomUUID()}`,
        reason: "图片生成预算预占",
      });

    const taskId = randomUUID();
    const [task] = await tx.query(
      `INSERT INTO image_tasks(
        id,user_id,idempotency_key,request_hash,model,mode,prompt,parameters,input_images,
        credential_id,credential_version,price_id,price_version,price_snapshot,
        input_count,output_count,size_category,input_unit_micro,output_unit_micro,reserved_micro,
        project_id,node_id,api_key_id,workflow_run_id,discount_multiplier,upstream_model,status,created_at,updated_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'QUEUED',now(),now()
      ) RETURNING *`,
      [
        taskId,
        user.id,
        idempotency,
        bodyHash,
        input.model,
        input.mode,
        input.input.prompt,
        input.parameters,
        JSON.stringify(prepared.prepared),
        credential.id,
        credential.key_version,
        prepared.price.id,
        prepared.price.version,
        prepared.priceSnapshot,
        prepared.inputCount,
        prepared.outputCount,
        prepared.sizeCategory,
        prepared.price.input_sale_micro,
        prepared.price.output_sale_micro,
        prepared.reserve,
        input.project_id || null,
        input.node_id || null,
        key?.id || null,
        workflowId || null,
        prepared.multiplier,
        routes.find((route) => route.channel_id === credential.id)
          ?.upstream_model || adapterModel(input.model),
      ],
    );
    await addImageEvent(tx, taskId, "QUEUED", "图片任务已进入队列");
    return task;
  });
}

export const imageGenerationRouter = Router();
imageGenerationRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const { quote, ...body } = req.body;
    ensure(quote, "请提供报价令牌");
    const task = await submitImageGeneration(
      req.user,
      req.apiKey,
      body,
      quote,
      String(req.headers["idempotency-key"] || randomUUID()),
    );
    res.status(202).json(publicImageTask(task));
  }),
);

imageGenerationRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const [task] = await db.query(
      "SELECT * FROM image_tasks WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(task, "任务不存在", 404);
    res.json({
      ...publicImageTask(task),
      events: await db.query(
        "SELECT event,detail,created_at FROM image_task_events WHERE task_id=$1 ORDER BY created_at",
        [task.id],
      ),
    });
  }),
);

imageGenerationRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit)) || 20, 100);
    const offset = Math.max(parseInt(String(req.query.offset)) || 0, 0);
    const projectId = req.query.project_id
      ? String(req.query.project_id)
      : undefined;
    const where = projectId
      ? "user_id=$1 AND project_id=$2"
      : "user_id=$1 AND project_id IS NULL";
    const params = projectId ? [req.user.id, projectId] : [req.user.id];
    const tasks = await db.query(
      `SELECT * FROM image_tasks WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const [{ total }] = await db.query(
      `SELECT count(*)::int AS total FROM image_tasks WHERE ${where}`,
      params,
    );
    res.json({ tasks: tasks.map(publicImageTask), total, limit, offset });
  }),
);

imageGenerationRouter.post(
  "/:id/cancel",
  asyncRoute(async (req, res) => {
    const task = await transaction(async (tx) => {
      const [current] = await tx.query(
        "SELECT * FROM image_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [req.params.id, req.user.id],
      );
      ensure(current, "任务不存在", 404);
      ensure(current.status === "QUEUED", "只能取消尚未提交到上游的任务");
      await releaseImageTask(tx, current, "CANCELED", "任务已取消");
      return (
        await tx.query("SELECT * FROM image_tasks WHERE id=$1", [current.id])
      )[0];
    });
    res.json(publicImageTask(task));
  }),
);

async function imageCredentialVersion(task: Row) {
  const [credential] = await db.query(
    "SELECT c.provider,v.encrypted_key,v.workspace,v.base_url FROM image_credentials c JOIN image_credential_versions v ON v.credential_id=c.id WHERE c.id=$1 AND v.version=$2",
    [task.credential_id, task.credential_version],
  );
  ensure(credential, "图片渠道凭证版本不可用", 503);
  return credential;
}

async function taskInputAssets(task: Row) {
  const inputs = jsonValue(task.input_images, []);
  const assets: Row[] = [];
  for (const input of inputs) {
    ensure(input.asset_id, "参考图片记录无效");
    assets.push(await getOwnedAsset(input.asset_id, task.user_id));
  }
  return assets;
}

function openAiEndpoint(baseUrl: string, resource: "generations" | "edits") {
  const url = new URL(baseUrl);
  ensure(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    "OpenAI 渠道 Base URL 无效",
  );
  const suffix = `/images/${resource}`;
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(suffix)) url.pathname = pathname;
  else if (pathname.endsWith("/v1")) url.pathname = `${pathname}${suffix}`;
  else url.pathname = `${pathname}/v1${suffix}`;
  return url.toString();
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) || `上游返回 ${response.status}` };
  }
}

function upstreamMessage(body: any) {
  return String(
    body?.error?.message ||
      body?.message ||
      body?.error ||
      body?.code ||
      "上游拒绝了图片请求",
  ).slice(0, 600);
}

async function requestQwenImage(task: Row, credential: Row, assets: Row[]) {
  ensure(
    credential.base_url || /^[a-zA-Z0-9-]+$/.test(credential.workspace || ""),
    "Qwen WorkspaceId 无效",
  );
  const content: Row[] = [];
  for (const asset of assets)
    content.push({ image: await inputAssetUrl(asset) });
  content.push({ text: task.prompt });
  const parameters = jsonValue(task.parameters);
  const requestParameters: Row = {
    n: parameters.n,
    prompt_extend: parameters.prompt_extend,
    prompt_extend_mode: parameters.prompt_extend_mode,
    enable_thinking: parameters.enable_thinking,
    watermark: parameters.watermark,
  };
  if (parameters.size !== "auto")
    requestParameters.size = parameters.size.replace("x", "*");
  if (parameters.seed >= 0) requestParameters.seed = parameters.seed;
  if (parameters.negative_prompt)
    requestParameters.negative_prompt = parameters.negative_prompt;
  const response = await fetch(
    `${apiRoot(credential.base_url || bailianHost(credential.workspace, "cn-beijing"))}/api/v1/services/aigc/image-generation/generation`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${decrypt(credential.encrypted_key)}`,
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: task.upstream_model || task.model,
        input: { messages: [{ role: "user", content }] },
        parameters: requestParameters,
      }),
      signal: AbortSignal.timeout(60000),
    },
  );
  return {
    status: response.status,
    ok: response.ok,
    body: await readJsonResponse(response),
  };
}

async function requestOpenAiImage(task: Row, credential: Row, assets: Row[]) {
  const parameters = jsonValue(task.parameters);
  const body: Row = {
    model: task.upstream_model || task.model,
    prompt: task.prompt,
    size: parameters.size,
    n: parameters.n,
    response_format: "b64_json",
  };
  for (const key of ["quality", "background", "output_format", "moderation"])
    if (parameters[key] !== undefined) body[key] = parameters[key];
  if (
    ["jpeg", "webp"].includes(parameters.output_format) &&
    parameters.output_compression !== undefined
  )
    body.output_compression = parameters.output_compression;

  let requestBody: BodyInit;
  let headers: Record<string, string>;
  let endpoint = openAiEndpoint(
    credential.base_url || "",
    assets.length ? "edits" : "generations",
  );
  if (assets.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body))
      form.append(key, String(value));
    for (const asset of assets) {
      const buffer = await readObject(asset.object_key, asset.storage);
      const mime = String(asset.metadata?.mime || "image/png");
      const filename = path.basename(asset.name || "reference.png");
      form.append(
        "image[]",
        new Blob([new Uint8Array(buffer)], { type: mime }),
        filename,
      );
    }
    requestBody = form;
    headers = { Authorization: `Bearer ${decrypt(credential.encrypted_key)}` };
  } else {
    requestBody = JSON.stringify(body);
    headers = {
      Authorization: `Bearer ${decrypt(credential.encrypted_key)}`,
      "Content-Type": "application/json",
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(180000),
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await readJsonResponse(response),
  };
}

export async function dispatchImageTask() {
  const task = await transaction(async (tx) => {
    const [queued] = await tx.query(
      `SELECT t.*,c.enabled AS channel_enabled,u.disabled AS user_disabled
       FROM image_tasks t
       JOIN users u ON u.id=t.user_id
       LEFT JOIN image_credentials c ON c.id=t.credential_id
       WHERE t.status='QUEUED'
       ORDER BY t.created_at,t.id
       LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    );
    if (!queued) return null;
    if (!queued.channel_enabled || queued.user_disabled) {
      await releaseImageTask(
        tx,
        queued,
        "FAILED",
        queued.user_disabled ? "账号已停用" : "图片渠道已停用",
      );
      return null;
    }
    await tx.query(
      "UPDATE image_tasks SET status='SUBMITTING',lease_until=now()+interval '3 minutes',updated_at=now() WHERE id=$1",
      [queued.id],
    );
    await addImageEvent(tx, queued.id, "SUBMITTING", "正在提交图片请求");
    return queued;
  });
  if (!task) return;

  let submitted = false;
  try {
    const [credential] = await Promise.all([imageCredentialVersion(task)]);
    const assets = await taskInputAssets(task);
    submitted = true;
    const result =
      credential.provider === "qwen"
        ? await requestQwenImage(task, credential, assets)
        : await requestOpenAiImage(task, credential, assets);

    if (!result.ok) {
      if (result.status >= 500) {
        await db.query(
          "UPDATE image_tasks SET status='UNKNOWN',error='提交结果待核实，请勿重复提交',response=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
          [task.id, result.body],
        );
        await transaction((tx) =>
          addImageEvent(tx, task.id, "UNKNOWN", `上游 HTTP ${result.status}`),
        );
      } else {
        await transaction(async (tx) => {
          const [current] = await tx.query(
            "SELECT * FROM image_tasks WHERE id=$1 FOR UPDATE",
            [task.id],
          );
          await releaseImageTask(
            tx,
            current,
            "FAILED",
            upstreamMessage(result.body),
          );
        });
      }
      return;
    }

    const upstreamId = result.body?.output?.task_id;
    const status = result.body?.output?.task_status;
    if (credential.provider === "qwen" && upstreamId) {
      await db.query(
        "UPDATE image_tasks SET upstream_task_id=$2,status=$3,response=$4,next_poll_at=now()+interval '10 seconds',lease_until=NULL,updated_at=now() WHERE id=$1",
        [
          task.id,
          upstreamId,
          status === "RUNNING" ? "RUNNING" : "PENDING",
          result.body,
        ],
      );
      await transaction((tx) =>
        addImageEvent(
          tx,
          task.id,
          status === "RUNNING" ? "RUNNING" : "PENDING",
          "百炼已受理图片任务",
        ),
      );
      return;
    }

    const hasImages =
      Array.isArray(result.body?.data) ||
      Array.isArray(result.body?.output?.choices);
    if (hasImages) {
      await db.query(
        "UPDATE image_tasks SET status='SUCCEEDED',response=$2,next_poll_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [task.id, result.body],
      );
      await transaction((tx) =>
        addImageEvent(tx, task.id, "SUCCEEDED", "上游已返回图片结果"),
      );
      return;
    }

    await db.query(
      "UPDATE image_tasks SET status='UNKNOWN',error='上游响应缺少任务编号或图片结果，请联系管理员核实',response=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
      [task.id, result.body],
    );
    await transaction((tx) =>
      addImageEvent(tx, task.id, "UNKNOWN", "上游响应格式无法确认"),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "图片任务提交失败";
    if (submitted) {
      await db.query(
        "UPDATE image_tasks SET status='UNKNOWN',error='提交结果待核实，请勿重复提交',lease_until=NULL,updated_at=now() WHERE id=$1",
        [task.id],
      );
      await transaction((tx) => addImageEvent(tx, task.id, "UNKNOWN", message));
    } else {
      await transaction(async (tx) => {
        const [current] = await tx.query(
          "SELECT * FROM image_tasks WHERE id=$1 FOR UPDATE",
          [task.id],
        );
        await releaseImageTask(tx, current, "FAILED", message);
      });
    }
  }
}

async function claimImagePoll() {
  return transaction(async (tx) => {
    const [task] = await tx.query(
      `SELECT t.*,c.provider,v.encrypted_key,v.workspace,v.base_url
       FROM image_tasks t
       JOIN image_credentials c ON c.id=t.credential_id
       JOIN image_credential_versions v ON v.credential_id=t.credential_id AND v.version=t.credential_version
       WHERE t.status IN ('PENDING','RUNNING') AND COALESCE(t.next_poll_at,now())<=now()
       ORDER BY t.next_poll_at,t.created_at
       LIMIT 1 FOR UPDATE OF t SKIP LOCKED`,
    );
    if (!task) return null;
    await tx.query(
      "UPDATE image_tasks SET next_poll_at=now()+interval '15 seconds',lease_until=now()+interval '1 minute',updated_at=now() WHERE id=$1",
      [task.id],
    );
    return task;
  });
}

export async function pollImageTasks() {
  const task = await claimImagePoll();
  if (!task) return;
  try {
    ensure(task.provider === "qwen", "异步图片任务渠道无效");
    ensure(
      task.base_url || /^[a-zA-Z0-9-]+$/.test(task.workspace || ""),
      "Qwen WorkspaceId 无效",
    );
    const response = await fetch(
      `${apiRoot(task.base_url || bailianHost(task.workspace, "cn-beijing"))}/api/v1/tasks/${encodeURIComponent(task.upstream_task_id)}`,
      {
        headers: { Authorization: `Bearer ${decrypt(task.encrypted_key)}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    const body = await readJsonResponse(response);
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) {
        await db.query(
          "UPDATE image_tasks SET lease_until=NULL,next_poll_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1",
          [task.id],
        );
      } else {
        await db.query(
          "UPDATE image_tasks SET status='UNKNOWN',error='上游任务状态无法查询，请联系管理员核实',lease_until=NULL,next_poll_at=NULL,response=$2,updated_at=now() WHERE id=$1",
          [task.id, body],
        );
        await transaction((tx) =>
          addImageEvent(
            tx,
            task.id,
            "UNKNOWN",
            `任务查询返回 HTTP ${response.status}`,
          ),
        );
      }
      return;
    }
    const status = String(body?.output?.task_status || "").toUpperCase();
    if (["PENDING", "RUNNING"].includes(status)) {
      await db.query(
        "UPDATE image_tasks SET status=$2,response=$3,lease_until=NULL,updated_at=now() WHERE id=$1",
        [task.id, status, body],
      );
      return;
    }
    if (status === "SUCCEEDED") {
      await db.query(
        "UPDATE image_tasks SET status='SUCCEEDED',response=$2,next_poll_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [task.id, body],
      );
      await transaction((tx) =>
        addImageEvent(tx, task.id, "SUCCEEDED", "百炼图片生成完成"),
      );
      return;
    }
    if (status === "FAILED" || status === "CANCELED") {
      await transaction(async (tx) => {
        const [current] = await tx.query(
          "SELECT * FROM image_tasks WHERE id=$1 FOR UPDATE",
          [task.id],
        );
        await releaseImageTask(tx, current, status, upstreamMessage(body));
      });
      return;
    }
    await db.query(
      "UPDATE image_tasks SET status='UNKNOWN',error='上游返回未知任务状态，请联系管理员核实',response=$2,next_poll_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [task.id, body],
    );
    await transaction((tx) =>
      addImageEvent(tx, task.id, "UNKNOWN", `未知上游状态：${status || "空"}`),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "图片任务查询失败";
    await db.query(
      "UPDATE image_tasks SET lease_until=NULL,next_poll_at=now()+interval '30 seconds',error=$2,updated_at=now() WHERE id=$1 AND status IN ('PENDING','RUNNING')",
      [task.id, message],
    );
  }
}

function imageResponseItems(task: Row, response: any) {
  if (
    MODEL_CAPABILITIES[task.model as keyof typeof MODEL_CAPABILITIES]
      .provider === "qwen"
  ) {
    return (response?.output?.choices || []).flatMap((choice: any) =>
      (choice.message?.content || []).filter(
        (item: any) => item.image || item.url,
      ),
    );
  }
  return response?.data || [];
}

async function imageBuffer(
  item: any,
): Promise<{ buffer: Buffer; sourceUrl?: string }> {
  const value = item.b64_json || item.image || item.url || item.image_url?.url;
  ensure(
    typeof value === "string" && value.length,
    "上游结果中没有可读取的图片",
  );
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");
    ensure(comma > 0, "图片 Base64 格式无效");
    return { buffer: Buffer.from(value.slice(comma + 1), "base64") };
  }
  if (/^https?:\/\//i.test(value)) {
    const downloaded = await fetchPublic(value, 100_000_000);
    return { buffer: downloaded.buffer, sourceUrl: downloaded.url };
  }
  return { buffer: Buffer.from(value, "base64") };
}

function deterministicAssetId(taskId: string, index: number) {
  const hex = hash(`${taskId}:image:${index}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function qwenOutputCategory(usage: any, fallback: string) {
  const type = String(usage?.output_image_type || "").toLowerCase();
  if (type.includes("2k")) return "2K";
  if (type.includes("1k")) return "1K";
  return fallback;
}

async function saveOneImageTask(task: Row) {
  const response = jsonValue(task.response);
  const items = imageResponseItems(task, response);
  ensure(items.length > 0, "上游任务完成但没有返回图片");
  const parameters = jsonValue(task.parameters);
  const results: { id: string; category: string }[] = [];
  for (const [index, item] of items.entries()) {
    const decoded = await imageBuffer(item);
    const extension =
      parameters.output_format === "jpeg"
        ? "jpg"
        : parameters.output_format === "webp"
          ? "webp"
          : "png";
    const asset = await saveAsset(
      task.user_id,
      decoded.buffer,
      `image-${task.id}-${index}.${extension}`,
      decoded.sourceUrl,
      undefined,
      deterministicAssetId(task.id, index),
    );
    const metadata = jsonValue(asset.metadata);
    const category =
      MODEL_CAPABILITIES[task.model as keyof typeof MODEL_CAPABILITIES]
        .provider === "qwen"
        ? qwenOutputCategory(
            response.usage,
            getSizeCategory(
              `${metadata.width || 1024}x${metadata.height || 1024}`,
              task.model,
            ),
          )
        : getSizeCategory(
            `${metadata.width || 1024}x${metadata.height || 1024}`,
            task.model,
          );
    results.push({ id: asset.id, category });
  }
  return results;
}

export async function saveImageResults() {
  const tasks = await transaction(async (tx) => {
    const selected = await tx.query(
      "SELECT * FROM image_tasks WHERE status='SUCCEEDED' AND result_assets IS NULL ORDER BY created_at LIMIT 3 FOR UPDATE SKIP LOCKED",
    );
    for (const task of selected) {
      await tx.query(
        "UPDATE image_tasks SET status='SAVING',lease_until=now()+interval '30 minutes',updated_at=now() WHERE id=$1",
        [task.id],
      );
      await addImageEvent(tx, task.id, "SAVING", "正在保存图片结果");
    }
    return selected;
  });

  for (const task of tasks) {
    try {
      const results = await saveOneImageTask(task);
      const response = jsonValue(task.response);
      const usage = jsonValue(response.usage);
      const snapshot = jsonValue(task.price_snapshot);
      const inputPrice = Number(
        snapshot[task.size_category]?.input ?? task.input_unit_micro,
      );
      const fallbackCategory =
        task.parameters?.size === "auto"
          ? task.size_category
          : getSizeCategory(jsonValue(task.parameters).size, task.model);
      const inputCount = Math.max(
        0,
        Number(usage.input_image_count ?? task.input_count) || 0,
      );
      const outputCharge = results.reduce(
        (total, result) =>
          total +
          Number(
            snapshot[result.category]?.output ??
              snapshot[fallbackCategory]?.output ??
              task.output_unit_micro,
          ),
        0,
      );
      const total = charge(inputPrice, inputCount) + outputCharge;

      await transaction(async (tx) => {
        const [current] = await tx.query(
          "SELECT * FROM image_tasks WHERE id=$1 FOR UPDATE",
          [task.id],
        );
        ensure(
          current?.status === "SAVING" && current.settlement === "reserved",
          "图片任务状态已变化",
        );
        ensure(
          total <= Number(current.reserved_micro),
          "实际图片费用超过预占金额，请联系管理员核对",
        );
        await walletEntry(tx, current.user_id, {
          type: "settle",
          amount: Number(current.reserved_micro) - total,
          frozen: -Number(current.reserved_micro),
          key: `image-settle:${current.id}`,
          reason: `图片生成 ${results.length} 张，消费 ${yuan(total)} 元`,
          imageTaskId: current.id,
        });
        await tx.query(
          "UPDATE image_tasks SET status='SUCCEEDED',result_assets=$2,actual_output_count=$3,usage=$4,charged_micro=$5,reserved_micro=0,settlement='charged',next_poll_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
          [
            current.id,
            JSON.stringify(results.map((result) => result.id)),
            results.length,
            usage,
            total,
          ],
        );
        await addImageEvent(
          tx,
          current.id,
          "SUCCEEDED",
          `已保存 ${results.length} 张图片`,
        );
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 600) : "图片保存失败";
      await transaction(async (tx) => {
        const [current] = await tx.query(
          "SELECT * FROM image_tasks WHERE id=$1 FOR UPDATE",
          [task.id],
        );
        if (current?.status === "SAVING")
          await releaseImageTask(
            tx,
            current,
            "DELIVERY_FAILED",
            `图片结果保存失败：${message}`,
          );
      });
    }
  }
}
