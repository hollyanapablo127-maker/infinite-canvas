import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, settings, transaction } from "./db";
import { asyncRoute, ensure, hash, token, pagination } from "./security";
import { currentPrices, publicPrice, micro, yuan } from "./finance";
import {
  MEDIA_TYPES,
  DEFAULT_PARAMETERS,
  RATIOS,
  RESOLUTIONS,
} from "../shared/wan";

import { modelCatalog, userMultiplier, discountedPrice } from "./catalog";
import { modelIdSchema } from "../shared/catalog";

const keyModelsSchema = z
  .array(z.union([modelIdSchema, z.literal("*")]))
  .min(1, "请选择至少一个模型，或选择不限模型")
  .max(500)
  .refine(
    (models) => !models.includes("*") || models.length === 1,
    "不限模型不能与指定模型同时选择",
  )
  .transform((models) => [...new Set(models)]);

export const personalRouter = Router();
personalRouter.get(
  "/ledger",
  asyncRoute(async (req, res) =>
    res.json(
      await db.query(
        "SELECT id,type,amount,frozen_delta,available_after,frozen_after,task_id,image_task_id,reason,created_at FROM ledger WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
        [req.user.id, ...pagination(req)],
      ),
    ),
  ),
);
personalRouter.get(
  "/models",
  asyncRoute(async (req, res) => {
    const multiplier = await userMultiplier(req.user.id);
    const catalog = await modelCatalog(false, multiplier);
    const visibleModels = new Map(catalog.map((m) => [m.model, m]));
    const prices = (await currentPrices())
      .filter((p) => visibleModels.has(p.model))
      .map((p) => ({
        ...publicPrice(p),
        base_sale: yuan(p.sale_micro),
        sale: yuan(discountedPrice(p.sale_micro, multiplier)),
        enabled: p.enabled && visibleModels.get(p.model)!.enabled,
      }));
    const imagePrices = await db.query(
      "SELECT id,version,model,size_category,input_official_micro,input_sale_micro,output_official_micro,output_sale_micro,enabled FROM image_prices WHERE deleted_at IS NULL ORDER BY model,size_category",
    );
    res.json({
      catalog,
      adapters: await db.query(
        "SELECT model,adapter,capabilities FROM model_catalog",
      ),
      multiplier,
      prices,
      imagePrices: imagePrices
        .filter((p) => visibleModels.has(p.model))
        .map((price) => ({
          id: price.id,
          version: price.version,
          model: price.model,
          size_category: price.size_category,
          input_official: yuan(price.input_official_micro),
          input_sale: yuan(discountedPrice(price.input_sale_micro, multiplier)),
          base_input: yuan(price.input_sale_micro),
          output_official: yuan(price.output_official_micro),
          output_sale: yuan(
            discountedPrice(price.output_sale_micro, multiplier),
          ),
          base_output: yuan(price.output_sale_micro),
          enabled: price.enabled && visibleModels.get(price.model)!.enabled,
        })),
      models: catalog.map((model) => model.model),
      capabilities: {
        mediaTypes: MEDIA_TYPES,
        defaults: DEFAULT_PARAMETERS,
        ratios: RATIOS,
        resolutions: RESOLUTIONS,
        maxMedia: 20,
        maxInputVideoSeconds: 15,
        maxTotalVideoSeconds: 30,
      },
    });
  }),
);
personalRouter.get(
  "/wallet",
  asyncRoute(async (req, res) => {
    const [wallet] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
      req.user.id,
    ]);
    res.json({
      available: Number(wallet.available) / 1e6,
      frozen: Number(wallet.frozen) / 1e6,
      ledger: await db.query(
        "SELECT id,type,amount,frozen_delta,available_after,frozen_after,task_id,image_task_id,reason,created_at FROM ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500",
        [req.user.id],
      ),
    });
  }),
);
personalRouter.get(
  "/api-keys",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT k.id,k.name,k.prefix,k.disabled,k.revoked,k.expires_at,k.daily_limit,k.monthly_limit,k.models,k.created_at,k.last_used,COALESCE((SELECT sum(t.charged_micro-t.refunded_micro) FROM tasks t WHERE t.api_key_id=k.id),0) AS spent FROM api_keys k WHERE k.user_id=$1 ORDER BY created_at DESC",
        [req.user.id],
      ),
    );
  }),
);
personalRouter.post(
  "/api-keys",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "密钥管理需网页登录", 403);
    const s = await settings();
    const b = z
      .object({
        name: z.string().trim().min(1).max(50),
        dailyLimit: z
          .number()
          .positive()
          .max(1e6)
          .default(s.defaultApiDailyLimit),
        monthlyLimit: z
          .number()
          .positive()
          .max(1e7)
          .default(s.defaultApiMonthlyLimit),
        models: keyModelsSchema.default(["*"]),
        expiresAt: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);
    const [{ count }] = await db.query(
      "SELECT count(*)::int AS count FROM api_keys WHERE user_id=$1 AND NOT revoked",
      [req.user.id],
    );
    ensure(count < 20, "最多创建 20 个有效密钥");
    const secret = `ic_${token()}`;
    const id = randomUUID();
    await db.query(
      "INSERT INTO api_keys(id,user_id,name,key_hash,prefix,daily_limit,monthly_limit,models,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        req.user.id,
        b.name,
        hash(secret),
        `${secret.slice(0, 9)}...${secret.slice(-4)}`,
        micro(b.dailyLimit),
        micro(b.monthlyLimit),
        JSON.stringify(b.models),
        b.expiresAt || null,
      ],
    );
    res.status(201).json({ id, key: secret });
  }),
);
personalRouter.patch(
  "/api-keys/:id",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "密钥管理需网页登录", 403);
    const b = z
      .object({
        disabled: z.boolean().optional(),
        name: z.string().min(1).max(50).optional(),
        revoked: z.boolean().optional(),
        dailyLimit: z.number().positive().max(1e6).optional(),
        monthlyLimit: z.number().positive().max(1e7).optional(),
        models: keyModelsSchema.optional(),
      })
      .parse(req.body);
    const [k] = await db.query(
      "SELECT * FROM api_keys WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(k && !k.revoked, "密钥不存在或已撤销", 404);
    if (b.revoked) {
      await db.query("DELETE FROM api_keys WHERE id=$1 AND user_id=$2", [
        k.id,
        req.user.id,
      ]);
      res.json({ ok: true, deleted: true });
      return;
    }
    await db.query(
      "UPDATE api_keys SET disabled=$2,name=$3,daily_limit=$4,monthly_limit=$5,models=$6 WHERE id=$1",
      [
        k.id,
        b.disabled ?? k.disabled,
        b.name ?? k.name,
        b.dailyLimit ? micro(b.dailyLimit) : k.daily_limit,
        b.monthlyLimit ? micro(b.monthlyLimit) : k.monthly_limit,
        b.models ? JSON.stringify(b.models) : JSON.stringify(k.models),
      ],
    );
    res.json({ ok: true });
  }),
);
personalRouter.delete(
  "/api-keys/:id",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "密钥管理需网页登录", 403);
    const [deleted] = await db.query(
      "DELETE FROM api_keys WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.user.id],
    );
    ensure(deleted, "密钥不存在", 404);
    res.json({ ok: true });
  }),
);
personalRouter.post(
  "/api-keys/:id/rotate",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "密钥管理需网页登录", 403);
    const key = `ic_${token()}`;
    const rows = await db.query(
      "UPDATE api_keys SET key_hash=$3,prefix=$4 WHERE id=$1 AND user_id=$2 AND NOT revoked RETURNING id",
      [
        req.params.id,
        req.user.id,
        hash(key),
        `${key.slice(0, 9)}...${key.slice(-4)}`,
      ],
    );
    ensure(rows.length, "密钥不存在", 404);
    res.json({ key });
  }),
);
personalRouter.get(
  "/announcements",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT a.*,r.version AS read_version FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1 WHERE a.published AND a.starts_at<=now() AND (a.ends_at IS NULL OR a.ends_at>now()) AND a.audience IN ('all',$2) ORDER BY a.pinned DESC,a.sort,a.starts_at DESC",
        [req.user.id, req.user.role],
      ),
    );
  }),
);
personalRouter.post(
  "/announcements/:id/read",
  asyncRoute(async (req, res) => {
    await db.query(
      "INSERT INTO announcement_reads(user_id,announcement_id,version) SELECT $1,id,version FROM announcements WHERE id=$2 ON CONFLICT(user_id,announcement_id) DO UPDATE SET version=EXCLUDED.version,read_at=now()",
      [req.user.id, req.params.id],
    );
    res.json({ ok: true });
  }),
);
personalRouter.get(
  "/notifications",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [req.user.id],
      ),
    );
  }),
);
personalRouter.post(
  "/notifications/read",
  asyncRoute(async (req, res) => {
    await db.query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL",
      [req.user.id],
    );
    res.json({ ok: true });
  }),
);
personalRouter.get(
  "/events",
  asyncRoute(async (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const timer = setInterval(async () => {
      try {
        const [u] = await db.query("SELECT disabled FROM users WHERE id=$1", [
          req.user.id,
        ]);
        if (!u || u.disabled) {
          res.end();
          return;
        }
        const valid = req.apiKey
          ? await db.query(
              "SELECT id FROM api_keys WHERE id=$1 AND NOT disabled AND NOT revoked AND (expires_at IS NULL OR expires_at>now())",
              [req.apiKey.id],
            )
          : await db.query(
              "SELECT id FROM sessions WHERE id=$1 AND expires_at>now()",
              [req.sessionId],
            );
        if (!valid.length) {
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({ type: "refresh", at: Date.now() })}\n\n`,
        );
      } catch {
        res.end();
      }
    }, 15000);
    req.on("close", () => clearInterval(timer));
  }),
);

export const projectRouter = Router();
const contentSchema = z.object({
  nodes: z
    .array(
      z
        .object({
          id: z.string().max(100),
          type: z.string().max(30).optional(),
          position: z.object({
            x: z.number().finite(),
            y: z.number().finite(),
          }),
          data: z.record(z.unknown()),
          width: z.number().optional(),
          height: z.number().optional(),
          parentId: z.string().optional(),
          extent: z.any().optional(),
          style: z.record(z.unknown()).optional(),
        })
        .passthrough(),
    )
    .max(1500),
  edges: z
    .array(
      z
        .object({ id: z.string(), source: z.string(), target: z.string() })
        .passthrough(),
    )
    .max(3000),
  viewport: z
    .object({ x: z.number(), y: z.number(), zoom: z.number().positive() })
    .optional(),
});
projectRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT id,name,description,version,archived,deleted_at,created_at,updated_at,jsonb_array_length(content->'nodes') AS node_count FROM projects WHERE user_id=$1 ORDER BY updated_at DESC",
        [req.user.id],
      ),
    );
  }),
);
projectRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(300).default(""),
        content: contentSchema.optional(),
      })
      .parse(req.body);
    const [p] = await db.query(
      "INSERT INTO projects(id,user_id,name,description,content) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        randomUUID(),
        req.user.id,
        b.name,
        b.description,
        JSON.stringify(b.content || { nodes: [], edges: [] }),
      ],
    );
    res.status(201).json(p);
  }),
);
projectRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const [p] = await db.query(
      "SELECT * FROM projects WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(p, "画布不存在", 404);
    res.json(p);
  }),
);
projectRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(300).optional(),
        archived: z.boolean().optional(),
        deleted: z.boolean().optional(),
        content: contentSchema.optional(),
        version: z.number().int().positive(),
      })
      .parse(req.body);
    const p = await transaction(async (tx) => {
      const [p] = await tx.query(
        "SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [req.params.id, req.user.id],
      );
      ensure(p, "画布不存在", 404);
      ensure(
        p.version === b.version,
        "画布已在其他窗口更新，请重新载入或保存为副本",
        409,
      );
      if (b.content) {
        ensure(JSON.stringify(b.content).length < 2_000_000, "画布内容过大");
        await tx.query(
          "INSERT INTO project_revisions(id,project_id,version,content) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [randomUUID(), p.id, p.version, JSON.stringify(p.content)],
        );
      }
      return (
        await tx.query(
          "UPDATE projects SET name=$2,description=$3,archived=$4,deleted_at=$5,content=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
          [
            p.id,
            b.name ?? p.name,
            b.description ?? p.description,
            b.archived ?? p.archived,
            b.deleted === undefined
              ? p.deleted_at
              : b.deleted
                ? new Date().toISOString()
                : null,
            JSON.stringify(b.content ?? p.content),
          ],
        )
      )[0];
    });
    res.json(p);
  }),
);
projectRouter.post(
  "/:id/duplicate",
  asyncRoute(async (req, res) => {
    const [p] = await db.query(
      "SELECT * FROM projects WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id],
    );
    ensure(p, "画布不存在", 404);
    const content = JSON.parse(JSON.stringify(p.content));
    for (const n of content.nodes) {
      delete n.data.taskId;
      delete n.data.status;
    }
    const [copy] = await db.query(
      "INSERT INTO projects(id,user_id,name,description,content) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [
        randomUUID(),
        req.user.id,
        `${p.name} · 副本`,
        p.description,
        JSON.stringify(content),
      ],
    );
    res.json(copy);
  }),
);
projectRouter.get(
  "/:id/revisions",
  asyncRoute(async (req, res) => {
    ensure(
      (
        await db.query("SELECT id FROM projects WHERE id=$1 AND user_id=$2", [
          req.params.id,
          req.user.id,
        ])
      ).length,
      "画布不存在",
      404,
    );
    res.json(
      await db.query(
        "SELECT id,version,created_at,content FROM project_revisions WHERE project_id=$1 ORDER BY version DESC LIMIT 30",
        [req.params.id],
      ),
    );
  }),
);
