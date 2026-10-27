import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Row } from "./db";
import { asyncRoute, ensure, hash, sign } from "./security";
import {
  generationSchema,
  validateGeneration,
  type GenerationInput,
  type MediaMeta,
} from "../shared/wan";
import { getOwnedAsset } from "./assets";
import { charge, yuan } from "./finance";
import { prepareGeneration, submitGeneration } from "./generations";
import { frameAssetFor } from "./frames";

const dependencyTypeSchema = z.enum([
  "first_frame",
  "last_frame",
  "reference_video",
]);
type DependencyType = z.infer<typeof dependencyTypeSchema>;
const dependencyBindingSchema = z.object({
  source: z.string().min(1).max(100),
  type: dependencyTypeSchema,
});

const stepsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(100),
      input: generationSchema,
      dependencies: z.array(z.string()).max(20).default([]),
      dependency_types: z.record(dependencyTypeSchema).default({}),
      dependency_bindings: z.array(dependencyBindingSchema).max(20).default([]),
    }),
  )
  .min(1)
  .max(30);
export function orderSteps<
  T extends {
    id: string;
    dependencies: string[];
    dependency_types?: Record<string, DependencyType>;
    dependency_bindings?: Array<{ source: string; type: DependencyType }>;
  },
>(steps: T[]): T[] {
  const ids = new Set(steps.map((s) => s.id));
  ensure(ids.size === steps.length, "节点编号重复");
  for (const step of steps) {
    ensure(
      new Set(step.dependencies).size === step.dependencies.length,
      "依赖节点重复",
    );
    ensure(
      Object.keys(step.dependency_types || {}).every((id) =>
        step.dependencies.includes(id),
      ),
      "依赖连接点无对应节点",
    );
    for (const binding of step.dependency_bindings || [])
      ensure(
        step.dependencies.includes(binding.source),
        "依赖连接点无对应节点",
      );
  }
  const done = new Set<string>();
  const ordered: T[] = [];
  while (ordered.length < steps.length) {
    const ready = steps.filter(
      (s) => !done.has(s.id) && s.dependencies.every((d) => done.has(d)),
    );
    ensure(ready.length, "连线存在环路或缺少依赖节点");
    for (const s of ready) {
      done.add(s.id);
      ordered.push(s);
    }
  }
  return ordered;
}

export function dependencyTypeFor(
  step: { dependency_types?: Record<string, DependencyType> },
  sourceId: string,
): DependencyType {
  return step.dependency_types?.[sourceId] || "reference_video";
}

export function dependencyBindingsFor(step: {
  dependencies?: string[];
  dependency_types?: Record<string, DependencyType>;
  dependency_bindings?: Array<{ source: string; type: DependencyType }>;
}) {
  if (step.dependency_bindings?.length) return step.dependency_bindings;
  return (step.dependencies || []).map((source) => ({
    source,
    type: dependencyTypeFor(step, source),
  }));
}

function dependencyPlaceholder(
  type: DependencyType,
  upstream: GenerationInput,
): { media: GenerationInput["input"]["media"][number]; meta: MediaMeta } {
  const duration = upstream.parameters.duration;
  if (type === "reference_video") {
    ensure(
      duration >= 2 && duration <= 15,
      "参考视频依赖须指定 2-15 秒输出；智能时长请单独生成后裁剪复用",
    );
    return {
      media: { type, url: "https://dependency.invalid/video.mp4" },
      meta: {
        kind: "video",
        duration,
        width: 1920,
        height: 1080,
        fps: 30,
        size: 1,
      },
    };
  }
  return {
    media: { type, url: "https://dependency.invalid/frame.jpg" },
    meta: {
      kind: "image",
      width: 1920,
      height: 1080,
      hasAlpha: false,
      size: 1,
    },
  };
}
import { refreshModelAdapters } from "./catalog";
export const workflowRouter = Router();
workflowRouter.use(async (_req, _res, next) => {
  try {
    await refreshModelAdapters();
    next();
  } catch (error) {
    next(error);
  }
});
workflowRouter.post(
  "/quote",
  asyncRoute(async (req, res) => {
    const b = z
      .object({ project_id: z.string().uuid(), steps: stepsSchema })
      .parse(req.body);
    ensure(
      (
        await db.query(
          "SELECT id FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
          [b.project_id, req.user.id],
        )
      ).length,
      "画布不存在",
      404,
    );
    const steps = [];
    for (const s of orderSteps(b.steps)) {
      const normalized = await prepareGeneration(s.input, req.user.id, {
        deferValidation: s.dependencies.length > 0,
      });
      s.input = normalized.input;
      const input = structuredClone(normalized.input);
      const meta: (MediaMeta | undefined)[] = [];
      for (const m of input.input.media) {
        if (m.asset_id) {
          const a = await getOwnedAsset(m.asset_id, req.user.id);
          meta.push({ ...a.metadata, kind: a.kind, size: Number(a.size) });
        } else meta.push(m.type === "link" ? { kind: "link" } : undefined);
      }
      for (const binding of dependencyBindingsFor(s)) {
        const upstream = b.steps.find((x) => x.id === binding.source)!;
        const placeholder = dependencyPlaceholder(binding.type, upstream.input);
        input.input.media.push(placeholder.media);
        meta.push(placeholder.meta);
      }
      validateGeneration(input, meta as MediaMeta[]);
      steps.push({
        ...s,
        price_id: normalized.price.id,
        price_version: normalized.price.version,
        max_micro: charge(normalized.price.sale_micro, 30),
        state: "WAITING",
      });
    }
    const payload = Buffer.from(
      JSON.stringify({
        user: req.user.id,
        project_id: b.project_id,
        steps,
        expires: Date.now() + 300000,
      }),
    ).toString("base64url");
    res.json({
      token: `${payload}.${sign(payload)}`,
      maximum: yuan(steps.reduce((n, s) => n + s.max_micro, 0)),
      count: steps.length,
    });
  }),
);
workflowRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "批次执行需网页登录", 403);
    const [payload, sig] = z
      .string()
      .max(2_000_000)
      .parse(req.body.token)
      .split(".");
    ensure(payload && sign(payload) === sig, "批次报价无效");
    const q = JSON.parse(Buffer.from(payload, "base64url").toString());
    ensure(q.user === req.user.id && q.expires > Date.now(), "批次报价已过期");
    const [run] = await db.query(
      "INSERT INTO workflow_runs(id,user_id,project_id,steps,request_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,request_key) WHERE request_key IS NOT NULL DO UPDATE SET request_key=EXCLUDED.request_key RETURNING id",
      [
        randomUUID(),
        req.user.id,
        q.project_id,
        JSON.stringify(q.steps),
        hash(req.body.token),
      ],
    );
    res.status(202).json({ id: run.id });
  }),
);
workflowRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT * FROM workflow_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
        [req.user.id],
      ),
    );
  }),
);
workflowRouter.post(
  "/:id/stop",
  asyncRoute(async (req, res) => {
    await db.query(
      "UPDATE workflow_runs SET status='STOPPED',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='RUNNING'",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true });
  }),
);
export async function runWorkflows() {
  const runs = await db.query(
    "SELECT * FROM workflow_runs WHERE status='RUNNING' ORDER BY created_at LIMIT 20",
  );
  for (const run of runs) {
    const steps = run.steps as Row[];
    let status = "RUNNING";
    let error: string | null = null;
    try {
      const [user] = await db.query(
        "SELECT * FROM users WHERE id=$1 AND NOT disabled",
        [run.user_id],
      );
      ensure(user, "账号不可用");
      for (const step of steps) {
        if (step.state === "DONE") continue;
        if (step.task_id) {
          const [t] = await db.query("SELECT * FROM tasks WHERE id=$1", [
            step.task_id,
          ]);
          ensure(t, "前序任务记录不存在，批次已停止");
          if (t?.status === "SUCCEEDED") {
            ensure(t.result_asset_id, "前序任务没有视频结果，批次已停止");
            step.state = "DONE";
            step.asset_id = t.result_asset_id;
          } else if (
            [
              "FAILED",
              "CANCELED",
              "UNKNOWN",
              "RECONCILE",
              "DELIVERY_FAILED",
            ].includes(t?.status)
          ) {
            throw new Error("前序任务未完成，批次已停止。已提交任务保留。");
          }
          continue;
        }
        if (
          !step.dependencies.every(
            (id: string) => steps.find((s) => s.id === id)?.state === "DONE",
          )
        )
          continue;
        const input = structuredClone(step.input);
        input.project_id = run.project_id;
        input.node_id = step.id;
        for (const binding of dependencyBindingsFor(step)) {
          const source = steps.find((s) => s.id === binding.source)!;
          ensure(source?.asset_id, "前序任务没有视频结果，批次已停止");
          const type = binding.type;
          const assetId =
            type === "reference_video"
              ? source.asset_id
              : (await frameAssetFor(source.asset_id, run.user_id, type)).id;
          input.input.media.push({
            type,
            asset_id: assetId,
          });
        }
        const q = await prepareGeneration(input, run.user_id);
        ensure(
          q.price.id === step.price_id &&
            (step.price_version === undefined ||
              q.price.version === step.price_version),
          "价格版本已变化，请重新确认批次",
        );
        ensure(q.reserve <= step.max_micro, "实际预算超出确认上限");
        const payload = Buffer.from(
          JSON.stringify({
            user: run.user_id,
            body: hash(JSON.stringify(q.input)),
            price: q.price.id,
            priceVersion: q.price.version,
            expires: Date.now() + 300000,
            reserve: q.reserve,
            multiplier: q.multiplier,
          }),
        ).toString("base64url");
        const task = await submitGeneration(
          user,
          undefined,
          q.input,
          `${payload}.${sign(payload)}`,
          `workflow:${run.id}:${step.id}`,
          run.id,
        );
        step.task_id = task.id;
        step.state = "SUBMITTED";
        // Persist each submission before proceeding; idempotency makes crash recovery safe.
        await db.query(
          "UPDATE workflow_runs SET steps=$2,updated_at=now() WHERE id=$1",
          [run.id, JSON.stringify(steps)],
        );
      }
      if (steps.every((s) => s.state === "DONE")) status = "SUCCEEDED";
    } catch (e) {
      status = "STOPPED";
      error = e instanceof Error ? e.message : "批次执行中断";
    }
    await db.query(
      "UPDATE workflow_runs SET steps=$2,status=CASE WHEN status='STOPPED' THEN status ELSE $3 END,error=$4,updated_at=now() WHERE id=$1",
      [run.id, JSON.stringify(steps), status, error],
    );
  }
}
