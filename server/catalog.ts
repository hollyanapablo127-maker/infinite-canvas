import { providerChannelList } from "./channels";
import {
  PROTOCOLS,
  PROTOCOL_IDS,
  protocolFor,
  type ProtocolId,
} from "../shared/protocols";
import { Router } from "express";
import { z } from "zod";
import { db, transaction, type Row, type Queryable } from "./db";
import { asyncRoute, ensure } from "./security";
import { audit, micro, yuan, charge } from "./finance";
import { MODEL_IDS, RESOLUTIONS } from "../shared/wan";
import {
  IMAGE_MODEL_IDS,
  IMAGE_SIZE_CATEGORIES,
  MODEL_CAPABILITIES,
} from "../shared/image";
import {
  MODEL_TYPES,
  modelIdSchema,
  registerModelAdapters,
  adapterModel,
} from "../shared/catalog";

export async function userMultiplier(
  userId: string,
  tx: Queryable = db,
  lock = false,
) {
  const [user] = await tx.query(
    `SELECT discount_multiplier FROM users WHERE id=$1${lock ? " FOR SHARE" : ""}`,
    [userId],
  );
  ensure(user, "用户不存在", 404);
  return Number(user.discount_multiplier ?? 1);
}
export function discountedPrice(price: number | string, multiplier: number) {
  return charge(price, multiplier);
}

export async function availableChannels(tx: Queryable = db): Promise<Row[]> {
  const [video, image, language] = await Promise.all([
    tx.query(
      "SELECT id,name,enabled,models,'video' AS source,'bailian' AS provider FROM credentials",
    ),
    tx.query(
      "SELECT id,name,enabled,provider,metadata,'image' AS source FROM image_credentials WHERE NOT deleted",
    ),
    tx.query(
      "SELECT id,name,enabled,models,model_mapping,'language' AS source,'language' AS provider FROM language_channels WHERE deleted_at IS NULL",
    ),
  ]);
  const groups = await providerChannelList(tx);
  const members = new Map<string, Row>();
  for (const group of groups)
    for (const id of group.members) members.set(id, group);
  return [
    ...groups,
    ...video.map((c) => ({
      ...c,
      canonical_id: members.get(c.id)?.id,
      canonical_source: members.get(c.id)?.source,
    })),
    ...image.map((row) => ({
      ...row,
      models: row.metadata?.models || [],
      canonical_id: members.get(row.id)?.id,
      canonical_source: members.get(row.id)?.source,
    })),
    ...language.map((c) => ({
      ...c,
      canonical_id: members.get(c.id)?.id,
      canonical_source: members.get(c.id)?.source,
    })),
  ];
}
export async function ensureModel(
  model: string,
  type: string,
  tx: Queryable = db,
  allowDisabled = false,
  lock = false,
) {
  const [row] = await tx.query(
    `SELECT * FROM model_catalog WHERE model=$1 AND type=$2 AND deleted_at IS NULL${lock ? " FOR SHARE" : ""}`,
    [model, type],
  );
  ensure(row && (row.enabled || allowDisabled), "模型已停用或删除", 503);
  return row;
}
export async function modelRoutes(
  model: string,
  source: string,
  tx: Queryable = db,
) {
  const links = await tx.query(
    "SELECT * FROM model_channels WHERE model=$1 ORDER BY channel_id",
    [model],
  );
  const rows: Row[] = [];
  for (const link of links) {
    if (link.source === source) {
      const [group] = await tx.query(
        "SELECT * FROM provider_channels WHERE id=$1 AND deleted_at IS NULL AND enabled",
        [link.channel_id],
      );
      const id =
        group?.[
          source === "video"
            ? "video_id"
            : source === "image"
              ? "image_id"
              : "language_id"
        ];
      rows.push(
        id ? { ...link, channel_id: id, provider_channel_id: group.id } : link,
      );
    } else if (link.source === "bailian") {
      const [channel] = await tx.query(
        "SELECT * FROM provider_channels WHERE id=$1 AND deleted_at IS NULL AND enabled",
        [link.channel_id],
      );
      const id =
        channel?.[
          source === "video"
            ? "video_id"
            : source === "image"
              ? "image_id"
              : "language_id"
        ];
      if (id)
        rows.push({
          ...link,
          channel_id: id,
          provider_channel_id: channel.id,
          source,
        });
    }
  }
  return rows;
}
export async function refreshModelAdapters() {
  registerModelAdapters(
    await db.query("SELECT model,adapter,capabilities FROM model_catalog"),
  );
}
export async function modelCatalog(admin = false, multiplier = 1) {
  await refreshModelAdapters();
  const [models, links, channels, video, image] = await Promise.all([
    db.query(
      "SELECT * FROM model_catalog WHERE deleted_at IS NULL ORDER BY sort,created_at,model",
    ),
    db.query("SELECT * FROM model_channels"),
    availableChannels(),
    db.query(
      "SELECT * FROM prices WHERE deleted_at IS NULL ORDER BY model,resolution",
    ),
    db.query(
      "SELECT * FROM image_prices WHERE deleted_at IS NULL ORDER BY model,size_category",
    ),
  ]);
  return models.map((model) => {
    const modelLinks = links.filter((link) => link.model === model.model);
    const modelChannels = modelLinks.flatMap((link) => {
      const channel = channels.find(
        (channel) =>
          channel.id === link.channel_id && channel.source === link.source,
      );
      return channel
        ? [
            {
              id: channel.canonical_id || channel.id,
              name: channel.name,
              source: channel.canonical_source || channel.source,
              enabled: channel.enabled,
              ...(admin ? { upstream_model: link.upstream_model } : {}),
            },
          ]
        : [];
    });
    const distinctChannels = Array.from(
      new Map(modelChannels.map((c) => [c.id, c])).values(),
    );
    const prices =
      model.type === "video"
        ? video
            .filter((p) => p.model === model.model)
            .map((p) => ({
              id: p.id,
              version: p.version,
              tier: p.resolution,
              official: yuan(p.official_micro),
              base_sale: yuan(p.sale_micro),
              sale: yuan(discountedPrice(p.sale_micro, multiplier)),
              enabled: admin ? p.enabled : p.enabled && model.enabled,
            }))
        : model.type === "image"
          ? image
              .filter((p) => p.model === model.model)
              .map((p) => ({
                id: p.id,
                version: p.version,
                tier: p.size_category,
                input_official: yuan(p.input_official_micro),
                output_official: yuan(p.output_official_micro),
                base_input: yuan(p.input_sale_micro),
                base_output: yuan(p.output_sale_micro),
                input_sale: yuan(
                  discountedPrice(p.input_sale_micro, multiplier),
                ),
                output_sale: yuan(
                  discountedPrice(p.output_sale_micro, multiplier),
                ),
                enabled: admin ? p.enabled : p.enabled && model.enabled,
              }))
          : [
              {
                tier: "token",
                input_sale: yuan(
                  discountedPrice(model.input_price_micro, multiplier),
                ),
                output_sale: yuan(
                  discountedPrice(model.output_price_micro, multiplier),
                ),
                base_input: yuan(model.input_price_micro),
                base_output: yuan(model.output_price_micro),
                enabled: model.enabled,
              },
            ];
    return {
      model: model.model,
      display_name: model.display_name,
      type: model.type,
      description: model.description,
      adapter: model.adapter,
      enabled: model.enabled,
      version: model.version,
      sort: model.sort,
      channels: distinctChannels,
      protocol:
        model.protocol || protocolFor(model.type, model.adapter, model.model),
      capabilities: model.capabilities,
      prices,
      input_price: yuan(model.input_price_micro),
      output_price: yuan(model.output_price_micro),
      capability:
        model.type === "image" ? MODEL_CAPABILITIES[model.model] : undefined,
      multiplier,
      billing_unit: model.billing_unit,
    };
  });
}

const connectionSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(["video", "image", "language", "bailian"]),
  upstream_model: modelIdSchema,
});
const modelSchema = z.object({
  model: modelIdSchema,
  display_name: z.string().trim().min(1).max(120),
  type: z.enum(MODEL_TYPES),
  description: z.string().trim().max(2000).default(""),
  adapter: z.string().max(150).default(""),
  protocol: z.enum(PROTOCOL_IDS as [ProtocolId, ...ProtocolId[]]).optional(),
  capabilities: z
    .object({
      maxImages: z.number().int().min(0).max(16).optional(),
      maxN: z.number().int().min(1).max(6).optional(),
      maxSize: z.enum(["1K", "2K", "4K"]).optional(),
      maxPixels: z.number().int().min(512).max(4096).optional(),
    })
    .default({}),
  channels: z.array(connectionSchema).max(100).default([]),
  enabled: z.boolean().default(true),
  input_price: z.number().min(0).max(1000000).default(0),
  output_price: z.number().min(0).max(1000000).default(0),
  billing_unit: z
    .enum(["million_tokens", "million_characters", "second", "request"])
    .default("million_tokens"),
  sort: z.number().int().min(-10000).max(10000).default(0),
  tiers: z
    .array(
      z.object({
        tier: z.string(),
        official: z.number().min(0.000001).max(1000).optional(),
        sale: z.number().min(0.000001).max(1000).optional(),
        input_official: z.number().min(0).max(1000).optional(),
        input_sale: z.number().min(0).max(1000).optional(),
        output_official: z.number().min(0.000001).max(1000).optional(),
        output_sale: z.number().min(0.000001).max(1000).optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .max(3)
    .optional(),
});
async function validateModel(
  value: z.infer<typeof modelSchema>,
  tx: Queryable,
) {
  if (value.type === "language")
    ensure(
      value.billing_unit === "million_tokens",
      "语言模型按百万 token 计费",
    );
  if (value.type === "video")
    ensure(
      (MODEL_IDS as readonly string[]).includes(value.adapter),
      "请选择已接入的视频协议",
    );
  if (value.type === "image")
    ensure(
      (IMAGE_MODEL_IDS as readonly string[]).includes(value.adapter),
      "请选择已接入的图片协议",
    );
  ensure(
    new Set(value.channels.map((c) => c.id)).size === value.channels.length,
    "同一渠道只能关联一次",
  );
  const channels = await availableChannels(tx);
  for (const link of value.channels) {
    const channel = channels.find(
      (c) => c.id === link.id && c.source === link.source,
    );
    ensure(channel, "关联渠道不存在");
    if (link.source === "bailian")
      ensure(
        channel.models.includes(value.model) ||
          channel.models.includes(link.upstream_model),
        "请先在渠道中添加支持的本站模型或上游模型",
      );

    ensure(
      link.source === "bailian" ||
        link.source ===
          (value.type === "video"
            ? "video"
            : value.type === "image"
              ? "image"
              : "language"),
      "模型类型与渠道类型不匹配",
    );
    if (value.type === "image")
      ensure(
        (channel.provider === "bailian" ? "qwen" : channel.provider) ===
          MODEL_CAPABILITIES[value.adapter].provider,
        "图片协议与渠道提供商不匹配",
      );
    if (value.type === "language" || value.type === "speech")
      ensure(
        channel.source === "bailian" ||
          channel.models.includes(value.model) ||
          channel.models.includes(link.upstream_model),
        "请先在语言渠道中添加该模型或上游映射模型",
      );
  }
  const tiers = value.tiers || [];
  ensure(
    new Set(tiers.map((t) => t.tier)).size === tiers.length,
    "定价档位重复",
  );
  for (const tier of tiers) {
    if (value.type === "video") {
      ensure(
        (RESOLUTIONS as readonly string[]).includes(tier.tier),
        "视频分辨率无效",
      );
      ensure(
        tier.official !== undefined && tier.sale !== undefined,
        "请填写视频原价和售价",
      );
    } else if (value.type === "image") {
      ensure(
        (IMAGE_SIZE_CATEGORIES as readonly string[]).includes(tier.tier) &&
          IMAGE_SIZE_CATEGORIES.indexOf(tier.tier as any) <=
            IMAGE_SIZE_CATEGORIES.indexOf(
              MODEL_CAPABILITIES[value.adapter].maxSize,
            ),
        "图片尺寸超出模型能力",
      );
      ensure(
        tier.input_official !== undefined &&
          tier.input_sale !== undefined &&
          tier.output_official !== undefined &&
          tier.output_sale !== undefined,
        "请填写图片输入和输出价格",
      );
    } else ensure(false, "语言与语音模型使用 token 价格");
  }
}
function normalizeModel(raw: Row) {
  const protocol = (raw.protocol ||
    protocolFor(raw.type, raw.adapter, raw.model)) as ProtocolId;
  ensure(PROTOCOLS[protocol], "请选择已接入的协议家族");
  ensure(
    (PROTOCOLS[protocol].types as readonly string[]).includes(raw.type),
    "模型类型与协议家族不匹配",
  );
  const adapter = PROTOCOLS[protocol].adapter || raw.adapter || "";
  return modelSchema.parse({ ...raw, protocol, adapter });
}
export const modelAdminRouter = Router();
modelAdminRouter.get(
  "/models",
  asyncRoute(async (_req, res) => res.json(await modelCatalog(true))),
);
modelAdminRouter.post(
  "/models",
  asyncRoute(async (req, res) => {
    const b = normalizeModel(req.body);
    await transaction(async (tx) => {
      await validateModel(b, tx);
      const [old] = await tx.query(
        "SELECT * FROM model_catalog WHERE model=$1 FOR UPDATE",
        [b.model],
      );
      ensure(!old || old.deleted_at, "模型 ID 已存在，请编辑已有模型", 409);
      if (old)
        ensure(
          old.type === b.type &&
            (old.protocol || protocolFor(old.type, old.adapter)) === b.protocol,
          "同一模型 ID 的类型和接入协议必须与历史配置一致，请使用新 ID",
        );
      await tx.query(
        `INSERT INTO model_catalog(model,display_name,type,description,adapter,enabled,input_price_micro,output_price_micro,sort)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(model) DO UPDATE SET display_name=$2,type=$3,description=$4,adapter=$5,enabled=$6,input_price_micro=$7,output_price_micro=$8,sort=$9,deleted_at=NULL,version=model_catalog.version+1,updated_at=now()`,
        [
          b.model,
          b.display_name,
          b.type,
          b.description,
          b.adapter,
          b.enabled,
          micro(b.input_price),
          micro(b.output_price),
          b.sort,
        ],
      );
      await tx.query(
        "UPDATE model_catalog SET billing_unit=$2,routing_configured=true,protocol=$3,capabilities=$4 WHERE model=$1",
        [b.model, b.billing_unit, b.protocol, JSON.stringify(b.capabilities)],
      );
      await tx.query("DELETE FROM model_channels WHERE model=$1", [b.model]);
      for (const c of b.channels)
        await tx.query(
          "INSERT INTO model_channels(model,channel_id,source,upstream_model) VALUES($1,$2,$3,$4)",
          [b.model, c.id, c.source, c.upstream_model],
        );
      for (const t of b.tiers || []) {
        if (b.type === "video")
          await tx.query(
            "INSERT INTO prices(id,model,resolution,official_micro,sale_micro,enabled,effective_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,now())",
            [b.model, t.tier, micro(t.official!), micro(t.sale!), t.enabled],
          );
        if (b.type === "image")
          await tx.query(
            "INSERT INTO image_prices(id,model,size_category,input_official_micro,input_sale_micro,output_official_micro,output_sale_micro,enabled) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)",
            [
              b.model,
              t.tier,
              micro(t.input_official!),
              micro(t.input_sale!),
              micro(t.output_official!),
              micro(t.output_sale!),
              t.enabled,
            ],
          );
      }
      await audit(req.user.id, "create_model", b.model, b, tx);
    });
    await refreshModelAdapters();
    res.status(201).json({ ok: true });
  }),
);
modelAdminRouter.patch(
  "/models/:model",
  asyncRoute(async (req, res) => {
    const b = normalizeModel({ ...req.body, model: req.params.model });
    await transaction(async (tx) => {
      const [old] = await tx.query(
        "SELECT * FROM model_catalog WHERE model=$1 AND deleted_at IS NULL FOR UPDATE",
        [b.model],
      );
      ensure(old, "模型不存在", 404);
      ensure(
        old.type === b.type &&
          (old.protocol || protocolFor(old.type, old.adapter)) === b.protocol,
        "已创建模型的类型和接入协议不可改变，请新建模型",
      );
      await validateModel(b, tx);
      await tx.query(
        "UPDATE model_catalog SET display_name=$2,description=$3,enabled=$4,input_price_micro=$5,output_price_micro=$6,sort=$7,version=version+1,updated_at=now() WHERE model=$1",
        [
          b.model,
          b.display_name,
          b.description,
          b.enabled,
          micro(b.input_price),
          micro(b.output_price),
          b.sort,
        ],
      );
      await tx.query(
        "UPDATE model_catalog SET billing_unit=$2,routing_configured=true,protocol=$3,capabilities=$4 WHERE model=$1",
        [b.model, b.billing_unit, b.protocol, JSON.stringify(b.capabilities)],
      );
      await tx.query("DELETE FROM model_channels WHERE model=$1", [b.model]);
      for (const c of b.channels)
        await tx.query(
          "INSERT INTO model_channels(model,channel_id,source,upstream_model) VALUES($1,$2,$3,$4)",
          [b.model, c.id, c.source, c.upstream_model],
        );
      await audit(req.user.id, "update_model", b.model, b, tx);
    });
    res.json({ ok: true });
  }),
);
modelAdminRouter.delete(
  "/models/:model",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [row] = await tx.query(
        "UPDATE model_catalog SET deleted_at=now(),enabled=false,version=version+1 WHERE model=$1 AND deleted_at IS NULL RETURNING model",
        [req.params.model],
      );
      ensure(row, "模型不存在", 404);
      await tx.query(
        "UPDATE prices SET deleted_at=now(),enabled=false WHERE model=$1 AND deleted_at IS NULL",
        [row.model],
      );
      await tx.query(
        "UPDATE image_prices SET deleted_at=now(),enabled=false WHERE model=$1 AND deleted_at IS NULL",
        [row.model],
      );
      await tx.query("DELETE FROM model_channels WHERE model=$1", [row.model]);
      await audit(req.user.id, "delete_model", row.model, {}, tx);
    });
    res.json({ ok: true });
  }),
);
