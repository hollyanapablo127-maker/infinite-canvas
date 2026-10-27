import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  validateGeneration,
  generationSchema,
  type GenerationInput,
  type MediaMeta,
} from "../shared/wan";
import { getOwnedAsset, importAsset, saveAsset } from "./assets";
import { inputAssetUrl } from "./storage";
import { resolvePublic, fetchPublic } from "./network";
import {
  charge,
  currentPrices,
  publicTask,
  walletEntry,
  releaseTask,
  yuan,
  getWalletReserveAmount,
  settleSubscriptionQuota,
} from "./finance";

import {
  ensureModel,
  refreshModelAdapters,
  modelRoutes,
  userMultiplier,
  discountedPrice,
} from "./catalog";
import { apiRoot, bailianHost } from "../shared/protocols";
import { adapterModel } from "../shared/catalog";

export async function prepareGeneration(
  raw: unknown,
  userId: string,
  options: { deferValidation?: boolean } = {},
) {
  await refreshModelAdapters();
  const input = generationSchema.parse(raw);
  await ensureModel(input.model, "video");
  if (input.mode === "extend")
    ensure(input.parameters.ratio === "adaptive", "视频延长请使用自适应画幅");
  const metadata: MediaMeta[] = [];
  const prepared: Row[] = [];
  for (const m of input.input.media) {
    if (m.url?.startsWith("oss://")) {
      ensure(
        m.url.startsWith("oss://dashscope-instant/") &&
          m.binding &&
          m.binding.model === input.model,
        "临时 OSS 素材必须绑定原模型与上游渠道",
      );
      ensure(
        [
          "first_frame",
          "last_frame",
          "reference_image",
          "reference_video",
          "reference_audio",
          "file",
        ].includes(m.type),
        "临时地址类型无效",
      );
      const [c] = await db.query(
        "SELECT id FROM credentials WHERE id=$1 AND enabled",
        [m.binding.credential_id],
      );
      ensure(c, "临时素材绑定渠道不可用");
      prepared.push({ type: m.type, url: m.url, binding: m.binding });
      metadata.push(undefined as any);
      continue;
    }
    if (m.type === "link") {
      const url = m.asset_id
        ? (await getOwnedAsset(m.asset_id, userId)).source_url
        : m.url;
      ensure(url, "请选择公开网页");
      await resolvePublic(url);
      prepared.push({ type: m.type, url });
      metadata.push({ kind: "link" });
      continue;
    }
    const a = m.asset_id
      ? await getOwnedAsset(m.asset_id, userId)
      : await importAsset(userId, m.url!);
    m.asset_id = a.id;
    delete m.url;
    prepared.push({ type: m.type, asset_id: a.id });
    metadata.push({ ...a.metadata, kind: a.kind, size: Number(a.size) });
  }
  const check = options.deferValidation
    ? null
    : validateGeneration(input, metadata);
  if (input.project_id)
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
  const prices = await currentPrices();
  const basePrice = prices.find(
    (p) =>
      p.model === input.model && p.resolution === input.parameters.resolution,
  );
  ensure(basePrice?.enabled, "模型规格暂不可用", 503);
  const multiplier = await userMultiplier(userId);
  const p: Row = {
    ...basePrice,
    base_sale_micro: Number(basePrice.sale_micro),
    sale_micro: discountedPrice(basePrice.sale_micro, multiplier),
  };
  // Opaque provider temporary URLs cannot be probed. Reserve the documented maximum.
  const uncertain = prepared.some((m) => m.url?.startsWith("oss://"));
  const seconds =
    uncertain || options.deferValidation ? 30 : check!.estimatedDuration;
  return {
    input,
    prepared,
    inputDuration: check?.inputDuration ?? 0,
    seconds,
    price: p,
    multiplier,
    baseReserve: charge(basePrice.sale_micro, seconds),
    reserve: charge(p.sale_micro, seconds),
    uncertain,
  };
}
export const generationRouter = Router();

async function reserveSubscriptionQuota(
  tx: any,
  userId: string,
  amount: number,
) {
  const [subscription] = await tx.query(
    "SELECT * FROM subscriptions WHERE user_id=$1 AND status='active' AND starts_at<=now() AND ends_at>now() ORDER BY ends_at DESC LIMIT 1 FOR UPDATE",
    [userId],
  );
  if (!subscription || amount <= 0)
    return { credit: 0, wallet: amount, allocations: [] as Row[] };
  const quotas = [
    ["day", Number(subscription.daily_quota_micro || 0)],
    ["week", Number(subscription.weekly_quota_micro || 0)],
    ["month", Number(subscription.monthly_quota_micro || 0)],
  ] as const;
  let remaining = amount;
  const allocations: Row[] = [];
  for (const [periodType, limit] of quotas) {
    if (remaining <= 0 || limit <= 0) continue;
    const [{ period_start }] = await tx.query(
      `SELECT (date_trunc('${periodType}', now() AT TIME ZONE 'Asia/Shanghai'))::date AS period_start`,
    );
    await tx.query(
      "INSERT INTO subscription_usage(subscription_id,period_type,period_start) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [subscription.id, periodType, period_start],
    );
    const [usage] = await tx.query(
      "SELECT * FROM subscription_usage WHERE subscription_id=$1 AND period_type=$2 AND period_start=$3 FOR UPDATE",
      [subscription.id, periodType, period_start],
    );
    const available = Math.max(
      0,
      limit -
        Number(usage?.used_micro || 0) -
        Number(usage?.reserved_micro || 0),
    );
    const take = Math.min(remaining, available);
    if (take <= 0) continue;
    await tx.query(
      "UPDATE subscription_usage SET reserved_micro=reserved_micro+$4,updated_at=now() WHERE subscription_id=$1 AND period_type=$2 AND period_start=$3",
      [subscription.id, periodType, period_start, take],
    );
    allocations.push({
      subscription_id: subscription.id,
      period_type: periodType,
      period_start,
      amount: take,
    });
    remaining -= take;
  }
  const credit = amount - remaining;
  return { credit, wallet: remaining, allocations };
}
export const quoteRouter = Router();
quoteRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const s = await settings();
    ensure(!s.maintenance, "系统维护中，暂不接受新任务", 503);
    const q = await prepareGeneration(req.body, req.user.id);
    if (req.apiKey)
      ensure(
        apiKeyAllowsModel(req.apiKey, q.input.model),
        "此密钥不可调用该模型",
        403,
      );
    const payload = Buffer.from(
      JSON.stringify({
        user: req.user.id,
        body: hash(JSON.stringify(q.input)),
        price: q.price.id,
        priceVersion: q.price.version,
        multiplier: q.multiplier,
        expires: Date.now() + 300000,
        reserve: q.reserve,
      }),
    ).toString("base64url");
    res.json({
      token: `${payload}.${sign(payload)}`,
      input: q.input,
      unitPrice: yuan(q.price.sale_micro),
      officialPrice: yuan(q.price.official_micro),
      inputDuration: q.inputDuration,
      estimatedSeconds: q.seconds,
      reserved: yuan(q.reserve),
      intelligent: q.input.parameters.duration === -1 || q.uncertain,
      expiresAt: Date.now() + 300000,
    });
  }),
);
export async function submitGeneration(
  user: Row,
  key: Row | undefined,
  raw: unknown,
  quoteToken: string,
  idempotency: string,
  workflowId?: string,
) {
  await refreshModelAdapters();
  const input = generationSchema.parse(raw);
  const bodyHash = hash(JSON.stringify(input));
  ensure(
    idempotency.length >= 8 && idempotency.length <= 128,
    "请提供有效的 Idempotency-Key",
  );
  const [prior] = await db.query(
    "SELECT * FROM tasks WHERE user_id=$1 AND idempotency_key=$2",
    [user.id, idempotency],
  );
  if (prior) {
    ensure(prior.request_hash === bodyHash, "同一幂等键不能提交不同内容", 409);
    return prior;
  }
  const [payload, sig] = quoteToken.split(".");
  ensure(payload && sig && sign(payload) === sig, "报价无效，请重新获取");
  const quote = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  ensure(
    quote.user === user.id &&
      quote.body === bodyHash &&
      quote.expires > Date.now(),
    "报价已过期或参数已修改",
  );
  const q = await prepareGeneration(input, user.id);
  ensure(
    q.price.id === quote.price &&
      q.price.version === quote.priceVersion &&
      q.reserve === quote.reserve &&
      q.multiplier === Number(quote.multiplier ?? 1),
    "价格或素材发生变化，请重新获取报价",
  );
  const boundIds = q.prepared
    .filter((m) => m.binding)
    .map((m) => m.binding.credential_id);
  ensure(new Set(boundIds).size <= 1, "临时 OSS 素材必须属于同一上游渠道");
  return transaction(async (tx) => {
    ensure(
      (await userMultiplier(user.id, tx, true)) === q.multiplier,
      "专属倍率已变化，请重新获取报价",
    );
    const catalogEntry = await ensureModel(
      input.model,
      "video",
      tx,
      false,
      true,
    );
    const [livePrice] = await tx.query(
      "SELECT version FROM prices WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
      [q.price.id],
    );
    ensure(
      livePrice?.version === q.price.version,
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
      "SELECT * FROM tasks WHERE user_id=$1 AND idempotency_key=$2",
      [user.id, idempotency],
    );
    if (duplicate) {
      ensure(duplicate.request_hash === bodyHash, "幂等键冲突", 409);
      return duplicate;
    }
    const s = (await tx.query("SELECT value FROM settings WHERE id=1"))[0]
      .value;
    ensure(!s.maintenance, "系统维护中", 503);
    const [{ size }] = await tx.query(
      "SELECT COALESCE(sum(size),0) AS size FROM assets WHERE user_id=$1 AND purged_at IS NULL",
      [user.id],
    );
    const [{ pending }] = await tx.query(
      "SELECT count(*)::int AS pending FROM tasks WHERE user_id=$1 AND result_asset_id IS NULL AND (settlement='reserved' OR status='SAVING')",
      [user.id],
    );
    ensure(
      Number(size) + (pending + 1) * 300_000_000 <=
        Number(s.storageLimitGB) * 1_000_000_000,
      "存储空间不足：每个生成任务需要预留 300MB 结果空间",
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
      ]) {
        const [{ used }] = await tx.query(
          `SELECT COALESCE(sum(CASE WHEN settlement='reserved' THEN reserve_micro ELSE charged_micro-refunded_micro END),0) AS used FROM tasks WHERE api_key_id=$1 AND created_at>=date_trunc('${period}',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
          [key.id],
        );
        ensure(
          Number(used) + q.reserve <= Number(limit),
          `密钥${period === "day" ? "日" : "月"}额度不足`,
        );
      }
    }
    const routes = await modelRoutes(input.model, "video", tx);
    const candidates = await tx.query(
      "SELECT * FROM credentials WHERE enabled ORDER BY priority DESC,created_at,id FOR UPDATE",
    );
    let channel: Row | undefined;
    for (const c of candidates) {
      if (
        (routes.length || catalogEntry.routing_configured
          ? !routes.some((route) => route.channel_id === c.id)
          : !c.models.includes(adapterModel(input.model))) ||
        (boundIds.length && c.id !== boundIds[0])
      )
        continue;
      const [{ used }] = await tx.query(
        "SELECT COALESCE(sum(cost_micro+CASE WHEN settlement='reserved' THEN round(CASE WHEN base_reserve_micro>0 THEN base_reserve_micro ELSE reserve_micro END*multiplier) ELSE 0 END),0) AS used FROM tasks WHERE credential_id=$1",
        [c.id],
      );
      if (
        Number(c.budget_micro) > 0 &&
        Number(used) + charge(q.baseReserve, c.multiplier) >
          Number(c.budget_micro)
      )
        continue;
      channel = c;
      break;
    }
    ensure(channel, "暂无可用的北京模型渠道，请联系管理员", 503);
    const quota = await reserveSubscriptionQuota(tx, user.id, q.reserve);
    const id = randomUUID();
    const [task] = await tx.query(
      "INSERT INTO tasks(id,user_id,api_key_id,source,project_id,node_id,input,prepared_media,model,resolution,mode,price_id,price_micro,official_micro,reserve_micro,wallet_reserve_micro,subscription_reserve_micro,subscription_allocations,idempotency_key,request_hash,credential_id,credential_version,account_group,multiplier,base_price_micro,base_reserve_micro,discount_multiplier,upstream_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING *",
      [
        id,
        user.id,
        key?.id || null,
        key ? "api" : "web",
        input.project_id || null,
        input.node_id || null,
        JSON.stringify(q.input),
        JSON.stringify(q.prepared),
        input.model,
        input.parameters.resolution,
        input.mode,
        q.price.id,
        q.price.sale_micro,
        q.price.official_micro,
        q.reserve,
        quota.wallet,
        quota.credit,
        JSON.stringify(quota.allocations),
        idempotency,
        bodyHash,
        channel.id,
        channel.version,
        channel.account_group,
        channel.multiplier,
        q.price.base_sale_micro,
        q.baseReserve,
        q.multiplier,
        routes.find((route) => route.channel_id === channel!.id)
          ?.upstream_model || adapterModel(input.model),
      ],
    );
    if (quota.wallet > 0)
      await walletEntry(tx, user.id, {
        type: "reserve",
        amount: -quota.wallet,
        frozen: quota.wallet,
        key: `reserve:${id}`,
        taskId: id,
        reason:
          quota.credit > 0
            ? "生成任务预算冻结（超出套餐额度部分）"
            : "生成任务预算冻结",
      });
    await tx.query(
      "INSERT INTO task_events(id,task_id,status,message) VALUES($1,$2,$3,$4)",
      [randomUUID(), id, "QUEUED", "任务已进入队列"],
    );
    return task;
  });
}
generationRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const token = z.string().parse(req.body.quoteToken);
    const task = await submitGeneration(
      req.user,
      req.apiKey,
      req.body.input,
      token,
      String(req.headers["idempotency-key"] || ""),
    );
    res.status(202).json(publicTask(task));
  }),
);
generationRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await db.query(
      "SELECT * FROM tasks WHERE user_id=$1 AND ($4::uuid IS NULL OR project_id=$4) ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [
        req.user.id,
        limit,
        offset,
        req.query.project_id
          ? z.string().uuid().parse(req.query.project_id)
          : null,
      ],
    );
    res.json(rows.map(publicTask));
  }),
);
generationRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const [t] = await db.query(
      "SELECT * FROM tasks WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(t, "任务不存在", 404);
    res.json({
      ...publicTask(t),
      events: await db.query(
        "SELECT status,message,created_at FROM task_events WHERE task_id=$1 ORDER BY created_at",
        [t.id],
      ),
    });
  }),
);
generationRouter.post(
  "/:id/cancel",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [t] = await tx.query(
        "SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [req.params.id, req.user.id],
      );
      ensure(t, "任务不存在", 404);
      if (t.status === "QUEUED")
        await releaseTask(tx, t, "CANCELED", "任务已取消");
      else {
        ensure(t.status === "PENDING", "只有等待中的任务可取消");
        await tx.query(
          "UPDATE tasks SET status='CANCELING',next_poll=now(),updated_at=now() WHERE id=$1",
          [t.id],
        );
      }
    });
    res.json({ ok: true });
  }),
);

export async function providerRequest(
  task: Row,
  pathSuffix: string,
  body?: unknown,
) {
  const [v] = await db.query(
    "SELECT * FROM credential_versions WHERE credential_id=$1 AND version=$2",
    [task.credential_id, task.credential_version],
  );
  ensure(v, "上游凭证版本不可用");
  ensure(v.base_url || /^[a-zA-Z0-9-]+$/.test(v.workspace), "业务空间无效");
  const url = `${apiRoot(v.base_url || bailianHost(v.workspace, "cn-beijing"))}/api/v1/${pathSuffix}`;
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${decrypt(v.secret)}`,
      ...(pathSuffix.startsWith("services/")
        ? { "X-DashScope-Async": "enable" }
        : {}),
      ...(task.prepared_media.some((m: any) => m.url?.startsWith("oss://"))
        ? { "X-DashScope-OssResourceResolve": "enable" }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = (await response.json()) as any;
  return { status: response.status, ok: response.ok, data };
}
export async function dispatchOne() {
  const chosen = await transaction(async (tx) => {
    const s = (await tx.query("SELECT value FROM settings WHERE id=1"))[0]
      .value;
    if (s.maintenance) return null;
    const rows = await tx.query(
      "SELECT t.*,c.concurrency,c.rps,c.enabled AS channel_enabled FROM tasks t JOIN credentials c ON c.id=t.credential_id JOIN users u ON u.id=t.user_id WHERE t.status='QUEUED' AND c.enabled AND NOT u.disabled AND (SELECT count(*) FROM tasks a WHERE a.account_group=t.account_group AND a.model=t.model AND a.status IN ('SUBMITTING','PENDING','RUNNING','CANCELING','UNKNOWN'))<LEAST(5,c.concurrency) AND (SELECT count(*) FROM tasks b WHERE b.user_id=t.user_id AND b.status IN ('SUBMITTING','PENDING','RUNNING','CANCELING','UNKNOWN'))<$1 ORDER BY t.created_at LIMIT 1 FOR UPDATE OF t SKIP LOCKED",
      [s.concurrentPerUser],
    );
    for (const t of rows) {
      if (!t.channel_enabled) continue;
      const [{ count: accountCount }] = await tx.query(
        "SELECT count(*)::int AS count FROM tasks WHERE account_group=$1 AND model=$2 AND status IN ('SUBMITTING','PENDING','RUNNING','CANCELING')",
        [t.account_group, t.model],
      );
      const [{ count: userCount }] = await tx.query(
        "SELECT count(*)::int AS count FROM tasks WHERE user_id=$1 AND status IN ('SUBMITTING','PENDING','RUNNING','CANCELING')",
        [t.user_id],
      );
      if (
        accountCount >= Math.min(5, t.concurrency) ||
        userCount >= s.concurrentPerUser
      )
        continue;
      await tx.query(
        "UPDATE tasks SET status='SUBMITTING',lease_until=now()+interval '3 minutes',updated_at=now() WHERE id=$1",
        [t.id],
      );
      return t;
    }
    return null;
  });
  if (!chosen) return;
  let submitted = false;
  try {
    const media = [];
    for (const m of chosen.prepared_media) {
      media.push({
        type: m.type,
        url: m.asset_id
          ? await inputAssetUrl(await getOwnedAsset(m.asset_id, chosen.user_id))
          : m.url,
      });
    }
    const body = {
      model: chosen.upstream_model || chosen.model,
      input: {
        ...(chosen.input.input.prompt
          ? { prompt: chosen.input.input.prompt }
          : {}),
        ...(media.length ? { media } : {}),
      },
      parameters: chosen.input.parameters,
    };
    submitted = true;
    const result = await providerRequest(
      chosen,
      "services/aigc/video-generation/video-synthesis",
      body,
    );
    if (result.ok && result.data.output?.task_id) {
      await db.query(
        "UPDATE tasks SET upstream_id=$2,request_id=$3,status=$4,provider_response=$5,next_poll=now()+interval '15 seconds',lease_until=NULL,updated_at=now() WHERE id=$1",
        [
          chosen.id,
          result.data.output.task_id,
          result.data.request_id || null,
          "PENDING",
          JSON.stringify(result.data),
        ],
      );
    } else if (result.status >= 400 && result.status < 500) {
      await transaction(async (tx) => {
        const [t] = await tx.query(
          "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
          [chosen.id],
        );
        await releaseTask(
          tx,
          t,
          "FAILED",
          result.status === 429
            ? "上游调用繁忙，请稍后重新提交"
            : "上游未接受请求，请检查素材或联系管理员",
        );
        await tx.query(
          "UPDATE tasks SET provider_response=$2,internal_error=$3 WHERE id=$1",
          [
            t.id,
            JSON.stringify(result.data),
            String(result.data.message || result.data.code || ""),
          ],
        );
      });
    } else
      await db.query(
        "UPDATE tasks SET status='UNKNOWN',error='提交结果待核实，请勿重复提交',provider_response=$2,updated_at=now() WHERE id=$1",
        [chosen.id, JSON.stringify(result.data)],
      );
  } catch (error) {
    if (submitted)
      await db.query(
        "UPDATE tasks SET status='UNKNOWN',error='提交结果待核实，请勿重复提交',internal_error=$2,updated_at=now() WHERE id=$1",
        [chosen.id, String(error)],
      );
    else
      await transaction(async (tx) => {
        const [t] = await tx.query(
          "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
          [chosen.id],
        );
        await releaseTask(
          tx,
          t,
          "FAILED",
          error instanceof Error ? error.message : "素材准备失败",
        );
      });
  }
}
export async function settleSuccess(id: string, data: any) {
  await transaction(async (tx) => {
    const [t] = await tx.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [
      id,
    ]);
    if (!t || t.settlement !== "reserved") return;
    if (t.upstream_id)
      ensure(
        data.output?.task_id === t.upstream_id,
        "上游结果与当前任务绑定不一致",
        409,
      );
    await tx.query(
      "UPDATE tasks SET result_received_at=COALESCE(result_received_at,now()) WHERE id=$1",
      [id],
    );
    const u = data.usage;
    const valid =
      u &&
      u.video_count === 1 &&
      [u.duration, u.input_video_duration, u.output_video_duration].every(
        (x: any) => typeof x === "number" && Number.isFinite(x) && x >= 0,
      ) &&
      u.output_video_duration > 0 &&
      Math.abs(u.duration - u.input_video_duration - u.output_video_duration) <
        0.02 &&
      u.duration <= 30.1 &&
      String(u.SR) === t.resolution.replace("P", "");
    const cost = valid ? charge(t.price_micro, u.duration) : 0;
    if (!valid || cost > Number(t.reserve_micro)) {
      await tx.query(
        "UPDATE tasks SET status='RECONCILE',error='实际用量需要核对，暂未结算',usage=$2,provider_response=$3,result_url=$4,storage_status='pending',updated_at=now() WHERE id=$1",
        [
          id,
          JSON.stringify(u || {}),
          JSON.stringify(data),
          data.output?.video_url || null,
        ],
      );
      return;
    }
    const subscriptionCredit = Math.min(
      cost,
      Number(t.subscription_reserve_micro || 0),
    );
    await settleSubscriptionQuota(tx, t, subscriptionCredit);
    const walletBudget = getWalletReserveAmount(t);
    const walletCost = cost - subscriptionCredit;
    if (walletBudget > 0)
      await walletEntry(tx, t.user_id, {
        type: "settle",
        amount: walletBudget - walletCost,
        frozen: -walletBudget,
        key: `settle:${id}`,
        taskId: id,
        reason:
          subscriptionCredit > 0
            ? `生成完成，套餐额度抵扣 ${yuan(subscriptionCredit)} 元，钱包消费 ${yuan(walletCost)} 元`
            : `生成完成，消费 ${yuan(cost)} 元`,
      });
    await tx.query(
      "UPDATE tasks SET status=CASE WHEN result_asset_id IS NOT NULL THEN 'SUCCEEDED' WHEN storage_status='expired' THEN 'DELIVERY_FAILED' ELSE 'SAVING' END,settlement='charged',charged_micro=$2,cost_micro=$3,usage=$4,provider_response=$5,result_url=$6,completed_at=now(),updated_at=now(),next_poll=now() WHERE id=$1",
      [
        id,
        cost,
        charge(
          charge(Number(t.base_price_micro) || t.price_micro, u.duration),
          t.multiplier,
        ),
        JSON.stringify(u),
        JSON.stringify(data),
        data.output.video_url,
      ],
    );
  });
}
export async function pollTasks() {
  const tasks = await db.query(
    "SELECT * FROM tasks WHERE status IN ('PENDING','RUNNING','CANCELING') AND next_poll<=now() ORDER BY next_poll LIMIT 10",
  );
  for (const t of tasks) {
    try {
      if (t.status === "CANCELING") {
        const cancel = await providerRequest(
          t,
          `tasks/${encodeURIComponent(t.upstream_id)}/cancel`,
          {},
        );
        if (!cancel.ok)
          await db.query("UPDATE tasks SET status='PENDING' WHERE id=$1", [
            t.id,
          ]);
      }
      const result = await providerRequest(
        t,
        `tasks/${encodeURIComponent(t.upstream_id)}`,
      );
      if (!result.ok) throw new Error("任务查询暂不可用");
      const status = result.data.output?.task_status;
      ensure(
        result.data.output?.task_id === t.upstream_id,
        "上游任务标识不一致",
      );
      if (status === "SUCCEEDED") await settleSuccess(t.id, result.data);
      else if (["FAILED", "CANCELED"].includes(status))
        await transaction(async (tx) => {
          const [fresh] = await tx.query(
            "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
            [t.id],
          );
          await releaseTask(
            tx,
            fresh,
            status,
            status === "CANCELED" ? "任务已取消" : "生成失败，冻结金额已退回",
          );
          await tx.query(
            "UPDATE tasks SET provider_response=$2,internal_error=$3 WHERE id=$1",
            [
              t.id,
              JSON.stringify(result.data),
              result.data.output.message || null,
            ],
          );
        });
      else if (["PENDING", "RUNNING", "UNKNOWN"].includes(status))
        await db.query(
          "UPDATE tasks SET status=$2,provider_response=$3,error=$4,next_poll=now()+interval '15 seconds',updated_at=now() WHERE id=$1",
          [
            t.id,
            status,
            JSON.stringify(result.data),
            status === "UNKNOWN" ? "任务状态待核实，请联系管理员" : null,
          ],
        );
      else throw new Error("未知上游状态");
      if (status !== t.status)
        await db.query(
          "INSERT INTO task_events(id,task_id,status,message) VALUES($1,$2,$3,$4)",
          [randomUUID(), t.id, status, `任务状态更新：${status}`],
        );
    } catch (error) {
      await db.query(
        "UPDATE tasks SET attempts=attempts+1,next_poll=now()+interval '60 seconds',internal_error=$2,updated_at=now() WHERE id=$1",
        [t.id, String(error)],
      );
    }
  }
}
export async function saveResults() {
  const tasks = await db.query(
    "SELECT * FROM tasks WHERE status IN ('SAVING','RECONCILE') AND storage_status<>'expired' AND result_url IS NOT NULL AND result_asset_id IS NULL AND next_poll<=now() ORDER BY next_poll LIMIT 2",
  );
  for (const t of tasks) {
    try {
      const [existing] = await db.query(
        "SELECT * FROM assets WHERE id=$1 AND user_id=$2 AND purged_at IS NULL AND expires_at>now()",
        [t.id, t.user_id],
      );
      if (
        !existing &&
        t.result_received_at &&
        Date.now() - new Date(t.result_received_at).getTime() > 24 * 3600000
      ) {
        await db.query(
          "UPDATE tasks SET status=CASE WHEN settlement='charged' THEN 'DELIVERY_FAILED' ELSE 'RECONCILE' END,storage_status='expired',error='上游结果已超过保存期限，请联系管理员核实账务',updated_at=now() WHERE id=$1",
          [t.id],
        );
        continue;
      }
      const asset =
        existing ||
        (await saveAsset(
          t.user_id,
          (await fetchPublic(t.result_url, 300_000_000)).buffer,
          `Wan-${t.id.slice(0, 8)}.mp4`,
          undefined,
          undefined,
          t.id,
        ));
      await db.query(
        "UPDATE tasks SET result_asset_id=$2,storage_status='saved',status=CASE WHEN settlement='charged' THEN 'SUCCEEDED' ELSE status END,error=CASE WHEN settlement='charged' THEN NULL ELSE error END,updated_at=now() WHERE id=$1",
        [t.id, asset.id],
      );
      await db.query(
        "INSERT INTO notifications(id,user_id,title,body,resource_id,unique_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          t.user_id,
          "视频已完成",
          "视频已保存至资产库，保留 30 天",
          t.id,
          `task:${t.id}:success`,
        ],
      );
    } catch (error) {
      await db.query(
        "UPDATE tasks SET storage_status='retrying',error='视频已生成，保存重试中',internal_error=$2,attempts=attempts+1,next_poll=now()+interval '2 minutes',updated_at=now() WHERE id=$1",
        [t.id, String(error)],
      );
      await db.query(
        "INSERT INTO notifications(id,user_id,title,body,resource_id,unique_key) SELECT gen_random_uuid(),id,'结果保存异常','请检查存储配置与空间；上游结果仅保留 24 小时',$1,'storage:'||$1||':'||id FROM users WHERE role='admin' OR id=$2 ON CONFLICT DO NOTHING",
        [t.id, t.user_id],
      );
    }
  }
}
