import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db, transaction, type Row, type Queryable } from "./db";
import { asyncRoute, ensure, encrypt } from "./security";
import { audit, micro, releaseTask, walletEntry } from "./finance";
import { MODEL_IDS } from "../shared/wan";
import { IMAGE_MODEL_IDS } from "../shared/image";
import {
  BAILIAN_MODEL_PRESETS,
  bailianHost,
  chatBase,
} from "../shared/protocols";
import { modelIdSchema } from "../shared/catalog";

const channelSchema = z.object({
  provider: z.enum(["bailian", "openai"]),
  name: z.string().trim().min(1).max(100),
  region: z
    .enum(["cn-beijing", "ap-southeast-1", "us-east-1"])
    .default("cn-beijing"),
  workspace: z
    .string()
    .trim()
    .max(150)
    .regex(/^[a-zA-Z0-9-]*$/)
    .default(""),
  baseUrl: z.string().trim().max(500).default(""),
  key: z.string().trim().max(500).optional(),
  models: z.array(modelIdSchema).min(1).max(500),
  model_mapping: z.record(modelIdSchema).default({}),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  concurrency: z.number().int().min(1).max(20).default(5),
  multiplier: z.number().min(0).max(100).default(1),
  budget: z.number().min(0).max(1e9).default(0),
  accountGroup: z.string().trim().max(150).optional(),
  request_key: z.string().uuid().optional(),
});
function validateBase(base: string) {
  const u = new URL(base);
  ensure(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash,
    "API地址必须是有效HTTP(S)地址",
  );
  return base.replace(/\/+$/, "");
}
export async function providerChannelList(tx: Queryable = db): Promise<Row[]> {
  const rows = await tx.query(
    "SELECT id,provider,name,region,workspace,base_url,models,model_mapping,priority,enabled,version,video_id,image_id,language_id,multiplier,budget_micro,concurrency,created_at FROM provider_channels WHERE deleted_at IS NULL ORDER BY created_at DESC",
  );
  return rows.map((c) => ({
    ...c,
    multiplier: Number(c.multiplier),
    source: c.provider === "bailian" ? "bailian" : "image",
    members: [c.video_id, c.image_id, c.language_id].filter(Boolean),
    supported_types:
      c.provider === "bailian"
        ? [
            "language",
            "image",
            "video",
            "speech",
            "threed",
            "world",
            "realtime",
          ]
        : ["image"],
  }));
}
export async function migrateProviderChannels() {
  const [done] = await db.query(
    "SELECT version FROM schema_migrations WHERE version=2026102202",
  );
  if (done) return;
  await transaction(async (tx) => {
    await tx.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
    if (
      (
        await tx.query(
          "SELECT version FROM schema_migrations WHERE version=2026102202",
        )
      ).length
    )
      return;
    const histories = await tx.query(
      "SELECT detail FROM audit_logs WHERE action='create_channel' ORDER BY created_at",
    );
    const grouped = new Set<string>();
    for (const h of histories) {
      const d = h.detail;
      if (!d.videoId || !d.imageId) continue;
      const [v] = await tx.query("SELECT * FROM credentials WHERE id=$1", [
        d.videoId,
      ]);
      const [i] = await tx.query(
        "SELECT * FROM image_credentials WHERE id=$1",
        [d.imageId],
      );
      if (
        !v ||
        !i ||
        v.secret !== i.encrypted_key ||
        v.workspace !== i.workspace ||
        v.name !== i.name
      )
        continue;
      if (grouped.has(v.id) || grouped.has(i.id)) continue;
      const base = bailianHost(v.workspace, "cn-beijing");
      const languageId = randomUUID();
      const models = Array.from(
        new Set([...(v.models || []), ...(i.metadata?.models || [])]),
      );
      await tx.query(
        "INSERT INTO language_channels(id,name,base_url,encrypted_key,models,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          languageId,
          v.name,
          chatBase(base),
          v.secret,
          JSON.stringify(models),
          v.priority,
          v.enabled,
        ],
      );
      await tx.query(
        "INSERT INTO provider_channels(id,provider,name,workspace,base_url,encrypted_key,models,video_id,image_id,language_id,priority,enabled,multiplier,budget_micro,concurrency) VALUES($1,'bailian',$2,$3,$4,$5,$6,$1,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
        [
          v.id,
          v.name,
          v.workspace,
          base,
          v.secret,
          JSON.stringify(models),
          i.id,
          languageId,
          v.priority,
          v.enabled,
          v.multiplier,
          v.budget_micro,
          v.concurrency,
        ],
      );
      grouped.add(v.id);
      grouped.add(i.id);
    }
    // Other old connections stay independent. Never merge by display name.
    const video = await tx.query(
      "SELECT * FROM credentials WHERE deleted_at IS NULL",
    );
    for (const c of video)
      if (!grouped.has(c.id))
        await tx.query(
          "INSERT INTO provider_channels(id,provider,name,workspace,base_url,encrypted_key,models,video_id,priority,enabled,multiplier,budget_micro,concurrency) VALUES($1,'bailian',$2,$3,$4,$5,$6,$1,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
          [
            c.id,
            c.name,
            c.workspace,
            bailianHost(c.workspace, "cn-beijing"),
            c.secret,
            JSON.stringify(c.models),
            c.priority,
            c.enabled,
            c.multiplier,
            c.budget_micro,
            c.concurrency,
          ],
        );
    const images = await tx.query(
      "SELECT * FROM image_credentials WHERE NOT deleted",
    );
    for (const c of images)
      if (!grouped.has(c.id))
        await tx.query(
          "INSERT INTO provider_channels(id,provider,name,workspace,base_url,encrypted_key,models,image_id,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$1,$8,$9) ON CONFLICT DO NOTHING",
          [
            c.id,
            c.provider === "qwen" ? "bailian" : "openai",
            c.name,
            c.workspace || "",
            c.base_url || bailianHost(c.workspace || "", "cn-beijing"),
            c.encrypted_key,
            JSON.stringify(c.metadata?.models || []),
            c.priority,
            c.enabled,
          ],
        );
    await ensureProviderMembers(tx);
    const groups = await tx.query("SELECT * FROM provider_channels");
    for (const c of groups) {
      await tx.query(
        "INSERT INTO provider_channel_versions(channel_id,version,base_url,encrypted_key,region) VALUES($1,1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [c.id, c.base_url, c.encrypted_key, c.region],
      );
    }
    await tx.query(
      "INSERT INTO schema_migrations(version) VALUES(2026102202) ON CONFLICT DO NOTHING",
    );
  });
}
async function ensureProviderMembers(tx: Queryable) {
  const legacyBailian = await tx.query(
    "SELECT * FROM provider_channels WHERE provider='bailian' AND deleted_at IS NULL AND (video_id IS NULL OR image_id IS NULL OR language_id IS NULL) FOR UPDATE",
  );
  for (const c of legacyBailian) {
    if (!c.video_id) {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO credentials(id,name,account_group,workspace,secret,models,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          c.name,
          c.workspace || c.id,
          c.workspace,
          c.encrypted_key,
          JSON.stringify(c.models),
          c.priority,
          c.enabled,
        ],
      );
      await tx.query(
        "INSERT INTO credential_versions(credential_id,version,secret,workspace,base_url) VALUES($1,1,$2,$3,$4)",
        [id, c.encrypted_key, c.workspace, c.base_url],
      );
      await tx.query("UPDATE provider_channels SET video_id=$2 WHERE id=$1", [
        c.id,
        id,
      ]);
    }
    if (!c.image_id) {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO image_credentials(id,provider,name,workspace,base_url,encrypted_key,key_version,priority,enabled,metadata) VALUES($1,'qwen',$2,$3,$4,$5,1,$6,$7,$8)",
        [
          id,
          c.name,
          c.workspace,
          c.base_url,
          c.encrypted_key,
          c.priority,
          c.enabled,
          { models: c.models },
        ],
      );
      await tx.query(
        "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url) VALUES($1,1,$2,$3,$4)",
        [id, c.encrypted_key, c.workspace, c.base_url],
      );
      await tx.query("UPDATE provider_channels SET image_id=$2 WHERE id=$1", [
        c.id,
        id,
      ]);
    }
    if (!c.language_id) {
      const id = randomUUID();
      await tx.query(
        "INSERT INTO language_channels(id,name,base_url,encrypted_key,models,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          c.name,
          chatBase(c.base_url),
          c.encrypted_key,
          JSON.stringify(c.models),
          c.priority,
          c.enabled,
        ],
      );
      await tx.query(
        "UPDATE provider_channels SET language_id=$2 WHERE id=$1",
        [c.id, id],
      );
    }
  }
}
export async function repairProviderMembers() {
  await transaction(async (tx) => {
    await tx.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
    await ensureProviderMembers(tx);
  });
}
async function cancelQueued(tx: Queryable, c: Row) {
  const generic = await tx.query(
    "SELECT * FROM capability_jobs WHERE channel_id=$1 AND status IN ('QUEUED','READY') AND settlement='reserved' FOR UPDATE",
    [c.id],
  );
  for (const job of generic) {
    if (Number(job.reserved_micro) > 0)
      await walletEntry(tx, job.user_id, {
        type: "release",
        amount: Number(job.reserved_micro),
        frozen: -Number(job.reserved_micro),
        key: `capability-settle:${job.id}`,
        reason: "渠道停用或删除，退还未提交预算",
      });
    await tx.query(
      "UPDATE capability_jobs SET status='CANCELED',settlement='released',reserved_micro=0,error='渠道停用或删除',completed_at=now(),updated_at=now() WHERE id=$1",
      [job.id],
    );
  }

  if (c.video_id) {
    const tasks = await tx.query(
      "SELECT * FROM tasks WHERE credential_id=$1 AND status='QUEUED' FOR UPDATE",
      [c.video_id],
    );
    for (const t of tasks)
      await releaseTask(
        tx,
        t,
        "CANCELED",
        "渠道已停用或删除，未提交任务取消并退回预算",
      );
  }
  if (c.image_id) {
    const tasks = await tx.query(
      "SELECT * FROM image_tasks WHERE credential_id=$1 AND status='QUEUED' FOR UPDATE",
      [c.image_id],
    );
    for (const t of tasks) {
      if (Number(t.reserved_micro) > 0)
        await walletEntry(tx, t.user_id, {
          type: "release",
          amount: Number(t.reserved_micro),
          frozen: -Number(t.reserved_micro),
          key: `image-release:${t.id}`,
          reason: "渠道已停用或删除，退回图片任务预算",
          imageTaskId: t.id,
        });
      await tx.query(
        "UPDATE image_tasks SET status='CANCELED',reserved_micro=0,settlement='released',error='渠道已停用或删除',updated_at=now() WHERE id=$1",
        [t.id],
      );
    }
  }
}
async function saveChannel(
  b: z.infer<typeof channelSchema>,
  id?: string,
  actorId?: string,
) {
  if (b.provider === "openai")
    ensure(
      !b.models.some(
        (model) => model.startsWith("qwen-") || model.startsWith("wan"),
      ),
      "百炼模型不能配置到 OpenAI 图片渠道",
    );
  const base = validateBase(
    b.baseUrl ||
      (b.provider === "bailian" ? bailianHost(b.workspace, b.region) : ""),
  );
  return transaction(async (tx) => {
    if (!id && b.request_key) {
      await tx.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
      const [prior] = await tx.query(
        "SELECT * FROM provider_channels WHERE creation_key=$1",
        [`${actorId}:${b.request_key}`],
      );
      if (prior)
        return {
          id: prior.id,
          videoId: prior.video_id,
          imageId: prior.image_id,
          languageId: prior.language_id,
          version: prior.version,
        };
    }
    const [old] = id
      ? await tx.query(
          "SELECT * FROM provider_channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
          [id],
        )
      : [];
    if (id) ensure(old, "渠道不存在", 404);
    ensure(b.key || old, "请输入 API Key");
    const secret = b.key ? encrypt(b.key) : old.encrypted_key;
    const root = id || randomUUID(),
      vid = b.provider === "bailian" ? old?.video_id || randomUUID() : null,
      img = old?.image_id || randomUUID(),
      lang = b.provider === "bailian" ? old?.language_id || randomUUID() : null;
    const version = (old?.version || 0) + 1;
    if (old)
      ensure(old.provider === b.provider, "渠道供应商不能更改，请新建渠道");
    if (vid) {
      const [v] = await tx.query(
        "SELECT * FROM credentials WHERE id=$1 FOR UPDATE",
        [vid],
      );
      const vv = (v?.version || 0) + 1;
      await tx.query(
        "INSERT INTO credentials(id,name,account_group,workspace,secret,enabled,models,multiplier,priority,concurrency,budget_micro,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET name=$2,account_group=$3,workspace=$4,secret=$5,enabled=$6,models=$7,multiplier=$8,priority=$9,concurrency=$10,budget_micro=$11,version=$12",
        [
          vid,
          b.name,
          b.accountGroup || b.workspace || root,
          b.workspace,
          secret,
          b.enabled,
          JSON.stringify(b.models),
          b.multiplier,
          b.priority,
          Math.min(5, b.concurrency),
          micro(b.budget),
          vv,
        ],
      );
      await tx.query(
        "INSERT INTO credential_versions(credential_id,version,secret,workspace,base_url) VALUES($1,$2,$3,$4,$5)",
        [vid, vv, secret, b.workspace, base],
      );
    }
    const [i] = await tx.query(
      "SELECT * FROM image_credentials WHERE id=$1 FOR UPDATE",
      [img],
    );
    const iv = (i?.key_version || 0) + 1;
    await tx.query(
      "INSERT INTO image_credentials(id,provider,name,workspace,base_url,encrypted_key,key_version,priority,enabled,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET provider=$2,name=$3,workspace=$4,base_url=$5,encrypted_key=$6,key_version=$7,priority=$8,enabled=$9,metadata=$10,updated_at=now()",
      [
        img,
        b.provider === "bailian" ? "qwen" : "openai",
        b.name,
        b.workspace || null,
        base,
        secret,
        iv,
        b.priority,
        b.enabled,
        JSON.stringify({ models: b.models }),
      ],
    );
    await tx.query(
      "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url) VALUES($1,$2,$3,$4,$5)",
      [img, iv, secret, b.workspace || null, base],
    );
    if (lang) {
      await tx.query(
        "INSERT INTO language_channels(id,name,base_url,encrypted_key,models,model_mapping,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET name=$2,base_url=$3,encrypted_key=$4,models=$5,model_mapping=$6,priority=$7,enabled=$8,version=language_channels.version+1,updated_at=now()",
        [
          lang,
          b.name,
          chatBase(base),
          secret,
          JSON.stringify(b.models),
          JSON.stringify(b.model_mapping),
          b.priority,
          b.enabled,
        ],
      );
    }
    await tx.query(
      "INSERT INTO provider_channels(id,provider,name,region,workspace,base_url,encrypted_key,models,model_mapping,priority,enabled,version,video_id,image_id,language_id,multiplier,budget_micro,concurrency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(id) DO UPDATE SET name=$3,region=$4,workspace=$5,base_url=$6,encrypted_key=$7,models=$8,model_mapping=$9,priority=$10,enabled=$11,version=$12,video_id=$13,image_id=$14,language_id=$15,multiplier=$16,budget_micro=$17,concurrency=$18,updated_at=now()",
      [
        root,
        b.provider,
        b.name,
        b.region,
        b.workspace,
        base,
        secret,
        JSON.stringify(b.models),
        JSON.stringify(b.model_mapping),
        b.priority,
        b.enabled,
        version,
        vid,
        img,
        lang,
        b.multiplier,
        micro(b.budget),
        b.concurrency,
      ],
    );
    if (!id && b.request_key)
      await tx.query(
        "UPDATE provider_channels SET creation_key=$2 WHERE id=$1",
        [root, `${actorId}:${b.request_key}`],
      );
    await tx.query(
      "INSERT INTO provider_channel_versions(channel_id,version,base_url,encrypted_key,region) VALUES($1,$2,$3,$4,$5)",
      [root, version, base, secret, b.region],
    );
    if (old && !b.enabled) await cancelQueued(tx, old);
    if (old) {
      const memberIds = [root, vid, img, lang].filter(Boolean);
      for (const memberId of memberIds) {
        const routes = await tx.query(
          "SELECT * FROM model_channels WHERE channel_id=$1",
          [memberId],
        );
        for (const route of routes) {
          if (
            ((old.models || []).includes(route.model) &&
              !b.models.includes(route.model)) ||
            (!b.models.includes(route.model) &&
              !b.models.includes(route.upstream_model))
          )
            await tx.query(
              "DELETE FROM model_channels WHERE model=$1 AND channel_id=$2",
              [route.model, memberId],
            );
          else if (
            Object.prototype.hasOwnProperty.call(
              b.model_mapping,
              route.model,
            ) ||
            Object.prototype.hasOwnProperty.call(
              old.model_mapping || {},
              route.model,
            )
          )
            await tx.query(
              "UPDATE model_channels SET upstream_model=$3 WHERE model=$1 AND channel_id=$2",
              [
                route.model,
                memberId,
                b.model_mapping[route.model] || route.model,
              ],
            );
        }
      }
    }
    // New selections acquire one logical route; history keeps its submission snapshot.
    for (const model of b.models) {
      const [m] = await tx.query(
        "SELECT * FROM model_catalog WHERE model=$1 AND deleted_at IS NULL",
        [model],
      );
      if (!m) continue;
      const src = b.provider === "bailian" ? "bailian" : "image";
      const cid = b.provider === "bailian" ? root : img;
      await tx.query(
        "INSERT INTO model_channels(model,channel_id,source,upstream_model) VALUES($1,$2,$3,$4) ON CONFLICT(model,channel_id) DO NOTHING",
        [model, cid, src, b.model_mapping[model] || model],
      );
    }
    return { id: root, videoId: vid, imageId: img, languageId: lang, version };
  });
}
export const channelRouter = Router();
channelRouter.get(
  "/channels",
  asyncRoute(async (_req, res) => {
    const grouped = await providerChannelList();
    const members = new Set(grouped.flatMap((c) => c.members));
    const languages = await db.query(
      "SELECT id,name,base_url,models,model_mapping,priority,enabled,created_at,'language' AS source,'language' AS provider FROM language_channels WHERE deleted_at IS NULL",
    );
    res.json(
      [...grouped, ...languages.filter((c) => !members.has(c.id))].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    );
  }),
);
channelRouter.post(
  "/channels",
  asyncRoute(async (req, res) => {
    const b = channelSchema.parse(req.body);
    if (b.request_key) {
      const [prior] = await db.query(
        "SELECT target,detail FROM audit_logs WHERE actor_id=$1 AND action='create_provider_channel' AND detail->>'request_key'=$2",
        [req.user.id, b.request_key],
      );
      if (prior) {
        res.json(prior.detail.result);
        return;
      }
    }
    const result = await saveChannel(b, undefined, req.user.id);
    await audit(req.user.id, "create_provider_channel", result.id, {
      ...b,
      key: undefined,
      result,
    });
    res.json(result);
  }),
);
channelRouter.patch(
  "/channels/:id",
  asyncRoute(async (req, res) => {
    const b = channelSchema.parse(req.body);
    const result = await saveChannel(b, String(req.params.id));
    await audit(req.user.id, "update_provider_channel", result.id, {
      ...b,
      key: undefined,
    });
    res.json(result);
  }),
);
channelRouter.delete(
  "/channels/:id",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [c] = await tx.query(
        "SELECT * FROM provider_channels WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [req.params.id],
      );
      ensure(c, "渠道不存在", 404);
      await cancelQueued(tx, c);
      await tx.query(
        "UPDATE provider_channels SET enabled=false,deleted_at=now(),updated_at=now() WHERE id=$1",
        [c.id],
      );
      if (c.video_id)
        await tx.query(
          "UPDATE credentials SET enabled=false,deleted_at=now() WHERE id=$1",
          [c.video_id],
        );
      if (c.image_id)
        await tx.query(
          "UPDATE image_credentials SET enabled=false,deleted=true,updated_at=now() WHERE id=$1",
          [c.image_id],
        );
      if (c.language_id)
        await tx.query(
          "UPDATE language_channels SET enabled=false,deleted_at=now() WHERE id=$1",
          [c.language_id],
        );
      const ids = [c.id, c.video_id, c.image_id, c.language_id].filter(Boolean);
      for (const id of ids)
        await tx.query("DELETE FROM model_channels WHERE channel_id=$1", [id]);
      await audit(
        req.user.id,
        "delete_provider_channel",
        c.id,
        { name: c.name },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
