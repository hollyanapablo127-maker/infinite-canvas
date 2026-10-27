import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction, settings, type Row, type Queryable } from "./db";
import { asyncRoute, ensure, hash, sign, decrypt, rateLimit } from "./security";
import { micro, yuan, charge, audit, walletEntry } from "./finance";
import { ensureModel, userMultiplier, discountedPrice } from "./catalog";
import {
  PROTOCOLS,
  apiRoot,
  chatBase,
  type ProtocolId,
} from "../shared/protocols";
import { modelIdSchema } from "../shared/catalog";
import { fetchPublic, resolvePublic } from "./network";
import { getOwnedAsset } from "./assets";
import { inputAssetUrl, putObject, readObject, deleteObject } from "./storage";
import { config } from "./config";

const inputSchema = z.object({
  model: modelIdSchema,
  prompt: z.string().max(16000).default(""),
  references: z
    .array(
      z
        .object({
          asset_id: z.string().uuid().optional(),
          kind: z.enum(["image", "audio", "video"]).optional(),
          url: z.string().url().max(2000).optional(),
        })
        .refine((r) => !!r.asset_id !== !!r.url, "素材只能指定一个资产或URL"),
    )
    .max(4)
    .default([]),
  parameters: z.record(z.unknown()).default({}),
  project_id: z.string().uuid().optional(),
  node_id: z.string().max(100).optional(),
});
const genericProtocols = [
  "openai-chat",
  "bailian-multimodal",
  "bailian-tts",
  "bailian-audio",
  "bailian-asr",
  "bailian-asr-chat",
  "bailian-omni",
  "bailian-3d",
  "happyoyster",
  "bailian-realtime",
  "bailian-inference",
  "bailian-video",
];
const json = (value: any, fallback: any = {}) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
export function publicCapability(job: Row) {
  return {
    id: job.id,
    model: job.model,
    protocol: job.protocol,
    status: job.status,
    project_id: job.project_id,
    node_id: job.node_id,
    prompt: job.input?.prompt,
    parameters: job.parameters,
    output: job.output,
    usage: job.usage,
    error: job.error,
    reserved: yuan(job.reserved_micro),
    charged: yuan(job.charged_micro),
    settlement: job.settlement,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}
export async function capabilityConnection(job: Row, tx: Queryable = db) {
  const [channel] = await tx.query(
    "SELECT v.*,c.provider,c.workspace FROM provider_channel_versions v JOIN provider_channels c ON c.id=v.channel_id WHERE v.channel_id=$1 AND v.version=$2",
    [job.channel_id, job.channel_version],
  );
  ensure(channel, "渠道凭据快照不存在", 503);
  return {
    ...channel,
    key: decrypt(channel.encrypted_key),
    root: apiRoot(channel.base_url),
  };
}
export async function bailianJson(
  conn: Row,
  path: string,
  body?: Row,
  async = false,
  method?: string,
) {
  const response = await fetch(`${conn.root}${path}`, {
    method: method || (body ? "POST" : "GET"),
    redirect: "error",
    headers: {
      Authorization: `Bearer ${conn.key}`,
      "Content-Type": "application/json",
      ...(async ? { "X-DashScope-Async": "enable" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  ensure(text.length < 5_000_000, "上游响应过大");
  let data: Row;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`上游返回非JSON响应（${response.status}）`);
  }
  if (
    !response.ok ||
    (data.code && ![0, 200, "0", "200"].includes(data.code))
  ) {
    const error = new Error(
      `百炼请求失败（${String(data.code || response.status).slice(0, 80)}）：${String(data.message || "请检查地域、模型授权和参数").slice(0, 250)}`,
    ) as any;
    error.explicit = response.status < 500;
    throw error;
  }
  return data;
}
export async function settleCapability(
  id: string,
  total: number,
  status = "SUCCEEDED",
  output: Row = {},
  usage: Row = {},
  message?: string,
  allowedStates?: string[],
) {
  return transaction(async (tx) => {
    const [job] = await tx.query(
      "SELECT * FROM capability_jobs WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!job || job.settlement !== "reserved") return job;
    if (allowedStates)
      ensure(
        allowedStates.includes(job.status),
        "任务已开始提交，不能再取消，请等待上游结果",
        409,
      );
    ensure(total >= 0 && Number.isSafeInteger(total), "费用无效");
    if (total > Number(job.reserved_micro)) {
      await tx.query(
        "UPDATE capability_jobs SET status='RECONCILE',output=$2,usage=$3,error='实际用量超过预算，需要管理员核对',updated_at=now() WHERE id=$1",
        [id, output, usage],
      );
      return job;
    }
    if (Number(job.reserved_micro) > 0)
      await walletEntry(tx, job.user_id, {
        type:
          status === "FAILED" || status === "CANCELED" ? "release" : "settle",
        amount: Number(job.reserved_micro) - total,
        frozen: -Number(job.reserved_micro),
        key: `capability-settle:${id}`,
        reason: `${job.model} ${status === "FAILED" || status === "CANCELED" ? "取消或失败退还预算" : `消费 ${yuan(total)} 元`}`,
      });
    await tx.query(
      "UPDATE ledger SET capability_job_id=$2 WHERE business_key=$1",
      [`capability-settle:${id}`, id],
    );
    return (
      await tx.query(
        "UPDATE capability_jobs SET status=$2,settlement=$3,charged_micro=$4,reserved_micro=0,output=$5,usage=$6,error=$7,completed_at=now(),updated_at=now(),lease_until=NULL,next_poll_at=NULL WHERE id=$1 RETURNING *",
        [
          id,
          status,
          status === "FAILED" || status === "CANCELED" ? "released" : "charged",
          total,
          output,
          usage,
          message || null,
        ],
      )
    )[0];
  });
}
export function capabilityCost(job: Row, usage: Row, output: Row = {}) {
  const p = job.price_snapshot;
  let quantity = 1;
  if (p.unit === "million_characters")
    quantity = String(job.input.prompt || "").length / 1_000_000;
  if (p.unit === "second")
    quantity = Number(
      usage.duration ??
        usage.seconds ??
        usage.audio_duration ??
        output.duration ??
        (job.input.references || []).find((ref: Row) => ref.kind === "audio")
          ?.metadata?.duration ??
        job.parameters.duration ??
        job.parameters.max_seconds ??
        p.quantity,
    );
  if (p.unit === "million_tokens")
    return (
      charge(
        p.input,
        Number(usage.input_tokens ?? usage.prompt_tokens ?? p.input_tokens) /
          1_000_000,
      ) +
      charge(
        p.output,
        Number(usage.output_tokens ?? usage.completion_tokens ?? 2048) /
          1_000_000,
      )
    );
  ensure(Number.isFinite(quantity) && quantity >= 0, "上游用量无效");
  return charge(p.output || p.input, quantity);
}
async function prepare(raw: unknown, userId: string) {
  const b = inputSchema.parse(raw);
  const [model] = await db.query(
    "SELECT * FROM model_catalog WHERE model=$1 AND enabled AND deleted_at IS NULL",
    [b.model],
  );
  ensure(model, "模型不可用", 503);
  const protocol = model.protocol as ProtocolId;
  ensure(
    genericProtocols.includes(protocol),
    "此模型请使用专属的图片或视频生成节点",
  );
  const params = b.parameters;
  const allowedParams = new Set([
    "max_seconds",
    "duration",
    "resolution",
    "ratio",
    "voice",
    "language_type",
    "format",
    "sample_rate",
    "texture_quality",
    "geometry_quality",
    "pbr",
    "texture",
    "enable_itn",
    "perspective",
    "aspectRatio",
    "mode",
    "seed",
    "watermark",
    "prompt_extend",
  ]);
  ensure(
    Object.keys(params).every((k) => allowedParams.has(k)),
    "包含不支持的模型参数",
  );
  if (params.duration !== undefined)
    ensure(
      typeof params.duration === "number" &&
        params.duration >= 2 &&
        params.duration <= 30,
      "视频时长应在2–30秒之间",
    );
  if (params.max_seconds !== undefined)
    ensure(
      typeof params.max_seconds === "number" &&
        params.max_seconds >= 1 &&
        params.max_seconds <= 3600,
      "预算时长应在1–3600秒之间",
    );
  if (params.sample_rate !== undefined)
    ensure(
      [8000, 16000, 24000, 44100, 48000].includes(Number(params.sample_rate)),
      "采样率无效",
    );
  if (params.format !== undefined)
    ensure(
      ["wav", "mp3", "pcm"].includes(String(params.format)),
      "音频格式无效",
    );
  const refs: Row[] = [];
  for (const ref of b.references) {
    if (ref.asset_id) {
      const a = await getOwnedAsset(ref.asset_id, userId);
      refs.push({
        url: await inputAssetUrl(a),
        kind: a.kind,
        asset_id: a.id,
        metadata: a.metadata,
        size: Number(a.size),
      });
    } else {
      await resolvePublic(ref.url!);
      const ext = new URL(ref.url!).pathname.toLowerCase();
      const kind =
        ref.kind ||
        (["bailian-asr", "bailian-asr-chat"].includes(protocol) ||
        /\.(wav|mp3|m4a|flac|ogg|aac)$/.test(ext)
          ? "audio"
          : /\.(mp4|mov|webm)$/.test(ext)
            ? "video"
            : "image");
      refs.push({ url: ref.url, kind });
    }
  }
  if (["bailian-asr", "bailian-asr-chat"].includes(protocol))
    ensure(
      refs.length === 1 && (!refs[0].kind || refs[0].kind === "audio"),
      "语音识别需要一份音频素材",
    );
  if (protocol === "bailian-audio")
    ensure(refs.length <= 3, "音频生成最多支持3条参考音频");
  if (protocol === "bailian-3d") {
    ensure(refs.length || b.prompt.trim(), "请输入3D描述或参考图片");
    ensure(
      refs.every((r) => !r.kind || r.kind === "image"),
      "3D参考素材必须是图片",
    );
    ensure(
      refs.every(
        (r) =>
          !r.metadata?.mime ||
          ["image/jpeg", "image/png"].includes(r.metadata.mime),
      ),
      "Tripo参考图只支持JPEG或PNG",
    );
    ensure(b.prompt.length <= 1024, "3D描述不能超过1024字符");
  }
  if (protocol === "happyoyster") {
    ensure(
      params.max_seconds === undefined ||
        [60, 90, 120].includes(Number(params.max_seconds)),
      "世界体验时长只能是60、90或120秒",
    );
    if (refs[0]?.metadata?.width) {
      const ratio =
        Number(refs[0].metadata.width) / Number(refs[0].metadata.height);
      ensure(refs[0].size < 6_000_000, "世界首帧图片应小于6MB");
    }
    const worldLinks = await db.query(
      "SELECT upstream_model FROM model_channels WHERE model=$1",
      [model.model],
    );
    if (
      worldLinks.some((r) => r.upstream_model.includes("adventure")) ||
      model.model.includes("adventure")
    ) {
      ensure(refs.length === 1, "世界探索需要一张首帧图");
      if (refs[0]?.metadata?.width) {
        const ratio =
          Number(refs[0].metadata.width) / Number(refs[0].metadata.height);
        ensure(ratio >= 1.5 && ratio <= 2, "世界探索首帧需要宽高比1.5–2的横图");
      }
    }
  }
  if (protocol === "bailian-tts")
    ensure(
      b.prompt.length > 0 && b.prompt.length <= 600,
      "语音合成需要1–600个字符",
    );
  if (protocol === "bailian-video") {
    ensure(b.prompt.trim() || refs.length, "请输入视频描述或参考素材");
    ensure(refs.length <= 2, "此视频协议最多接受首帧与尾帧两张参考图");
  }
  const multiplier = await userMultiplier(userId);
  let unit = model.billing_unit,
    ip = discountedPrice(model.input_price_micro, multiplier),
    op = discountedPrice(model.output_price_micro, multiplier),
    quantity = 1;
  const visualBudget = refs.reduce(
    (sum, ref) =>
      sum +
      (ref.kind === "audio"
        ? Math.ceil(
            Number(ref.metadata?.duration || params.max_seconds || 60),
          ) * 200
        : ref.kind === "video"
          ? 32768
          : 16384),
    0,
  );
  const inputTokens = Buffer.byteLength(b.prompt) + 128 + visualBudget;
  let videoTier: Row | undefined;
  if (model.type === "video") {
    const [price] = await db.query(
      "SELECT * FROM prices WHERE model=$1 AND resolution=$2 AND enabled AND deleted_at IS NULL",
      [b.model, String(params.resolution || "1080P").toUpperCase()],
    );
    ensure(price, "该视频分辨率未配置价格", 503);
    videoTier = price;
    ip = 0;
    op = discountedPrice(price.sale_micro, multiplier);
    unit = "second";
  }
  if (unit === "million_characters")
    quantity = Math.max(1, b.prompt.length) / 1_000_000;
  else if (unit === "second")
    quantity = Number(
      params.max_seconds ??
        params.duration ??
        refs[0]?.metadata?.duration ??
        60,
    );
  ensure(
    Number.isFinite(quantity) && quantity > 0 && quantity <= 3600,
    "时长或数量应在1–3600之间",
  );
  if (
    ["happyoyster", "bailian-realtime", "bailian-inference"].includes(protocol)
  )
    ensure(quantity <= 120, "实时体验时长最长120秒");
  const reserve =
    unit === "million_tokens"
      ? charge(ip, inputTokens / 1_000_000) + charge(op, 2048 / 1_000_000)
      : charge(op || ip, quantity);
  if (b.project_id)
    ensure(
      (
        await db.query(
          "SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
          [b.project_id, userId],
        )
      ).length,
      "画布不存在",
      404,
    );
  return {
    b,
    model,
    protocol,
    multiplier,
    refs,
    price: {
      unit,
      input: ip,
      output: op,
      quantity,
      input_tokens: inputTokens,
      version: model.version,
      price_id: videoTier?.id,
      price_version: videoTier?.version,
    },
    reserve,
  };
}
export const capabilityRouter = Router();
capabilityRouter.post(
  "/quote",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "请通过站内画布使用此能力", 403);
    ensure(!(await settings()).maintenance, "系统维护中", 503);
    const q = await prepare(req.body, req.user.id);
    const expires = Date.now() + 300000;
    const payload = Buffer.from(
      JSON.stringify({
        user: req.user.id,
        body: hash(JSON.stringify(q.b)),
        price: q.price,
        multiplier: q.multiplier,
        reserve: q.reserve,
        expires,
      }),
    ).toString("base64url");
    res.json({
      token: `${payload}.${sign(payload)}`,
      input: q.b,
      reserved: yuan(q.reserve),
      unit: q.price.unit,
      quantity: q.price.quantity,
      multiplier: q.multiplier,
      expiresAt: expires,
    });
  }),
);
capabilityRouter.post(
  "/",
  rateLimit("capability-create", 30, 60),
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "请通过站内画布使用此能力", 403);
    const { quoteToken, request_key, ...raw } = req.body;
    const key = z.string().uuid().parse(request_key);
    const q = await prepare(raw, req.user.id),
      fingerprint = hash(JSON.stringify(q.b));
    const [old] = await db.query(
      "SELECT * FROM capability_jobs WHERE user_id=$1 AND request_key=$2",
      [req.user.id, key],
    );
    if (old) {
      ensure(old.request_hash === fingerprint, "幂等键冲突", 409);
      res.json(publicCapability(old));
      return;
    }
    const [payload, sig] = String(quoteToken || "").split(".");
    ensure(payload && sig && sign(payload) === sig, "报价无效");
    const quote = JSON.parse(Buffer.from(payload, "base64url").toString());
    ensure(
      quote.user === req.user.id &&
        quote.body === fingerprint &&
        quote.expires > Date.now() &&
        quote.reserve === q.reserve &&
        quote.multiplier === q.multiplier &&
        JSON.stringify(quote.price) === JSON.stringify(q.price),
      "价格或输入已变化，请重新报价",
    );
    const job = await transaction(async (tx) => {
      const m = await ensureModel(q.b.model, q.model.type, tx, false, true);
      ensure(m.version === q.model.version, "模型价格已变化");
      if (q.price.price_id) {
        const [tier] = await tx.query(
          "SELECT version,enabled FROM prices WHERE id=$1 AND deleted_at IS NULL FOR SHARE",
          [q.price.price_id],
        );
        ensure(
          tier?.enabled && tier.version === q.price.price_version,
          "视频档位价格已变化，请重新报价",
        );
      }

      ensure(
        (await userMultiplier(req.user.id, tx, true)) === q.multiplier,
        "专属倍率已变化",
      );
      await tx.query(
        "SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE",
        [req.user.id],
      );
      const [prior] = await tx.query(
        "SELECT * FROM capability_jobs WHERE user_id=$1 AND request_key=$2",
        [req.user.id, key],
      );
      if (prior) {
        ensure(prior.request_hash === fingerprint, "幂等键冲突", 409);
        return prior;
      }
      const links = await tx.query(
        "SELECT c.*,r.upstream_model FROM provider_channels c JOIN model_channels r ON r.channel_id=c.id WHERE r.model=$1 AND c.enabled AND c.deleted_at IS NULL AND c.provider='bailian' ORDER BY c.priority DESC,c.created_at FOR SHARE OF c",
        [q.b.model],
      );
      ensure(links.length, "请关联一个可用的百炼渠道", 503);
      const channel = links[0];
      ensure(
        !(q.protocol === "bailian-3d" && channel.region !== "cn-beijing"),
        "Tripo 3D 目前需要北京地域渠道",
      );
      ensure(
        !(
          q.protocol === "happyoyster" &&
          !channel.upstream_model.includes("adventure") &&
          channel.region === "cn-beijing"
        ),
        "此世界模型模式需要新加坡或弗吉尼亚渠道",
      );
      const [{ count }] = await tx.query(
        "SELECT count(*)::int AS count FROM capability_jobs WHERE user_id=$1 AND settlement='reserved'",
        [req.user.id],
      );
      ensure(count < 5, "最多同时运行5个多模态任务", 429);
      const id = randomUUID();
      const [created] = await tx.query(
        "INSERT INTO capability_jobs(id,user_id,model,protocol,channel_id,channel_version,upstream_model,project_id,node_id,request_key,request_hash,input,parameters,price_snapshot,discount_multiplier,reserved_micro) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
        [
          id,
          req.user.id,
          q.b.model,
          q.protocol,
          channel.id,
          channel.version,
          channel.upstream_model,
          q.b.project_id || null,
          q.b.node_id || null,
          key,
          fingerprint,
          { prompt: q.b.prompt, references: q.refs },
          q.b.parameters,
          q.price,
          q.multiplier,
          q.reserve,
        ],
      );
      if (q.reserve > 0)
        await walletEntry(tx, req.user.id, {
          type: "reserve",
          amount: -q.reserve,
          frozen: q.reserve,
          key: `capability-reserve:${id}`,
          reason: `${q.b.model} 预算预占`,
        });
      return created;
    });
    res.status(202).json(publicCapability(job));
  }),
);
capabilityRouter.get(
  "/",
  asyncRoute(async (req, res) =>
    res.json(
      await Promise.all(
        (
          await db.query(
            "SELECT * FROM capability_jobs WHERE user_id=$1 AND ($2::uuid IS NULL OR project_id=$2) ORDER BY created_at DESC LIMIT 100",
            [
              req.user.id,
              req.query.project_id
                ? z.string().uuid().parse(req.query.project_id)
                : null,
            ],
          )
        ).map(async (j) => publicCapability(j)),
      ),
    ),
  ),
);
capabilityRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const [j] = await db.query(
      "SELECT * FROM capability_jobs WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(j, "任务不存在", 404);
    res.json(publicCapability(j));
  }),
);
capabilityRouter.post(
  "/:id/cancel",
  asyncRoute(async (req, res) => {
    const [j] = await db.query(
      "SELECT * FROM capability_jobs WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(j, "任务不存在", 404);
    ensure(
      ["QUEUED", "READY"].includes(j.status),
      "已提交的任务不可重复取消，请等待结果或结束实时会话",
    );
    res.json(
      publicCapability(
        await settleCapability(j.id, 0, "CANCELED", j.output, {}, "用户取消", [
          "QUEUED",
          "READY",
        ]),
      ),
    );
  }),
);
capabilityRouter.get(
  "/files/:file",
  asyncRoute(async (req, res) => {
    const [f] = await db.query(
      "SELECT * FROM capability_files WHERE id=$1 AND user_id=$2 AND expires_at>now()",
      [req.params.file, req.user.id],
    );
    ensure(f, "文件不存在或已过期", 404);
    res.setHeader("Content-Type", f.mime);
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    );
    res.send(await readObject(f.object_key, f.storage));
  }),
);

async function persistFile(job: Row, url: string, kind: string, name: string) {
  const [prior] = await db.query(
    "SELECT * FROM capability_files WHERE job_id=$1 AND name=$2 AND expires_at>now()",
    [job.id, name],
  );
  if (prior)
    return {
      id: prior.id,
      name: prior.name,
      kind: prior.kind,
      url: `/api/v1/capabilities/files/${prior.id}`,
    };
  let buffer: Buffer, mime: string;
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    ensure(match && match[2].length < 150_000_000, "上游文件无效");
    buffer = Buffer.from(match[2], "base64");
    mime = match[1];
  } else {
    const fetched = await fetchPublic(url, 200_000_000);
    buffer = fetched.buffer;
    mime = fetched.contentType;
  }
  if (kind === "model") mime = "model/gltf-binary";
  const id = randomUUID(),
    objectKey = `${job.user_id}/capabilities/${job.id}/${id}-${name}`;
  const storage = await putObject(objectKey, buffer, mime);
  try {
    await transaction(async (tx) => {
      await tx.query(
        "SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE",
        [job.user_id],
      );
      const [{ used }] = await tx.query(
        "SELECT COALESCE((SELECT sum(size) FROM assets WHERE user_id=$1 AND purged_at IS NULL),0)+COALESCE((SELECT sum(size) FROM capability_files WHERE user_id=$1 AND expires_at>now()),0) AS used",
        [job.user_id],
      );
      const [{ value }] = await tx.query(
        "SELECT value FROM settings WHERE id=1",
      );
      ensure(
        Number(used) + buffer.length <= Number(value.storageLimitGB || 5) * 1e9,
        "存储空间不足，请清理素材后由管理员重试保存",
      );
      await tx.query(
        "INSERT INTO capability_files(id,job_id,user_id,name,kind,mime,object_key,storage,size) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          job.id,
          job.user_id,
          name,
          kind,
          mime,
          objectKey,
          storage,
          buffer.length,
        ],
      );
    });
  } catch (error) {
    await deleteObject(objectKey, storage).catch(() => {});
    throw error;
  }
  return { id, name, kind, url: `/api/v1/capabilities/files/${id}` };
}
function parameters(job: Row) {
  const p = job.parameters;
  return Object.fromEntries(
    Object.entries(p).filter(([k]) => !["max_seconds", "mode"].includes(k)),
  );
}
export function buildCapabilityRequest(job: Row) {
  const refs: Row[] = job.input.references || [],
    prompt = job.input.prompt,
    p = parameters(job),
    model = job.upstream_model;
  switch (job.protocol) {
    case "bailian-tts":
      return {
        path: "/api/v1/services/aigc/multimodal-generation/generation",
        body: {
          model,
          input: {
            text: prompt,
            voice: p.voice || "Cherry",
            language_type: p.language_type || "Auto",
          },
        },
        async: false,
      };
    case "bailian-audio":
      return {
        path: "/api/v1/services/audio/tts/SpeechSynthesizer",
        body: {
          model,
          input: {
            ...(model.includes("next")
              ? {
                  text_prompt: prompt,
                  references: refs.map((r) => ({ audio_url: r.url })),
                }
              : { text: prompt, voice: p.voice || "longanyang" }),
            format: p.format || "wav",
            sample_rate: Number(p.sample_rate || 24000),
            ...p,
          },
        },
        async: false,
      };
    case "bailian-asr":
      return {
        path: "/api/v1/services/audio/asr/transcription",
        body: {
          model,
          input: { file_url: refs[0]?.url },
          parameters: { ...p, enable_itn: p.enable_itn ?? true },
        },
        async: true,
      };
    case "bailian-3d":
      return {
        path: "/api/v1/services/aigc/video-generation/3d-generation",
        body: {
          model,
          input:
            refs.length === 1
              ? { image: refs[0].url }
              : refs.length > 1
                ? {
                    images: Array.from({ length: 4 }, (_, i) =>
                      refs[i]
                        ? {
                            type: refs[i].url.toLowerCase().includes(".jpg")
                              ? "jpeg"
                              : "png",
                            file_token: refs[i].url,
                          }
                        : {},
                    ),
                  }
                : { prompt },
          parameters: p,
        },
        async: true,
      };
    case "bailian-video": {
      const mode = String(p.mode || job.parameters.mode || "text");
      const input: Row = { prompt };
      if (refs[0]) input.img_url = refs[0].url;
      if (refs[1]) input.last_frame_url = refs[1].url;
      return {
        path: "/api/v1/services/aigc/video-generation/video-synthesis",
        body: {
          model,
          input,
          parameters: {
            resolution: p.resolution || "1080P",
            ratio: p.ratio || "16:9",
            duration: Number(p.duration || 5),
            ...p,
          },
        },
        async: true,
      };
    }
    case "happyoyster": {
      const input: Row = { async: true, prompt };
      if (model.includes("adventure")) {
        input.perspective = p.perspective || "first_person";
        input.firstFrameImage = { url: refs[0]?.url };
      } else {
        input.resolution = String(p.resolution || "480p").toLowerCase();
        if (model.includes("acting")) {
          input.aspectRatio = p.aspectRatio || "9:16";
          input.firstFrameImage = {
            url: refs[0]?.url,
            referenceType: "default",
          };
        } else {
          input.creationModel = "simple";
          input.eventStyle = "normal";
          if (refs.length)
            input.inputImages = refs.map((r) => ({
              url: r.url,
              referenceType: "default",
            }));
        }
      }
      return {
        path: `/api/v2/apps/${encodeURIComponent(model)}/openapi/v1/worlds`,
        body: input,
        async: false,
      };
    }
    default:
      return null;
  }
}
async function streamCapability(job: Row, conn: Row) {
  const prompt = job.input.prompt,
    refs: Row[] = job.input.references || [];
  const native = job.protocol === "bailian-multimodal";
  const contents: Row[] = [];
  for (const ref of refs)
    contents.push(
      native
        ? { [ref.kind === "audio" ? "audio" : "image"]: ref.url }
        : ref.kind === "audio" || job.protocol === "bailian-asr-chat"
          ? {
              type: "input_audio",
              input_audio: {
                data: ref.url,
                ...(job.protocol !== "bailian-asr-chat"
                  ? { format: "wav" }
                  : {}),
              },
            }
          : { type: "image_url", image_url: { url: ref.url } },
    );
  if (job.protocol !== "bailian-asr-chat")
    contents.push(
      native
        ? { text: prompt || "请描述或转写输入内容" }
        : { type: "text", text: prompt || "请完整转写音频内容" },
    );
  const body: Row = native
    ? {
        model: job.upstream_model,
        input: { messages: [{ role: "user", content: contents }] },
        parameters: { incremental_output: true, result_format: "message" },
      }
    : {
        model: job.upstream_model,
        messages: [{ role: "user", content: refs.length ? contents : prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(job.protocol !== "bailian-asr-chat" ? { max_tokens: 2048 } : {}),
      };
  const response = await fetch(
    native
      ? `${conn.root}/api/v1/services/aigc/multimodal-generation/generation`
      : `${chatBase(conn.base_url)}/chat/completions`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        ...(native ? { "X-DashScope-SSE": "enable" } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    },
  );
  if (!response.ok) {
    const e = new Error(`上游请求失败（${response.status}）`) as any;
    e.explicit = response.status < 500;
    throw e;
  }
  ensure(response.body, "模型没有返回内容");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    text = "",
    audio = "",
    usage: Row = {},
    ended = false,
    totalBytes = 0;
  const parse = (block: string) => {
    const lines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!lines) return;
    if (lines === "[DONE]") {
      ended = true;
      return;
    }
    const chunk = JSON.parse(lines);
    if (chunk.code || chunk.error) throw new Error("上游流式请求报错");
    if (chunk.usage) usage = chunk.usage;
    const choice = (chunk.choices || chunk.output?.choices)?.[0];
    if (choice?.finish_reason) ended = true;
    const delta = choice?.delta || choice?.message;
    const value = delta?.content;
    if (typeof value === "string") text += value;
    else if (Array.isArray(value))
      text += value.map((c: Row) => c.text || "").join("");
    if (delta?.audio?.data) audio += delta.audio.data;
  };
  try {
    while (true) {
      const c = await reader.read();
      if (c.done) break;
      totalBytes += c.value.byteLength;
      ensure(totalBytes < 20_000_000, "返回内容超过限制");
      buffer = (buffer + decoder.decode(c.value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
      await db.query(
        "UPDATE capability_jobs SET output=$2,usage=$3,updated_at=now() WHERE id=$1",
        [job.id, { text }, usage],
      );
    }
    if (buffer.trim()) parse(buffer);
    ensure(ended, "上游连接意外中断");
  } finally {
    await reader.cancel().catch(() => {});
  }
  const files = [];
  if (audio)
    files.push(
      await persistFile(
        job,
        `data:audio/wav;base64,${audio}`,
        "audio",
        "output.wav",
      ),
    );
  return { output: { text, files }, usage };
}
async function finishResult(job: Row, data: Row) {
  const usage = data.usage || {},
    out = data.output || data.data || data;
  const files: Row[] = [];
  let text = out.text || out.transcription || "";
  if (job.protocol === "bailian-asr") {
    const list = out.results || (out.result ? [out.result] : []);
    for (const item of list) {
      if (item.transcription_url) {
        const url = String(item.transcription_url);
        const result = JSON.parse(
          url.startsWith("data:application/json;base64,")
            ? Buffer.from(url.split(",")[1], "base64").toString()
            : (await fetchPublic(url, 5_000_000)).buffer.toString(),
        );
        text += (result.transcripts || [])
          .map((t: Row) => t.text || "")
          .join("\n");
      }
    }
  }
  const urls: Array<[string, string, string]> = [];
  if (out.audio?.url)
    urls.push([
      out.audio.url,
      "audio",
      `audio.${job.parameters.format || "wav"}`,
    ]);
  if (out.video_url) urls.push([out.video_url, "video", "video.mp4"]);
  for (const result of out.results || []) {
    if (result.pbr_model_url || result.base_model_url)
      urls.push([
        result.pbr_model_url || result.base_model_url,
        "model",
        "model.glb",
      ]);
    if (result.rendered_image_url)
      urls.push([result.rendered_image_url, "image", "preview.png"]);
  }
  for (const [url, kind, name] of urls)
    files.push(await persistFile(job, url, kind, name));
  ensure(text || files.length, "上游未返回可用产物");
  const output = { text, files, duration: out.audio?.duration };
  return settleCapability(
    job.id,
    capabilityCost(job, usage, output),
    "SUCCEEDED",
    output,
    usage,
  );
}
export async function processCapabilityJobs() {
  const job = await transaction(async (tx) => {
    const [j] = await tx.query(
      "SELECT j.*,c.enabled AS channel_enabled,c.deleted_at AS channel_deleted,u.disabled AS user_disabled FROM capability_jobs j JOIN provider_channels c ON c.id=j.channel_id JOIN users u ON u.id=j.user_id WHERE j.status='QUEUED' ORDER BY j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED",
    );
    if (!j) return null;
    if (!j.channel_enabled || j.channel_deleted || j.user_disabled) {
      return { ...j, unavailable: true };
    }
    await tx.query(
      "UPDATE capability_jobs SET status='SUBMITTING',started_at=now(),lease_until=now()+interval '4 minutes',updated_at=now() WHERE id=$1",
      [j.id],
    );
    return j;
  });
  if (job) {
    if (job.unavailable)
      await settleCapability(job.id, 0, "CANCELED", {}, {}, "渠道已删除或停用");
    else {
      let sent = false;
      try {
        const conn = await capabilityConnection(job);
        if (["bailian-realtime", "bailian-inference"].includes(job.protocol)) {
          await db.query(
            "UPDATE capability_jobs SET status='READY',lease_until=NULL,updated_at=now() WHERE id=$1",
            [job.id],
          );
        } else if (
          [
            "openai-chat",
            "bailian-multimodal",
            "bailian-asr-chat",
            "bailian-omni",
          ].includes(job.protocol)
        ) {
          sent = true;
          const result = await streamCapability(job, conn);
          await settleCapability(
            job.id,
            capabilityCost(job, result.usage, result.output),
            "SUCCEEDED",
            result.output,
            result.usage,
          );
        } else {
          const spec = buildCapabilityRequest(job);
          ensure(spec, "未接入的协议");
          sent = true;
          const data = await bailianJson(
            conn,
            spec.path,
            spec.body,
            spec.async,
          );
          if (job.protocol === "happyoyster") {
            const worldId = data.data?.encryptedWorldId;
            ensure(worldId, "世界模型响应缺少 World ID");
            await db.query(
              "UPDATE capability_jobs SET status='PENDING',upstream_id=$2,next_poll_at=now()+interval '5 seconds',output=$3,lease_until=NULL,updated_at=now() WHERE id=$1",
              [job.id, worldId, { worldId }],
            );
          } else if (data.output?.task_id)
            await db.query(
              "UPDATE capability_jobs SET status='PENDING',upstream_id=$2,next_poll_at=now()+interval '10 seconds',lease_until=NULL,updated_at=now() WHERE id=$1",
              [job.id, data.output.task_id],
            );
          else await finishResult(job, data);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "任务请求失败";
        if (!sent || (error as any).explicit)
          await settleCapability(job.id, 0, "FAILED", {}, {}, msg);
        else
          await db.query(
            "UPDATE capability_jobs SET status='UNKNOWN',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1",
            [job.id, msg],
          );
      }
    }
  }
  const [pending] = await db.query(
    "UPDATE capability_jobs SET next_poll_at=now()+interval '12 seconds' WHERE id=(SELECT id FROM capability_jobs WHERE status IN ('PENDING','RUNNING') AND COALESCE(next_poll_at,now())<=now() ORDER BY next_poll_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *",
  );
  if (pending) {
    try {
      const conn = await capabilityConnection(pending);
      if (pending.protocol === "happyoyster") {
        const data = await bailianJson(
          conn,
          `/api/v2/apps/${encodeURIComponent(pending.upstream_model)}/openapi/v1/worlds/build-status?encryptedWorldId=${encodeURIComponent(pending.upstream_id)}`,
        );
        const status = data.data?.status;
        if (status === "ready")
          await db.query(
            "UPDATE capability_jobs SET status='READY',output=$2,next_poll_at=NULL,updated_at=now() WHERE id=$1",
            [pending.id, { worldId: pending.upstream_id, ready: true }],
          );
        else if (status === "failed")
          await settleCapability(
            pending.id,
            0,
            "FAILED",
            {},
            {},
            "世界构建失败",
          );
      } else {
        const data = await bailianJson(
          conn,
          `/api/v1/tasks/${encodeURIComponent(pending.upstream_id)}`,
        );
        const state = data.output?.task_status;
        if (state === "SUCCEEDED") await finishResult(pending, data);
        else if (["FAILED", "CANCELED"].includes(state))
          await settleCapability(
            pending.id,
            0,
            "FAILED",
            {},
            data.usage || {},
            String(data.output?.message || "上游任务失败"),
          );
        else
          await db.query(
            "UPDATE capability_jobs SET status=$2,usage=$3,updated_at=now() WHERE id=$1",
            [
              pending.id,
              state === "RUNNING" ? "RUNNING" : "PENDING",
              data.usage || {},
            ],
          );
      }
    } catch (error) {
      await db.query(
        "UPDATE capability_jobs SET error=$2,updated_at=now() WHERE id=$1",
        [pending.id, error instanceof Error ? error.message : "查询失败"],
      );
    }
  }
  await db.query(
    "UPDATE capability_jobs SET status='UNKNOWN',error='提交期间服务中断，请联系管理员核实，避免重复扣费',lease_until=NULL WHERE status='SUBMITTING' AND lease_until<now()",
  );
  const abandoned = await db.query(
    "SELECT * FROM capability_jobs WHERE status='READY' AND updated_at<now()-interval '15 minutes'",
  );
  for (const j of abandoned)
    await settleCapability(
      j.id,
      0,
      "CANCELED",
      j.output,
      {},
      "就绪后长时间未开始，预算已释放",
    );
}
export const capabilityAdminRouter = Router();
capabilityAdminRouter.get(
  "/capability-jobs",
  asyncRoute(async (_req, res) =>
    res.json(
      (
        await db.query(
          "SELECT j.*,u.username FROM capability_jobs j JOIN users u ON u.id=j.user_id ORDER BY j.created_at DESC LIMIT 200",
        )
      ).map((j) => ({ ...publicCapability(j), username: j.username })),
    ),
  ),
);
capabilityAdminRouter.post(
  "/capability-jobs/:id/reconcile",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        action: z.enum(["query", "release", "settle"]),
        amount: z.number().min(0).max(1e6).default(0),
        reason: z.string().min(2).max(1000),
      })
      .parse(req.body);
    const [j] = await db.query("SELECT * FROM capability_jobs WHERE id=$1", [
      req.params.id,
    ]);
    ensure(j, "任务不存在", 404);
    ensure(["UNKNOWN", "RECONCILE"].includes(j.status), "任务无需核对");
    if (b.action === "query") {
      ensure(j.upstream_id, "没有上游任务ID，请先核实费用");
      await db.query(
        "UPDATE capability_jobs SET status='PENDING',next_poll_at=now() WHERE id=$1",
        [j.id],
      );
    } else
      await settleCapability(
        j.id,
        b.action === "release" ? 0 : micro(b.amount),
        b.action === "release" ? "CANCELED" : "SUCCEEDED",
        j.output,
        j.usage,
        b.reason,
      );
    await audit(req.user.id, "reconcile_capability_job", j.id, b);
    res.json({ ok: true });
  }),
);

export async function cleanupCapabilityFiles() {
  const rows = await db.query(
    "DELETE FROM capability_files WHERE id IN (SELECT id FROM capability_files WHERE expires_at<now() LIMIT 50) RETURNING *",
  );
  for (const file of rows)
    await deleteObject(file.object_key, file.storage).catch(() => {});
}
