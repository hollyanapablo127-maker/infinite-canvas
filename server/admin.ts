import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, settings, transaction } from "./db";
import {
  asyncRoute,
  ensure,
  encrypt,
  passwordHash,
  safeUser,
  hash,
  HttpError,
  pagination,
} from "./security";
import {
  audit,
  micro,
  yuan,
  walletEntry,
  publicTask,
  releaseTask,
} from "./finance";
import { MODEL_IDS, RESOLUTIONS } from "../shared/wan";
import {
  IMAGE_MODEL_IDS,
  IMAGE_SIZE_CATEGORIES,
  MODEL_CAPABILITIES,
} from "../shared/image";
import { providerRequest, settleSuccess } from "./generations";
import { config } from "./config";
import { oss } from "./storage";
import { PAYMENT_KEY_MASK, publicPlan } from "./payments";

import { capabilityAdminRouter } from "./capabilities";
import { channelRouter } from "./channels";
import { modelAdminRouter, ensureModel, modelRoutes } from "./catalog";
import { languageAdminRouter } from "./language";
import { modelIdSchema, adapterModel } from "../shared/catalog";

export const adminRouter = Router();
adminRouter.use(async (req, _res, next) => {
  try {
    if (req.method !== "GET") {
      const [session] = await db.query(
        "SELECT id FROM sessions WHERE id=$1 AND verified_at>now()-interval '15 minutes'",
        [(req as any).sessionId],
      );
      if (!session) throw new HttpError(428, "请重新验证管理员密码");
    }
    next();
  } catch (e) {
    next(e);
  }
});

adminRouter.use(
  channelRouter,
  modelAdminRouter,
  languageAdminRouter,
  capabilityAdminRouter,
);

const planSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  price: z.number().positive().max(100000),
  original_price: z.number().positive().max(100000),
  quota_day: z.number().nonnegative().max(1000000).default(0),
  quota_week: z.number().nonnegative().max(1000000).default(0),
  quota_month: z.number().nonnegative().max(1000000).default(0),
  valid_days: z.number().int().min(1).max(3650),
  valid_unit: z.enum(["day", "week", "month"]).default("day"),
  sort: z.number().int().min(-100000).max(100000).default(0),
  features: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  enabled: z.boolean().default(true),
});

adminRouter.get(
  "/plans",
  asyncRoute(async (_req, res) => {
    const rows = await db.query(
      "SELECT * FROM subscription_plans WHERE deleted_at IS NULL ORDER BY sort ASC,created_at DESC",
    );
    res.json(rows.map(publicPlan));
  }),
);

adminRouter.post(
  "/plans",
  asyncRoute(async (req, res) => {
    const b = planSchema.parse(req.body);
    ensure(b.original_price >= b.price, "原价不能低于售价");
    const id = randomUUID();
    const row = await transaction(async (tx) => {
      const [created] = await tx.query(
        "INSERT INTO subscription_plans(id,name,description,price_micro,original_price_micro,daily_quota,weekly_quota,monthly_quota,duration,duration_unit,sort,features,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
        [
          id,
          b.name,
          b.description,
          micro(b.price),
          micro(b.original_price),
          b.quota_day,
          b.quota_week,
          b.quota_month,
          b.valid_days,
          b.valid_unit,
          b.sort,
          JSON.stringify(b.features),
          b.enabled,
        ],
      );
      await audit(req.user.id, "create_subscription_plan", id, b, tx);
      return created;
    });
    res.status(201).json(publicPlan(row));
  }),
);

adminRouter.patch(
  "/plans/:id",
  asyncRoute(async (req, res) => {
    const b = planSchema.parse(req.body);
    ensure(b.original_price >= b.price, "原价不能低于售价");
    const row = await transaction(async (tx) => {
      const [updated] = await tx.query(
        "UPDATE subscription_plans SET name=$2,description=$3,price_micro=$4,original_price_micro=$5,daily_quota=$6,weekly_quota=$7,monthly_quota=$8,duration=$9,duration_unit=$10,sort=$11,features=$12,enabled=$13,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
        [
          req.params.id,
          b.name,
          b.description,
          micro(b.price),
          micro(b.original_price),
          b.quota_day,
          b.quota_week,
          b.quota_month,
          b.valid_days,
          b.valid_unit,
          b.sort,
          JSON.stringify(b.features),
          b.enabled,
        ],
      );
      ensure(updated, "订阅套餐不存在", 404);
      await audit(req.user.id, "update_subscription_plan", updated.id, b, tx);
      return updated;
    });
    res.json(publicPlan(row));
  }),
);

adminRouter.delete(
  "/plans/:id",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [deleted] = await tx.query(
        "UPDATE subscription_plans SET deleted_at=now(),enabled=false,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id",
        [req.params.id],
      );
      ensure(deleted, "订阅套餐不存在", 404);
      await audit(req.user.id, "delete_subscription_plan", deleted.id, {}, tx);
    });
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/dashboard",
  asyncRoute(async (req, res) => {
    const [users] = await db.query(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today,count(*) FILTER(WHERE last_active>now()-interval '1 day')::int AS active FROM users",
    );
    const [tasks] = await db.query(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE status='SUCCEEDED')::int AS succeeded,count(*) FILTER(WHERE status='FAILED')::int AS failed,count(*) FILTER(WHERE status IN ('QUEUED','PENDING','RUNNING','SUBMITTING'))::int AS active,COALESCE(sum(charged_micro-refunded_micro),0) AS revenue,COALESCE(sum(cost_micro),0) AS cost,COALESCE(sum(refunded_micro),0) AS refunded FROM tasks",
    );
    const [today] = await db.query(
      "SELECT count(*)::int AS calls,COALESCE(sum(charged_micro-refunded_micro),0) AS revenue,COALESCE(sum(cost_micro),0) AS cost FROM tasks WHERE completed_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')",
    );
    const trends = await db.query(
      "SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','MM-DD') AS day,count(*)::int AS count,COALESCE(sum(charged_micro-refunded_micro),0) AS revenue FROM tasks WHERE created_at>now()-interval '30 days' GROUP BY day ORDER BY day",
    );
    const [storage] = await db.query(
      "SELECT count(*)::int AS count,COALESCE(sum(size),0) AS bytes FROM assets WHERE purged_at IS NULL",
    );
    const [wallets] = await db.query(
      "SELECT COALESCE(sum(available),0) AS available,COALESCE(sum(frozen),0) AS frozen FROM wallets",
    );
    const recent = await db.query(
      "SELECT t.*,u.display_name FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 8",
    );
    res.json({
      users,
      tasks,
      today,
      trends,
      storage,
      wallets,
      recent: recent.map((t) => ({
        ...publicTask(t),
        display_name: t.display_name,
        cost: yuan(t.cost_micro),
      })),
    });
  }),
);
adminRouter.get(
  "/users",
  asyncRoute(async (req, res) => {
    const users = await db.query(
      "SELECT u.*,w.available,w.frozen,COALESCE((SELECT sum(t.charged_micro-t.refunded_micro) FROM tasks t WHERE t.user_id=u.id),0) AS spent FROM users u JOIN wallets w ON w.user_id=u.id ORDER BY u.created_at DESC,u.id DESC LIMIT $1 OFFSET $2",
      pagination(req),
    );
    res.json(
      users.map((u) => ({
        ...safeUser(u),
        available: yuan(u.available),
        frozen: yuan(u.frozen),
        spent: yuan(u.spent),
        last_active: u.last_active,
      })),
    );
  }),
);
adminRouter.post(
  "/users",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/),
        display_name: z.string().min(1).max(40),
        password: z.string().min(8).max(128),
        role: z.enum(["user", "admin"]).default("user"),
        email: z.string().email().optional().or(z.literal("")),
      })
      .parse(req.body);
    const id = randomUUID();
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO users(id,username,display_name,password_hash,role,email) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          b.username.toLowerCase(),
          b.display_name,
          await passwordHash(b.password),
          b.role,
          b.email?.toLowerCase() || null,
        ],
      );
      await tx.query("INSERT INTO wallets(user_id) VALUES($1)", [id]);
      await audit(
        req.user.id,
        "create_user",
        id,
        { username: b.username, role: b.role },
        tx,
      );
    });
    res.json({ id });
  }),
);
adminRouter.patch(
  "/users/:id",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        disabled: z.boolean().optional(),
        role: z.enum(["user", "admin"]).optional(),
        password: z.string().min(8).max(128).optional(),
        discount_multiplier: z.number().min(0).max(1).optional(),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      await tx.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
      const [u] = await tx.query("SELECT * FROM users WHERE id=$1", [
        req.params.id,
      ]);
      ensure(u, "用户不存在", 404);
      if (u.role === "admin" && (b.disabled || b.role === "user")) {
        const [{ count }] = await tx.query(
          "SELECT count(*)::int AS count FROM users WHERE role='admin' AND NOT disabled",
        );
        ensure(count > 1, "不能停用或降级最后一个管理员");
      }
      ensure(!(u.id === req.user.id && b.disabled), "不能停用当前登录账号");
      await tx.query(
        "UPDATE users SET disabled=$2,role=$3,password_hash=$4,discount_multiplier=$5 WHERE id=$1",
        [
          u.id,
          b.disabled ?? u.disabled,
          b.role ?? u.role,
          b.password ? await passwordHash(b.password) : u.password_hash,
          b.discount_multiplier ?? u.discount_multiplier,
        ],
      );
      if (b.disabled !== undefined || b.role !== undefined || b.password)
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
      await audit(
        req.user.id,
        "update_user",
        u.id,
        {
          disabled: b.disabled,
          role: b.role,
          passwordReset: !!b.password,
          discount_multiplier: b.discount_multiplier,
        },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.post(
  "/users/:id/balance",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        type: z.enum([
          "recharge",
          "deduction",
          "refund",
          "withdrawal",
          "reversal",
        ]),
        amount: z.number().positive().max(1e6),
        reason: z.string().trim().min(2).max(500),
        taskId: z.string().uuid().optional(),
        relatedId: z.string().uuid().optional(),
        idempotencyKey: z.string().min(8).max(128),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      if (b.type === "refund" && b.taskId)
        await tx.query("SELECT id FROM tasks WHERE id=$1 FOR UPDATE", [
          b.taskId,
        ]);
      await tx.query(
        "SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE",
        [req.params.id],
      );
      const fingerprint = hash(JSON.stringify({ user: req.params.id, ...b }));
      const [previous] = await tx.query(
        "SELECT request_hash FROM ledger WHERE business_key=$1",
        [`admin:${req.user.id}:${b.idempotencyKey}`],
      );
      if (previous) {
        ensure(
          previous.request_hash === fingerprint,
          "同一幂等键不能提交不同余额操作",
          409,
        );
        return;
      }
      const amount = micro(b.amount);
      ensure(amount > 0, "金额最小为 0.000001 元");
      let delta = ["recharge", "refund"].includes(b.type) ? amount : -amount;
      if (b.type === "refund") {
        ensure(b.taskId, "退款需关联原调用");
        const [t] = await tx.query(
          "SELECT * FROM tasks WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [b.taskId, req.params.id],
        );
        ensure(
          t && Number(t.charged_micro) - Number(t.refunded_micro) >= amount,
          "退款超过可退金额",
        );
        await tx.query(
          "UPDATE tasks SET refunded_micro=refunded_micro+$2 WHERE id=$1",
          [t.id, amount],
        );
      }
      if (b.type === "reversal") {
        ensure(b.relatedId, "请选择冲正原记录");
        const [l] = await tx.query(
          "SELECT * FROM ledger WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [b.relatedId, req.params.id],
        );
        ensure(
          l && ["recharge", "deduction", "withdrawal"].includes(l.type),
          "该记录不能直接冲正",
        );
        ensure(Math.abs(Number(l.amount)) === amount, "冲正金额须与原记录相同");
        ensure(
          !(
            await tx.query(
              "SELECT id FROM ledger WHERE related_id=$1 AND type='reversal'",
              [l.id],
            )
          ).length,
          "记录已经冲正",
        );
        delta = -Number(l.amount);
      }
      await walletEntry(tx, req.params.id, {
        type: b.type,
        amount: delta,
        key: `admin:${req.user.id}:${b.idempotencyKey}`,
        reason: b.reason,
        taskId: b.taskId,
        relatedId: b.relatedId,
        actor: req.user.id,
        requestHash: fingerprint,
      });
      await audit(
        req.user.id,
        `balance_${b.type}`,
        req.params.id,
        { amount: b.amount, reason: b.reason, taskId: b.taskId },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/users/:id/ledger",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT * FROM ledger WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
        [req.params.id, ...pagination(req)],
      ),
    );
  }),
);
adminRouter.get(
  "/prices",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT * FROM prices WHERE deleted_at IS NULL ORDER BY model,resolution",
      ),
    );
  }),
);
const priceValuesSchema = z.object({
  official: z.number().min(0.000001).max(1000),
  sale: z.number().min(0.000001).max(1000),
  enabled: z.boolean(),
});
adminRouter.post(
  "/prices",
  asyncRoute(async (req, res) => {
    const b = priceValuesSchema
      .extend({
        model: modelIdSchema,
        resolution: z.enum(RESOLUTIONS),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      await ensureModel(b.model, "video", tx, true, true);
      const [existing] = await tx.query(
        "SELECT id FROM prices WHERE model=$1 AND resolution=$2 AND deleted_at IS NULL",
        [b.model, b.resolution],
      );
      ensure(!existing, "该模型规格已有定价，请修改现有定价", 409);
      await tx.query(
        "INSERT INTO prices(id,model,resolution,official_micro,sale_micro,enabled,effective_at) VALUES($1,$2,$3,$4,$5,$6,now())",
        [
          randomUUID(),
          b.model,
          b.resolution,
          micro(b.official),
          micro(b.sale),
          b.enabled,
        ],
      );
      await audit(
        req.user.id,
        "publish_price",
        `${b.model}:${b.resolution}`,
        b,
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.patch(
  "/prices/:id",
  asyncRoute(async (req, res) => {
    const b = priceValuesSchema.parse(req.body);
    await transaction(async (tx) => {
      const [price] = await tx.query(
        "UPDATE prices SET official_micro=$2,sale_micro=$3,enabled=$4,effective_at=now(),version=version+1 WHERE id=$1 AND deleted_at IS NULL RETURNING *",
        [req.params.id, micro(b.official), micro(b.sale), b.enabled],
      );
      ensure(price, "定价不存在", 404);
      await audit(
        req.user.id,
        "update_price",
        price.id,
        {
          model: price.model,
          resolution: price.resolution,
          version: price.version,
          ...b,
        },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.delete(
  "/prices/:id",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [price] = await tx.query(
        "UPDATE prices SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
        [req.params.id],
      );
      ensure(price, "定价不存在", 404);
      await audit(
        req.user.id,
        "delete_price",
        price.id,
        {
          model: price.model,
          resolution: price.resolution,
        },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
const channelSchema = z.object({
  name: z.string().min(1).max(80),
  account_group: z.string().min(1).max(100),
  workspace: z.string().regex(/^[a-zA-Z0-9-]{3,100}$/, "请填写北京业务空间 ID"),
  key: z.string().min(10).max(500).optional(),
  enabled: z.boolean().default(true),
  models: z
    .array(z.enum(MODEL_IDS))
    .min(1)
    .default([...MODEL_IDS]),
  multiplier: z.number().min(0).max(100),
  priority: z.number().int().min(-100).max(100).default(0),
  concurrency: z.number().int().min(1).max(5).default(5),
  budget: z.number().min(0).max(1e9).default(0),
});
adminRouter.get(
  "/credentials",
  asyncRoute(async (req, res) => {
    const rows = await db.query(
      "SELECT c.id,c.name,c.account_group,c.workspace,c.version,c.enabled,c.models,c.multiplier,c.priority,c.concurrency,c.budget_micro,c.created_at,count(t.id)::int AS calls,COALESCE(sum(t.cost_micro),0) AS cost,COALESCE(sum(t.charged_micro-t.refunded_micro),0) AS revenue FROM credentials c LEFT JOIN tasks t ON t.credential_id=c.id GROUP BY c.id ORDER BY c.created_at DESC",
    );
    res.json(rows);
  }),
);
adminRouter.post(
  "/credentials",
  asyncRoute(async (req, res) => {
    const b = channelSchema.parse(req.body);
    ensure(b.key, "请输入百炼 API Key");
    const id = randomUUID();
    const secret = encrypt(b.key!.trim());
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO credentials(id,name,account_group,workspace,secret,enabled,models,multiplier,priority,concurrency,budget_micro) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          id,
          b.name,
          b.account_group,
          b.workspace,
          secret,
          b.enabled,
          JSON.stringify(b.models),
          b.multiplier,
          b.priority,
          b.concurrency,
          micro(b.budget),
        ],
      );
      await tx.query(
        "INSERT INTO credential_versions(credential_id,version,secret,workspace) VALUES($1,1,$2,$3)",
        [id, secret, b.workspace],
      );
      const { key, ...detail } = b;
      await audit(req.user.id, "create_credential", id, detail, tx);
    });
    res.json({ id });
  }),
);
adminRouter.patch(
  "/credentials/:id",
  asyncRoute(async (req, res) => {
    const b = channelSchema.parse(req.body);
    await transaction(async (tx) => {
      const [c] = await tx.query(
        "SELECT * FROM credentials WHERE id=$1 FOR UPDATE",
        [req.params.id],
      );
      ensure(c, "渠道不存在", 404);
      const changed = !!b.key || b.workspace !== c.workspace;
      const version = c.version + (changed ? 1 : 0);
      const secret = b.key ? encrypt(b.key) : c.secret;
      await tx.query(
        "UPDATE credentials SET name=$2,account_group=$3,workspace=$4,secret=$5,enabled=$6,models=$7,multiplier=$8,priority=$9,concurrency=$10,budget_micro=$11,version=$12 WHERE id=$1",
        [
          c.id,
          b.name,
          b.account_group,
          b.workspace,
          secret,
          b.enabled,
          JSON.stringify(b.models),
          b.multiplier,
          b.priority,
          b.concurrency,
          micro(b.budget),
          version,
        ],
      );
      if (changed)
        await tx.query(
          "INSERT INTO credential_versions(credential_id,version,secret,workspace) VALUES($1,$2,$3,$4)",
          [c.id, version, secret, b.workspace],
        );
      const { key, ...detail } = b;
      await audit(
        req.user.id,
        "update_credential",
        c.id,
        { ...detail, rotated: !!key },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/usage",
  asyncRoute(async (req, res) => {
    const rows = await db.query(
      "SELECT t.*,u.username,u.display_name,c.name AS channel FROM tasks t JOIN users u ON u.id=t.user_id LEFT JOIN credentials c ON c.id=t.credential_id ORDER BY t.created_at DESC,t.id DESC LIMIT $1 OFFSET $2",
      pagination(req),
    );
    res.json(
      rows.map((t) => ({
        ...publicTask(t),
        user_id: t.user_id,
        username: t.username,
        display_name: t.display_name,
        channel: t.channel,
        multiplier: t.multiplier,
        cost: yuan(t.cost_micro),
        actual_cost:
          t.actual_cost_micro === null ? null : yuan(t.actual_cost_micro),
        upstream_id: t.upstream_id,
        request_id: t.request_id,
        internal_error: t.internal_error,
      })),
    );
  }),
);
adminRouter.post(
  "/usage/:id/reconcile",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        action: z.enum(["query", "release", "actual_cost", "settle"]),
        inputSeconds: z.number().min(0).max(15).optional(),
        outputSeconds: z.number().positive().max(30).optional(),
        upstreamId: z.string().max(200).optional(),
        actualCost: z.number().nonnegative().max(1e6).optional(),
        reason: z.string().min(2).max(300),
      })
      .parse(req.body);
    const [t] = await db.query("SELECT * FROM tasks WHERE id=$1", [
      req.params.id,
    ]);
    ensure(t, "任务不存在", 404);
    if (b.action === "query") {
      const upstream = b.upstreamId || t.upstream_id;
      ensure(upstream, "请填写已核实的上游任务 ID");
      const result = await providerRequest(
        t,
        `tasks/${encodeURIComponent(upstream)}`,
      );
      ensure(
        result.ok && result.data.output?.task_id === upstream,
        "上游查询失败或 ID 不一致",
      );
      ensure(
        !t.upstream_id || t.upstream_id === upstream,
        "不能改绑已有上游任务",
      );
      ensure(
        !(
          await db.query(
            "SELECT id FROM tasks WHERE upstream_id=$1 AND id<>$2",
            [upstream, t.id],
          )
        ).length,
        "该上游任务已关联其他记录",
      );
      const bound = await db.query(
        "UPDATE tasks SET upstream_id=$2 WHERE id=$1 AND settlement='reserved' AND (upstream_id IS NULL OR upstream_id=$2) RETURNING id",
        [t.id, upstream],
      );
      ensure(bound.length, "任务已由其他操作处理，请重新载入", 409);
      if (result.data.output.task_status === "SUCCEEDED")
        await settleSuccess(t.id, result.data);
      else if (["FAILED", "CANCELED"].includes(result.data.output.task_status))
        await transaction(async (tx) => {
          const [fresh] = await tx.query(
            "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
            [t.id],
          );
          ensure(fresh.settlement === "reserved", "任务已结算，不可改写状态");
          ensure(fresh.upstream_id === upstream, "上游绑定已变化", 409);
          await releaseTask(
            tx,
            fresh,
            result.data.output.task_status,
            "管理员核实上游终态，冻结已退回",
          );
        });
      else
        await db.query(
          "UPDATE tasks SET status=$2,next_poll=now() WHERE id=$1 AND settlement='reserved'",
          [t.id, result.data.output.task_status],
        );
    } else if (b.action === "release")
      await transaction(async (tx) => {
        const [fresh] = await tx.query(
          "SELECT * FROM tasks WHERE id=$1 FOR UPDATE",
          [t.id],
        );
        ensure(
          ["UNKNOWN", "RECONCILE"].includes(fresh.status),
          "仅待核实任务可人工释放",
        );
        await releaseTask(tx, fresh, "FAILED", `管理员核实：${b.reason}`);
      });
    else if (b.action === "settle") {
      ensure(
        t.status === "RECONCILE" && t.settlement === "reserved" && t.result_url,
        "当前任务没有可核实的成功结果",
      );
      ensure(
        b.inputSeconds !== undefined && b.outputSeconds !== undefined,
        "请填写核实后的输入与输出秒数",
      );
      const duration = b.inputSeconds + b.outputSeconds;
      ensure(
        duration <= 30 &&
          Math.round(duration * Number(t.price_micro)) <=
            Number(t.reserve_micro),
        "核实用量超过授权冻结上限",
      );
      await settleSuccess(t.id, {
        ...t.provider_response,
        output: { ...t.provider_response?.output, video_url: t.result_url },
        usage: {
          ...t.usage,
          video_count: 1,
          input_video_duration: b.inputSeconds,
          output_video_duration: b.outputSeconds,
          duration,
          SR: t.resolution.replace("P", ""),
        },
      });
    } else {
      ensure(b.actualCost !== undefined, "请填写实际成本");
      await db.query("UPDATE tasks SET actual_cost_micro=$2 WHERE id=$1", [
        t.id,
        micro(b.actualCost),
      ]);
    }
    await audit(req.user.id, `reconcile_${b.action}`, t.id, b);
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/settings",
  asyncRoute(async (req, res) => {
    const current = await settings();
    const payment = {
      ...(current.payment || {}),
      key: current.payment?.key ? PAYMENT_KEY_MASK : "",
      alipayPrivateKey: current.payment?.alipayPrivateKey
        ? PAYMENT_KEY_MASK
        : "",
      alipayPublicKey: current.payment?.alipayPublicKey ? PAYMENT_KEY_MASK : "",
    };
    res.json({
      ...current,
      payment,
      services: {
        storage: oss ? "北京 OSS" : "本地存储",
        mail: !!config.smtp.host,
        database: config.databaseUrl ? "PostgreSQL" : "内嵌 PostgreSQL（本地）",
        publicBase: config.publicBase,
        region: "华北2（北京）",
      },
    });
  }),
);
adminRouter.patch(
  "/settings",
  asyncRoute(async (req, res) => {
    const paymentSchema = z
      .object({
        enabled: z.boolean().optional(),
        gatewayUrl: z.string().trim().max(500).optional(),
        pid: z.string().trim().max(80).optional(),
        key: z.string().max(256).optional(),
        paymentType: z.enum(["alipay", "wxpay", "qqpay"]).optional(),
        notifyUrl: z.string().trim().max(500).optional(),
        returnUrl: z.string().trim().max(500).optional(),
        minRecharge: z.number().positive().max(100000).optional(),
        maxRecharge: z.number().positive().max(1000000).optional(),
        dailyLimit: z.number().nonnegative().max(10000000).optional(),
        balanceRate: z.number().positive().max(1000).optional(),
        renewalRate: z.number().positive().max(1000).optional(),
        subscriptionRate: z.number().positive().max(1000).optional(),
        renewalFeeRate: z.number().positive().max(1000).optional(),
        orderTimeout: z.number().int().min(1).max(1440).optional(),
        orderTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
        maxPendingOrders: z.number().int().min(1).max(100).optional(),
        qrEnabled: z.boolean().optional(),
        productPrefix: z.string().trim().max(80).optional(),
        productSuffix: z.string().trim().max(80).optional(),
        provider: z.string().trim().max(40).optional(),
        alipayAppId: z.string().trim().max(200).optional(),
        alipayPrivateKey: z.string().max(10000).optional(),
        alipayPublicKey: z.string().max(10000).optional(),
        planName: z.string().trim().min(1).max(100).optional(),
        planPrice: z.number().positive().max(100000).optional(),
        planDays: z.number().int().min(1).max(3650).optional(),
      })
      .optional();
    const b = z
      .object({
        siteName: z.string().min(1).max(30).optional(),
        terms: z.string().max(20000).optional(),
        supportEmail: z.string().email().optional().or(z.literal("")),
        registrationOpen: z.boolean().optional(),
        emailVerification: z.boolean().optional(),
        maintenance: z.boolean().optional(),
        concurrentPerUser: z.number().int().min(1).max(20).optional(),
        storageLimitGB: z.number().positive().max(1000).optional(),
        retentionDays: z.literal(30).optional(),
        defaultApiDailyLimit: z.number().positive().max(1e6).optional(),
        defaultApiMonthlyLimit: z.number().positive().max(1e7).optional(),
        unknownAlertHours: z.number().min(1).max(24).optional(),
        payment: paymentSchema,
      })
      .parse(req.body);
    const current = await settings();
    const submittedPayment = b.payment || {};
    const submittedKey = submittedPayment.key;
    const submittedAlipayPrivateKey = submittedPayment.alipayPrivateKey;
    const submittedAlipayPublicKey = submittedPayment.alipayPublicKey;
    const payment = {
      ...current.payment,
      ...submittedPayment,
      key:
        submittedKey && submittedKey !== PAYMENT_KEY_MASK
          ? submittedKey
          : current.payment?.key || "",
      alipayPrivateKey:
        submittedAlipayPrivateKey &&
        submittedAlipayPrivateKey !== PAYMENT_KEY_MASK
          ? submittedAlipayPrivateKey
          : current.payment?.alipayPrivateKey || "",
      alipayPublicKey:
        submittedAlipayPublicKey &&
        submittedAlipayPublicKey !== PAYMENT_KEY_MASK
          ? submittedAlipayPublicKey
          : current.payment?.alipayPublicKey || "",
    };
    const next = {
      ...current,
      ...b,
      payment,
    };
    ensure(
      !next.emailVerification || config.smtp.host,
      "启用邮箱验证前请配置邮件服务",
    );
    if (payment.enabled) {
      ensure(
        payment.gatewayUrl && payment.pid && payment.key,
        "启用支付前请完整配置易支付参数",
      );
      ensure(
        /^https?:\/\//i.test(payment.gatewayUrl),
        "易支付网关地址必须使用 HTTP(S)",
      );
    }
    ensure(
      Number(payment.maxRecharge || 0) >= Number(payment.minRecharge || 0),
      "最高充值金额不能低于最低充值金额",
    );
    const auditPayment = {
      ...payment,
      key: payment.key ? PAYMENT_KEY_MASK : "",
      alipayPrivateKey: payment.alipayPrivateKey ? PAYMENT_KEY_MASK : "",
      alipayPublicKey: payment.alipayPublicKey ? PAYMENT_KEY_MASK : "",
    };
    await transaction(async (tx) => {
      await tx.query(
        "UPDATE settings SET value=$1,version=version+1 WHERE id=1",
        [JSON.stringify(next)],
      );
      await audit(
        req.user.id,
        "update_settings",
        "system",
        { ...next, payment: auditPayment },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/announcements",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT a.*,(SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id=a.id AND r.version=a.version) AS read_count FROM announcements a ORDER BY a.pinned DESC,a.sort,a.created_at DESC",
      ),
    );
  }),
);
const announcementSchema = z.object({
  display_mode: z.enum(["banner", "silent"]).default("banner"),
  sort: z.number().int().min(-10000).max(10000).default(0),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(20000),
  level: z.enum(["normal", "important"]),
  audience: z.enum(["all", "admin", "user"]),
  published: z.boolean(),
  pinned: z.boolean(),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime().nullable(),
});
adminRouter.post(
  "/announcements",
  asyncRoute(async (req, res) => {
    const b = announcementSchema.parse(req.body);
    ensure(!b.ends_at || b.ends_at > b.starts_at, "结束时间应晚于开始时间");
    const id = randomUUID();
    await db.query(
      "INSERT INTO announcements(id,title,body,level,audience,published,pinned,starts_at,ends_at,display_mode,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        b.title,
        b.body,
        b.level,
        b.audience,
        b.published,
        b.pinned,
        b.starts_at,
        b.ends_at,
        b.display_mode,
        b.sort,
      ],
    );
    await audit(req.user.id, "create_announcement", id);
    res.json({ id });
  }),
);
adminRouter.patch(
  "/announcements/:id",
  asyncRoute(async (req, res) => {
    const b = announcementSchema.parse(req.body);
    ensure(!b.ends_at || b.ends_at > b.starts_at, "结束时间应晚于开始时间");
    await db.query(
      "UPDATE announcements SET title=$2,body=$3,level=$4,audience=$5,published=$6,pinned=$7,starts_at=$8,ends_at=$9,display_mode=$10,sort=$11,version=version+1 WHERE id=$1",
      [
        req.params.id,
        b.title,
        b.body,
        b.level,
        b.audience,
        b.published,
        b.pinned,
        b.starts_at,
        b.ends_at,
        b.display_mode,
        b.sort,
      ],
    );
    await audit(req.user.id, "update_announcement", req.params.id);
    res.json({ ok: true });
  }),
);
adminRouter.get(
  "/audit",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT $1 OFFSET $2",
        pagination(req),
      ),
    );
  }),
);

// 图片价格管理
adminRouter.get(
  "/image-prices",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT * FROM image_prices WHERE deleted_at IS NULL ORDER BY model,size_category",
      ),
    );
  }),
);

const imagePriceValuesSchema = z.object({
  input_official: z.number().min(0).max(1000),
  input_sale: z.number().min(0).max(1000),
  output_official: z.number().min(0.000001).max(1000),
  output_sale: z.number().min(0.000001).max(1000),
  enabled: z.boolean(),
});
const imagePriceCreateSchema = imagePriceValuesSchema
  .extend({
    model: modelIdSchema.refine(
      (model) => Boolean(MODEL_CAPABILITIES[model]),
      "图片模型未接入",
    ),
    size_category: z.enum(IMAGE_SIZE_CATEGORIES),
  })
  .superRefine((value, context) => {
    const capability = MODEL_CAPABILITIES[value.model];
    if (!capability) return;
    if (
      IMAGE_SIZE_CATEGORIES.indexOf(value.size_category) >
      IMAGE_SIZE_CATEGORIES.indexOf(capability.maxSize)
    )
      context.addIssue({
        code: "custom",
        path: ["size_category"],
        message: `该模型最大支持 ${capability.maxSize}`,
      });
  });

const channelCreateSchema = z
  .object({
    provider: z.enum(["bailian", "openai"]),
    name: z.string().trim().min(1).max(100),
    workspace: z.string().trim().max(200).optional(),
    baseUrl: z.string().trim().max(500).optional(),
    key: z.string().trim().min(1).max(500),
    models: z.array(z.string()).min(1),
    accountGroup: z.string().trim().max(100).optional(),
    multiplier: z.number().min(0).max(100).default(1),
    budget: z.number().min(0).max(1e9).default(0),
    concurrency: z.number().int().min(1).max(5).default(5),
    priority: z.number().int().min(-100).max(100).default(0),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const videoModels = value.models.filter((model) =>
      (MODEL_IDS as readonly string[]).includes(model),
    );
    const imageModels = value.models.filter((model) =>
      (IMAGE_MODEL_IDS as readonly string[]).includes(model),
    );
    const openAiModels = imageModels.filter((model) =>
      model.startsWith("gpt-image-"),
    );
    const qwenModels = imageModels.filter((model) =>
      model.startsWith("qwen-image-"),
    );
    if (videoModels.length + imageModels.length !== value.models.length)
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "包含暂不支持的模型",
      });
    if (value.provider === "bailian" && openAiModels.length)
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "OpenAI 模型不能配置到百炼渠道",
      });
    if (
      value.provider === "openai" &&
      (videoModels.length || qwenModels.length)
    )
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "OpenAI 渠道仅支持 GPT 图片模型",
      });
    if (value.provider === "bailian" && !value.workspace)
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "请输入百炼 Workspace ID",
      });
    if (value.provider === "openai") {
      try {
        const url = new URL(value.baseUrl || "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("invalid base URL");
      } catch {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "请输入有效的 HTTP(S) Base URL",
        });
      }
    }
  });

adminRouter.get(
  "/channels",
  asyncRoute(async (_req, res) => {
    const [video, images, language] = await Promise.all([
      db.query(
        "SELECT c.id,c.name,c.workspace,c.models,c.priority,c.enabled,c.created_at,'video' AS source,'bailian' AS provider,COALESCE(count(t.id),0)::int AS calls,COALESCE(sum(t.cost_micro),0) AS cost_micro FROM credentials c LEFT JOIN tasks t ON t.credential_id=c.id GROUP BY c.id ORDER BY c.created_at DESC",
      ),
      db.query(
        "SELECT id,name,provider,workspace,base_url,priority,enabled,created_at,'image' AS source,metadata FROM image_credentials WHERE deleted=false ORDER BY created_at DESC",
      ),
      db.query(
        "SELECT id,name,base_url,models,model_mapping,priority,enabled,created_at,'language' AS source,'language' AS provider FROM language_channels WHERE deleted_at IS NULL ORDER BY created_at DESC",
      ),
    ]);
    const channels: Array<Record<string, any>> = [
      ...language,
      ...video,
      ...images.map((channel) => ({
        ...channel,
        provider: channel.provider === "qwen" ? "bailian" : "openai",
        models: channel.metadata?.models || [],
      })),
    ];
    res.json(
      channels.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    );
  }),
);

adminRouter.post(
  "/channels",
  asyncRoute(async (req, res) => {
    const b = channelCreateSchema.parse(req.body);
    const apiKey = b.key;
    const secret = encrypt(apiKey);
    const videoModels = b.models.filter((model) =>
      (MODEL_IDS as readonly string[]).includes(model),
    );
    const imageModels = b.models.filter((model) =>
      (IMAGE_MODEL_IDS as readonly string[]).includes(model),
    );
    const videoId = videoModels.length ? randomUUID() : null;
    const imageId = imageModels.length ? randomUUID() : null;
    const accountGroup = b.accountGroup || b.workspace || b.name;

    await transaction(async (tx) => {
      if (videoId) {
        await tx.query(
          "INSERT INTO credentials(id,name,account_group,workspace,secret,enabled,models,multiplier,priority,concurrency,budget_micro) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            videoId,
            b.name,
            accountGroup,
            b.workspace,
            secret,
            b.enabled,
            JSON.stringify(videoModels),
            b.multiplier,
            b.priority,
            b.concurrency,
            micro(b.budget),
          ],
        );
        await tx.query(
          "INSERT INTO credential_versions(credential_id,version,secret,workspace) VALUES($1,1,$2,$3)",
          [videoId, secret, b.workspace],
        );
      }
      if (imageId) {
        const provider = b.provider === "bailian" ? "qwen" : "openai";
        const workspace = provider === "qwen" ? b.workspace : null;
        const baseUrl = provider === "openai" ? b.baseUrl : null;
        await tx.query(
          "INSERT INTO image_credentials(id,provider,name,workspace,base_url,encrypted_key,key_version,priority,enabled,metadata) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)",
          [
            imageId,
            provider,
            b.name,
            workspace || null,
            baseUrl || null,
            secret,
            b.priority,
            b.enabled,
            JSON.stringify({ models: imageModels }),
          ],
        );
        await tx.query(
          "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url) VALUES($1,1,$2,$3,$4)",
          [imageId, secret, workspace || null, baseUrl || null],
        );
      }
      for (const model of videoModels)
        await tx.query(
          "INSERT INTO model_channels(model,channel_id,source,upstream_model) SELECT model,$2,'video',model FROM model_catalog WHERE model=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING",
          [model, videoId],
        );
      for (const model of imageModels)
        await tx.query(
          "INSERT INTO model_channels(model,channel_id,source,upstream_model) SELECT model,$2,'image',model FROM model_catalog WHERE model=$1 AND deleted_at IS NULL ON CONFLICT DO NOTHING",
          [model, imageId],
        );
      const { key, ...detail } = b;
      await audit(
        req.user.id,
        "create_channel",
        videoId || imageId,
        { ...detail, videoId, imageId },
        tx,
      );
    });
    res.json({ videoId, imageId });
  }),
);

adminRouter.post(
  "/image-prices",
  asyncRoute(async (req, res) => {
    const b = imagePriceCreateSchema.parse(req.body);
    await transaction(async (tx) => {
      await ensureModel(b.model, "image", tx, true, true);
      const [existing] = await tx.query(
        "SELECT id FROM image_prices WHERE model=$1 AND size_category=$2 AND deleted_at IS NULL",
        [b.model, b.size_category],
      );
      ensure(!existing, "该模型尺寸分类已有定价，请修改现有定价", 409);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO image_prices(id,model,size_category,input_official_micro,input_sale_micro,output_official_micro,output_sale_micro,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          b.model,
          b.size_category,
          micro(b.input_official),
          micro(b.input_sale),
          micro(b.output_official),
          micro(b.output_sale),
          b.enabled,
        ],
      );
      await audit(req.user.id, "create_image_price", id, b, tx);
    });
    res.json({ ok: true });
  }),
);

adminRouter.patch(
  "/image-prices/:id",
  asyncRoute(async (req, res) => {
    const b = imagePriceValuesSchema.parse(req.body);
    await transaction(async (tx) => {
      const [price] = await tx.query(
        "UPDATE image_prices SET input_official_micro=$2,input_sale_micro=$3,output_official_micro=$4,output_sale_micro=$5,enabled=$6,version=version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING *",
        [
          req.params.id,
          micro(b.input_official),
          micro(b.input_sale),
          micro(b.output_official),
          micro(b.output_sale),
          b.enabled,
        ],
      );
      ensure(price, "定价不存在", 404);
      await audit(
        req.user.id,
        "update_image_price",
        price.id,
        {
          model: price.model,
          size_category: price.size_category,
          version: price.version,
          ...b,
        },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  "/image-prices/:id",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [price] = await tx.query(
        "UPDATE image_prices SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING model,size_category",
        [req.params.id],
      );
      ensure(price, "定价不存在", 404);
      await audit(
        req.user.id,
        "delete_image_price",
        req.params.id,
        { model: price.model, size_category: price.size_category },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);

// 图片渠道管理
adminRouter.get(
  "/image-credentials",
  asyncRoute(async (req, res) => {
    const rows = await db.query(
      "SELECT id,provider,name,workspace,base_url,priority,enabled,created_at,updated_at FROM image_credentials WHERE deleted=false ORDER BY created_at DESC",
    );
    res.json(rows);
  }),
);

const imageCredentialSchema = z
  .object({
    provider: z.enum(["qwen", "openai"]),
    name: z.string().trim().min(1).max(100),
    workspace: z.string().trim().max(200).optional(),
    baseUrl: z.string().trim().max(500).optional(),
    key: z.string().max(500).optional(),
    priority: z.number().int().min(-100).max(100).default(0),
    enabled: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.provider === "qwen" && !value.workspace) {
      context.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "Qwen 渠道需要 WorkspaceId",
      });
    }
    if (value.provider === "openai") {
      try {
        const url = new URL(value.baseUrl || "");
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("invalid base URL");
      } catch {
        context.addIssue({
          code: "custom",
          path: ["baseUrl"],
          message: "请输入有效的 HTTP(S) Base URL",
        });
      }
    }
  });

adminRouter.post(
  "/image-credentials",
  asyncRoute(async (req, res) => {
    const b = imageCredentialSchema.parse(req.body);
    const apiKey = b.key?.trim();
    ensure(apiKey, "请输入 API Key");
    const id = randomUUID();
    const secret = encrypt(apiKey);
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO image_credentials(id,provider,name,workspace,base_url,encrypted_key,key_version,priority,enabled,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          b.provider,
          b.name,
          b.workspace || null,
          b.baseUrl || null,
          secret,
          1,
          b.priority,
          b.enabled,
          JSON.stringify({}),
        ],
      );
      await tx.query(
        "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url) VALUES($1,1,$2,$3,$4)",
        [id, secret, b.workspace || null, b.baseUrl || null],
      );
      const { key, ...detail } = b;
      await audit(req.user.id, "create_image_credential", id, detail, tx);
    });
    res.json({ id });
  }),
);

adminRouter.patch(
  "/image-credentials/:id",
  asyncRoute(async (req, res) => {
    const b = imageCredentialSchema.parse(req.body);
    await transaction(async (tx) => {
      const [c] = await tx.query(
        "SELECT id,encrypted_key,key_version FROM image_credentials WHERE id=$1 AND deleted=false",
        [req.params.id],
      );
      ensure(c, "渠道不存在", 404);
      const changed = !!b.key?.trim();
      const keyVersion = c.key_version + 1;
      const secret = changed ? encrypt(b.key!.trim()) : c.encrypted_key;
      await tx.query(
        "UPDATE image_credentials SET provider=$2,name=$3,workspace=$4,base_url=$5,encrypted_key=$6,key_version=$7,priority=$8,enabled=$9,updated_at=now() WHERE id=$1",
        [
          c.id,
          b.provider,
          b.name,
          b.workspace || null,
          b.baseUrl || null,
          secret,
          keyVersion,
          b.priority,
          b.enabled,
        ],
      );
      await tx.query(
        "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url) VALUES($1,$2,$3,$4,$5)",
        [c.id, keyVersion, secret, b.workspace || null, b.baseUrl || null],
      );
      const { key, ...detail } = b;
      await audit(
        req.user.id,
        "update_image_credential",
        c.id,
        { ...detail, key_changed: changed },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);

adminRouter.delete(
  "/image-credentials/:id",
  asyncRoute(async (req, res) => {
    await transaction(async (tx) => {
      const [c] = await tx.query(
        "UPDATE image_credentials SET deleted=true,updated_at=now() WHERE id=$1 AND deleted=false RETURNING name",
        [req.params.id],
      );
      ensure(c, "渠道不存在", 404);
      await audit(
        req.user.id,
        "delete_image_credential",
        req.params.id,
        { name: c.name },
        tx,
      );
    });
    res.json({ ok: true });
  }),
);
