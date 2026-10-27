import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {
  validateGeneration,
  DEFAULT_PARAMETERS,
  MODEL_IDS,
  RESOLUTIONS,
  RATIOS,
  mediaReferenceLabels,
} from "../shared/wan";

const sample = (extra: any = {}) => ({
  model: "wan3.0-video",
  mode: "text",
  input: { prompt: "测试画面", media: [] },
  parameters: { ...DEFAULT_PARAMETERS },
  ...extra,
});
test("Wan complete parameter matrix and boundaries", () => {
  for (const model of MODEL_IDS)
    for (const resolution of RESOLUTIONS)
      for (const ratio of RATIOS)
        for (const duration of [-1, 2, 5, 30])
          assert.equal(
            validateGeneration(
              sample({
                model,
                parameters: {
                  ...DEFAULT_PARAMETERS,
                  resolution,
                  ratio,
                  duration,
                },
              }),
            ).data.model,
            model,
          );
  for (const duration of [0, 1, 31, 2.5])
    assert.throws(() =>
      validateGeneration(
        sample({ parameters: { ...DEFAULT_PARAMETERS, duration } }),
      ),
    );
  for (const seed of [-2, 2147483648])
    assert.throws(() =>
      validateGeneration(
        sample({ parameters: { ...DEFAULT_PARAMETERS, seed } }),
      ),
    );
  assert.throws(() =>
    validateGeneration(
      sample({ parameters: { ...DEFAULT_PARAMETERS, negative_prompt: "x" } }),
    ),
  );
  assert.throws(() =>
    validateGeneration(sample({ input: { prompt: "", media: [] } })),
  );
  assert.throws(() =>
    validateGeneration(
      sample({ input: { prompt: "字".repeat(20001), media: [] } }),
    ),
  );
  const image = {
    kind: "image",
    width: 1024,
    height: 768,
    size: 1000,
    hasAlpha: false,
  };
  const first = { type: "first_frame", asset_id: randomUUID() };
  const last = { type: "last_frame", asset_id: randomUUID() };
  assert.equal(
    validateGeneration(
      sample({ mode: "frames", input: { prompt: "", media: [first, last] } }),
      [image, image],
    ).estimatedDuration,
    5,
  );
  assert.throws(() =>
    validateGeneration(
      sample({ mode: "frames", input: { prompt: "", media: [last] } }),
      [image],
    ),
  );
  assert.throws(() =>
    validateGeneration(
      sample({ mode: "first", input: { prompt: "", media: [first] } }),
      [{ ...image, hasAlpha: true }],
    ),
  );
  const video = {
    kind: "video",
    width: 1920,
    height: 1080,
    size: 1000,
    duration: 15,
    fps: 30,
  };
  const media = [{ type: "reference_video", asset_id: randomUUID() }];
  assert.equal(
    validateGeneration(
      sample({
        mode: "extend",
        input: { prompt: "延长视频1", media },
        parameters: { ...DEFAULT_PARAMETERS, duration: 15 },
      }),
      [video],
    ).estimatedDuration,
    30,
  );
  assert.throws(() =>
    validateGeneration(
      sample({
        mode: "reference",
        input: { prompt: "x", media },
        parameters: { ...DEFAULT_PARAMETERS, duration: 16 },
      }),
      [video],
    ),
  );
  assert.throws(() =>
    validateGeneration(
      sample({ mode: "reference", input: { prompt: "x", media } }),
      [{ ...video, fps: 15 }],
    ),
  );
  assert.deepEqual(
    mediaReferenceLabels([
      { type: "reference_image" },
      { type: "reference_video" },
      { type: "reference_image" },
      { type: "reference_audio" },
    ]),
    ["图1", "视频1", "图2", "音频1"],
  );
});

test("isolated database and HTTP integration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinite-canvas-test-"));
  process.env.DATA_DIR = dir;
  process.env.PORT = "4021";
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://localhost:5173";
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main");
  const { db, transaction, closeDb } = await import("../server/db");
  const { charge, micro, publicTask, walletEntry } =
    await import("../server/finance");
  const { hash, apiKeyAllowsModel } = await import("../server/security");
  const {
    settleSuccess,
    dispatchOne,
    pollTasks,
    saveResults,
    submitGeneration,
  } = await import("../server/generations");
  const { cleanupAssets, inspect, processExports } =
    await import("../server/assets");
  const { consumeCode } = await import("../server/auth");
  const { orderSteps, runWorkflows } = await import("../server/workflows");
  const { localSignedUrl } = await import("../server/storage");
  const base = "http://127.0.0.1:4021/api/v1";
  let cookie = "";
  const request = async (
    p: string,
    body?: any,
    method = body === undefined ? "GET" : "POST",
    auth = cookie,
  ) => {
    const r = await fetch(base + p, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        ...(auth.startsWith("Bearer ")
          ? { Authorization: auth }
          : { Cookie: auth }),
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    return { status: r.status, data, headers: r.headers };
  };
  let admin: any,
    user: any,
    key: string,
    channel: any,
    project: any,
    asset: any,
    task: any;
  try {
    await t.test("first admin, closed registration, roles", async () => {
      assert.equal((await request("/auth/config")).data.setupRequired, true);
      const r = await request("/auth/setup", {
        username: "testadmin",
        password: "test-password-123",
        display_name: "测试管理员",
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      cookie = r.headers.get("set-cookie")!.split(";")[0];
      admin = r.data.user;
      assert.equal(
        (
          await request("/auth/setup", {
            username: "other",
            password: "test-password-123",
            display_name: "其他",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/auth/register", {
            username: "closed",
            password: "test-password-123",
            display_name: "关闭",
          })
        ).status,
        403,
      );
      const u = await request("/admin/users", {
        username: "testuser",
        password: "user-password-123",
        display_name: "测试用户",
      });
      assert.equal(u.status, 200);
      user = u.data;
      assert.equal(
        (
          await request("/admin/users", {
            username: "eightpwd",
            password: "12345678",
            display_name: "八位密码",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request("/admin/users", {
            username: "sevenpwd",
            password: "1234567",
            display_name: "七位密码",
          })
        ).status,
        400,
      );
    });
    await t.test("six original price tiers, precision", async () => {
      const m = await request("/models");
      assert.equal(m.data.prices.length, 6);
      assert.equal(charge(micro(0.3), 0.1), 30000);
      assert.deepEqual(
        m.data.prices
          .map((p: any) => p.sale)
          .sort((a: number, b: number) => a - b),
        [0.3, 0.45, 0.6, 0.9, 1.2, 1.8],
      );
    });
    await t.test("balance idempotency and changed-body conflict", async () => {
      const b = {
        type: "recharge",
        amount: 100,
        reason: "测试入账",
        idempotencyKey: randomUUID(),
      };
      assert.equal(
        (await request(`/admin/users/${admin.id}/balance`, b)).status,
        200,
      );
      assert.equal(
        (await request(`/admin/users/${admin.id}/balance`, b)).status,
        200,
      );
      assert.equal(
        (
          await request(`/admin/users/${admin.id}/balance`, {
            ...b,
            amount: 101,
          })
        ).status,
        409,
      );
      assert.equal((await request("/wallet")).data.available, 100);
    });
    await t.test(
      "encrypted credentials and independent key limits",
      async () => {
        const c = await request("/admin/credentials", {
          name: "隔离测试渠道",
          account_group: "test-owner",
          workspace: "test-workspace",
          key: "sk-test-not-a-real-provider-key",
          multiplier: 0.5,
        });
        assert.equal(c.status, 200);
        channel = c.data;
        const k = await request("/api-keys", {
          name: "测试Key",
          dailyLimit: 100,
          monthlyLimit: 1000,
        });
        assert.equal(k.status, 201);
        key = k.data.key;
        const defaults = (
          await db.query("SELECT * FROM api_keys WHERE key_hash=$1", [
            hash(key),
          ])
        )[0];
        assert.deepEqual(defaults.models, ["*"]);
        const { apiKeyAllowsModel } = await import("../server/security");
        assert.equal(apiKeyAllowsModel(defaults, "future:image-v9"), true);
        assert.equal(apiKeyAllowsModel(undefined, "future:image-v9"), true);
        for (const models of [[], null, undefined, "*", {}]) {
          assert.equal(apiKeyAllowsModel({ models }, "future:image-v9"), false);
        }
        const scoped = await request("/api-keys", {
          name: "未来模型",
          dailyLimit: 100,
          monthlyLimit: 1000,
          models: ["new-model:alias"],
        });
        assert.equal(scoped.status, 201);
        const scopedRow = (
          await db.query("SELECT * FROM api_keys WHERE key_hash=$1", [
            hash(scoped.data.key),
          ])
        )[0];
        assert.equal(apiKeyAllowsModel(scopedRow, "new-model:alias"), true);
        assert.equal(apiKeyAllowsModel(scopedRow, "not-allowed"), false);
        assert.equal(
          (
            await request("/api-keys", {
              name: "wildcard冲突",
              dailyLimit: 100,
              monthlyLimit: 1000,
              models: ["*", "wan3.0-video"],
            })
          ).status,
          400,
        );
        assert.equal(
          (await request(`/api-keys/${scoped.data.id}`, undefined, "DELETE"))
            .status,
          200,
        );

        const [unrestricted] = await db.query(
          "SELECT * FROM api_keys WHERE key_hash=$1",
          [hash(key)],
        );
        assert.deepEqual(unrestricted.models, ["*"]);
        assert.equal(
          apiKeyAllowsModel(unrestricted, "new-image-family:model-9"),
          true,
        );
        const custom = await request("/api-keys", {
          name: "未来模型",
          dailyLimit: 100,
          monthlyLimit: 1000,
          models: ["unlisted-model:beta_4"],
        });
        assert.equal(custom.status, 201);
        const [customRecord] = await db.query(
          "SELECT * FROM api_keys WHERE key_hash=$1",
          [hash(custom.data.key)],
        );
        assert.equal(
          apiKeyAllowsModel(customRecord, "unlisted-model:beta_4"),
          true,
        );
        assert.equal(apiKeyAllowsModel(customRecord, "another-model"), false);
        assert.equal(
          (
            await request(
              "/admin/credentials",
              undefined,
              "GET",
              `Bearer ${key}`,
            )
          ).status,
          403,
        );
        assert.notEqual(
          (await request("/auth/sessions", undefined, "GET", `Bearer ${key}`))
            .status,
          200,
        );
        const rows = await request("/admin/credentials");
        assert.equal(rows.data[0].secret, undefined);
      },
    );
    await t.test("optimistic canvas versions and ownership", async () => {
      project = (await request("/projects", { name: "测试画布" })).data;
      const first = await request(
        `/projects/${project.id}`,
        { version: 1, content: { nodes: [], edges: [] } },
        "PATCH",
      );
      assert.equal(first.status, 200);
      assert.equal(
        (
          await request(
            `/projects/${project.id}`,
            { version: 1, name: "冲突" },
            "PATCH",
          )
        ).status,
        409,
      );
      const u = await request("/auth/login", {
        username: "testuser",
        password: "user-password-123",
      });
      const other = u.headers.get("set-cookie")!.split(";")[0];
      assert.equal(
        (await request(`/projects/${project.id}`, undefined, "GET", other))
          .status,
        404,
      );
      assert.equal(
        (await request("/admin/users", undefined, "GET", other)).status,
        403,
      );
    });
    await t.test("upload, signed provider URL, thumbnail, derive", async () => {
      const buffer = await sharp({
        create: { width: 256, height: 256, channels: 3, background: "#23a276" },
      })
        .png()
        .toBuffer();
      const form = new FormData();
      form.append("file", new Blob([Uint8Array.from(buffer)]), "中文素材.png");
      const r = await request("/assets/upload", form);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      asset = r.data;
      assert.equal(asset.name, "中文素材.png");
      const exp = Date.now() + 60000;
      const signed = await fetch(
        "http://127.0.0.1:4021" + localSignedUrl(asset.id, exp),
      );
      assert.equal(signed.status, 200);
      assert.equal(
        (
          await fetch(
            "http://127.0.0.1:4021" + localSignedUrl(asset.id, Date.now() - 1),
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(base + `/assets/${asset.id}/thumbnail`, {
            headers: { Cookie: cookie },
          })
        ).status,
        200,
      );
      assert.equal(
        (await request(`/assets/${asset.id}/derive`, { operation: "flatten" }))
          .status,
        200,
      );
      assert.equal(asset.metadata.width, 256);
    });
    await t.test(
      "quote normalized input, duplicate submit, frozen amount",
      async () => {
        const input = sample({ project_id: project.id });
        const quote = await request("/quotes", input);
        assert.equal(quote.status, 200, JSON.stringify(quote.data));
        const submit = async (body: any, id: string) => {
          const r = await fetch(base + "/generations", {
            method: "POST",
            headers: {
              Origin: "http://localhost:5173",
              Cookie: cookie,
              "Content-Type": "application/json",
              "Idempotency-Key": id,
            },
            body: JSON.stringify(body),
          });
          return { status: r.status, data: await r.json() };
        };
        const id = randomUUID();
        const body = { input: quote.data.input, quoteToken: quote.data.token };
        const [a, b] = await Promise.all([submit(body, id), submit(body, id)]);
        assert.equal(a.status, 202, JSON.stringify(a.data));
        assert.equal(b.data.id, a.data.id);
        task = a.data;
        assert.equal((await request("/wallet")).data.frozen, 6);
        assert.equal(a.data.cost, undefined);
        assert.equal(a.data.credential_id, undefined);
      },
    );
    await t.test(
      "success exact usage settles once with multiplier snapshot",
      async () => {
        const response = {
          output: {
            task_status: "SUCCEEDED",
            video_url: "https://example.invalid/result.mp4",
          },
          usage: {
            video_count: 1,
            duration: 4,
            input_video_duration: 0,
            output_video_duration: 4,
            SR: 1080,
          },
        };
        await settleSuccess(task.id, response);
        await settleSuccess(task.id, response);
        const [stored] = await db.query("SELECT * FROM tasks WHERE id=$1", [
          task.id,
        ]);
        assert.equal(Number(stored.charged_micro), 4_800_000);
        assert.equal(Number(stored.cost_micro), 2_400_000);
        const w = (await request("/wallet")).data;
        assert.equal(w.available, 95.2);
        assert.equal(w.frozen, 0);
        assert.equal(publicTask(stored).charged, 4.8);
      },
    );
    await t.test("refund limit, reconciliation and ledger sums", async () => {
      assert.equal(
        (
          await request(`/admin/users/${admin.id}/balance`, {
            type: "refund",
            amount: 4.8,
            taskId: task.id,
            reason: "测试调用退款",
            idempotencyKey: randomUUID(),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(`/admin/users/${admin.id}/balance`, {
            type: "refund",
            amount: 0.01,
            taskId: task.id,
            reason: "重复退款",
            idempotencyKey: randomUUID(),
          })
        ).status,
        400,
      );
      const [sum] = await db.query(
        "SELECT sum(amount) AS a,sum(frozen_delta) AS f FROM ledger WHERE user_id=$1",
        [admin.id],
      );
      const [w] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
        admin.id,
      ]);
      assert.equal(Number(w.available), Number(sum.a));
      assert.equal(Number(w.frozen), Number(sum.f));
    });
    await t.test(
      "cancel releases once and API daily limit enforces reservation",
      async () => {
        const q = (
          await request("/quotes", sample(), undefined, `Bearer ${key}`)
        ).data;
        const u = (
          await db.query("SELECT * FROM users WHERE id=$1", [admin.id])
        )[0];
        const [k] = await db.query("SELECT * FROM api_keys WHERE key_hash=$1", [
          hash(key),
        ]);
        const created = await submitGeneration(
          u,
          k,
          q.input,
          q.token,
          randomUUID(),
        );
        assert.equal(
          (await request(`/generations/${created.id}/cancel`, {})).status,
          200,
        );
        assert.equal(
          (await request(`/generations/${created.id}/cancel`, {})).status,
          400,
        );
        await db.query("UPDATE api_keys SET daily_limit=1 WHERE id=$1", [k.id]);
        await assert.rejects(
          () => submitGeneration(u, k, q.input, q.token, randomUUID()),
          /额度不足/,
        );
      },
    );
    await t.test(
      "upstream failures and uncertainty never blindly retry",
      async () => {
        const realFetch = globalThis.fetch;
        try {
          const q = (await request("/quotes", sample())).data;
          const u = (
            await db.query("SELECT * FROM users WHERE id=$1", [admin.id])
          )[0];
          const a = await submitGeneration(
            u,
            undefined,
            q.input,
            q.token,
            randomUUID(),
          );
          globalThis.fetch = (async (url: any, opts: any) =>
            String(url).includes(".maas.aliyuncs.com")
              ? new Response(
                  JSON.stringify({ code: "InvalidParameter", message: "test" }),
                  { status: 400 },
                )
              : realFetch(url, opts)) as typeof fetch;
          await dispatchOne();
          assert.equal(
            (await db.query("SELECT status FROM tasks WHERE id=$1", [a.id]))[0]
              .status,
            "FAILED",
          );
          const b = await submitGeneration(
            u,
            undefined,
            q.input,
            q.token,
            randomUUID(),
          );
          globalThis.fetch = (async (url: any, opts: any) => {
            if (String(url).includes(".maas.aliyuncs.com"))
              throw new Error("simulated lost connection");
            return realFetch(url, opts);
          }) as typeof fetch;
          await dispatchOne();
          assert.equal(
            (await db.query("SELECT status FROM tasks WHERE id=$1", [b.id]))[0]
              .status,
            "UNKNOWN",
          );
          await request(`/admin/usage/${b.id}/reconcile`, {
            action: "release",
            reason: "模拟请求未提交",
          });
        } finally {
          globalThis.fetch = realFetch;
        }
      },
    );
    await t.test(
      "workflow quote rejects cycles and illegal dependencies, idempotent runs",
      async () => {
        assert.throws(() =>
          orderSteps([
            { id: "a", input: sample() as any, dependencies: ["b"] },
            { id: "b", input: sample() as any, dependencies: ["a"] },
          ]),
        );
        const bad = await request("/workflows/quote", {
          project_id: project.id,
          steps: [
            { id: "a", input: sample(), dependencies: [] },
            { id: "b", input: sample(), dependencies: ["a"] },
          ],
        });
        assert.equal(bad.status, 400);
        const quote = await request("/workflows/quote", {
          project_id: project.id,
          steps: [{ id: "a", input: sample(), dependencies: [] }],
        });
        assert.equal(quote.status, 200, JSON.stringify(quote.data));
        const a = await request("/workflows", { token: quote.data.token });
        const b = await request("/workflows", { token: quote.data.token });
        assert.equal(a.data.id, b.data.id);
        await request(`/workflows/${a.data.id}/stop`, {});
        await runWorkflows();
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS count FROM tasks WHERE idempotency_key LIKE $1",
              [`workflow:${a.data.id}:%`],
            )
          )[0].count,
          0,
        );
      },
    );
    await t.test(
      "verification code five failed attempts persist and cannot reuse",
      async () => {
        const id = randomUUID();
        await db.query(
          "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,'test@example.cn','reset',$2,now()+interval '10 minutes')",
          [id, hash("123456")],
        );
        for (let i = 0; i < 5; i++)
          await assert.rejects(() =>
            consumeCode("test@example.cn", "reset", "000000"),
          );
        await assert.rejects(() =>
          consumeCode("test@example.cn", "reset", "123456"),
        );
        assert.equal(
          (
            await db.query("SELECT attempts FROM email_codes WHERE id=$1", [id])
          )[0].attempts,
          5,
        );
      },
    );
    await t.test(
      "asset expiry reminders, exports and permanent cleanup",
      async () => {
        const e = await request("/assets/exports", { asset_ids: [asset.id] });
        assert.equal(e.status, 202);
        await processExports();
        const jobs = (await request("/assets/exports/list")).data;
        assert.equal(jobs[0].status, "SUCCEEDED");
        await db.query(
          "UPDATE assets SET expires_at=now()+interval '20 hours' WHERE id=$1",
          [asset.id],
        );
        await cleanupAssets();
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::int AS count FROM notifications WHERE unique_key LIKE $1",
              [`expiry:${asset.id}:%`],
            )
          )[0].count,
          3,
        );
        const currentProject = (await request(`/projects/${project.id}`)).data;
        const assetNode = {
          id: "asset-node",
          type: "asset",
          position: { x: 0, y: 0 },
          data: { asset_id: asset.id, kind: "image", name: asset.name },
        };
        const generationNode = {
          id: "generation-node",
          type: "generation",
          position: { x: 300, y: 0 },
          data: {
            media: [{ type: "reference_image", asset_id: asset.id }],
          },
        };
        assert.equal(
          (
            await request(
              `/projects/${project.id}`,
              {
                version: currentProject.version,
                content: {
                  nodes: [assetNode, generationNode],
                  edges: [
                    {
                      id: "asset-edge",
                      source: "asset-node",
                      target: "generation-node",
                      sourceHandle: "asset",
                      targetHandle: "reference_image",
                    },
                  ],
                },
              },
              "PATCH",
            )
          ).status,
          200,
        );
        await request(`/assets/${asset.id}`, { deleted: true }, "PATCH");
        const afterDelete = (await request(`/projects/${project.id}`)).data;
        assert.equal(afterDelete.content.nodes.length, 1);
        assert.equal(afterDelete.content.nodes[0].id, "generation-node");
        assert.deepEqual(afterDelete.content.nodes[0].data.media, []);
        assert.equal(afterDelete.content.edges.length, 0);
        assert.equal(
          (await request(`/assets/${asset.id}`, undefined, "DELETE")).status,
          200,
        );
        const [a] = await db.query("SELECT * FROM assets WHERE id=$1", [
          asset.id,
        ]);
        assert.ok(a.purged_at);
        await assert.rejects(
          fs.stat(path.join(dir, "objects", `thumbnails/${asset.id}.jpg`)),
        );
      },
    );
    await t.test(
      "admin sensitive action requires recent password",
      async () => {
        await db.query(
          "UPDATE sessions SET verified_at=now()-interval '1 hour' WHERE user_id=$1",
          [admin.id],
        );
        assert.equal(
          (
            await request("/admin/prices", {
              model: "wan3.0-video",
              resolution: "720P",
              official: 0.6,
              sale: 0.5,
              enabled: true,
            })
          ).status,
          428,
        );
        assert.equal(
          (await request("/auth/reauth", { password: "test-password-123" }))
            .status,
          200,
        );
        const [existingPrice] = await db.query(
          "SELECT id FROM prices WHERE model=$1 AND resolution=$2 AND deleted_at IS NULL",
          ["wan3.0-video", "720P"],
        );
        assert.equal(
          (
            await request(
              `/admin/prices/${existingPrice.id}`,
              {
                official: 0.6,
                sale: 0.5,
                enabled: true,
              },
              "PATCH",
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "concurrent reconciliation cannot settle another upstream task",
      async () => {
        const realFetch = globalThis.fetch;
        for (const fastStatus of ["FAILED", "SUCCEEDED"]) {
          const q = (await request("/quotes", sample())).data;
          const u = (
            await db.query("SELECT * FROM users WHERE id=$1", [admin.id])
          )[0];
          const created = await submitGeneration(
            u,
            undefined,
            q.input,
            q.token,
            randomUUID(),
          );
          await db.query("UPDATE tasks SET status='UNKNOWN' WHERE id=$1", [
            created.id,
          ]);
          let arrivals = 0;
          let unblock!: () => void;
          const barrier = new Promise<void>((r) => (unblock = r));
          globalThis.fetch = (async (url: any, opts: any) => {
            if (!String(url).includes(".maas.aliyuncs.com"))
              return realFetch(url, opts);
            const upstream = decodeURIComponent(String(url).split("/").pop()!);
            if (++arrivals === 2) unblock();
            await barrier;
            const fast = upstream.startsWith("fast-");
            if (!fast) await new Promise((r) => setTimeout(r, 40));
            const status = fast
              ? fastStatus
              : fastStatus === "SUCCEEDED"
                ? "FAILED"
                : "SUCCEEDED";
            return new Response(
              JSON.stringify({
                output: {
                  task_id: upstream,
                  task_status: status,
                  video_url: "https://example.invalid/test.mp4",
                },
                usage: {
                  video_count: 1,
                  duration: 4,
                  input_video_duration: 0,
                  output_video_duration: 4,
                  SR: 1080,
                },
              }),
              { status: 200 },
            );
          }) as typeof fetch;
          try {
            const results = await Promise.all([
              request(`/admin/usage/${created.id}/reconcile`, {
                action: "query",
                upstreamId: `slow-${created.id}`,
                reason: "并发核对慢响应",
              }),
              request(`/admin/usage/${created.id}/reconcile`, {
                action: "query",
                upstreamId: `fast-${created.id}`,
                reason: "并发核对快响应",
              }),
            ]);
            assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
            const [r] = await db.query("SELECT * FROM tasks WHERE id=$1", [
              created.id,
            ]);
            assert.equal(r.upstream_id, `fast-${created.id}`);
            assert.equal(
              r.settlement,
              fastStatus === "FAILED" ? "released" : "charged",
            );
            assert.equal(
              Number(r.charged_micro),
              fastStatus === "FAILED" ? 0 : 4_800_000,
            );
          } finally {
            globalThis.fetch = realFetch;
          }
        }
      },
    );
    await t.test(
      "channel budget is reserved across different users atomically",
      async () => {
        await request(`/admin/users/${user.id}/balance`, {
          type: "recharge",
          amount: 50,
          reason: "并发预算测试",
          idempotencyKey: randomUUID(),
        });
        const login = await request("/auth/login", {
          username: "testuser",
          password: "user-password-123",
        });
        const otherCookie = login.headers.get("set-cookie")!.split(";")[0];
        const users = await db.query(
          "SELECT * FROM users WHERE id=$1 OR id=$2",
          [admin.id, user.id],
        );
        const quotes = await Promise.all([
          request("/quotes", sample()),
          request("/quotes", sample(), "POST", otherCookie),
        ]);
        await db.query(
          "UPDATE credentials SET budget_micro=(SELECT COALESCE(sum(cost_micro+CASE WHEN settlement='reserved' THEN round(reserve_micro*multiplier) ELSE 0 END),0) FROM tasks WHERE credential_id=$1)+3000000 WHERE id=$1",
          [channel.id],
        );
        const results = await Promise.allSettled([
          submitGeneration(
            users.find((u) => u.id === admin.id)!,
            undefined,
            quotes[0].data.input,
            quotes[0].data.token,
            randomUUID(),
          ),
          submitGeneration(
            users.find((u) => u.id === user.id)!,
            undefined,
            quotes[1].data.input,
            quotes[1].data.token,
            randomUUID(),
          ),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const result of results)
          if (result.status === "fulfilled") {
            const auth =
              result.value.user_id === admin.id ? cookie : otherCookie;
            await request(
              `/generations/${result.value.id}/cancel`,
              {},
              "POST",
              auth,
            );
          }
        await db.query("UPDATE credentials SET budget_micro=0 WHERE id=$1", [
          channel.id,
        ]);
      },
    );
    await t.test("BMP and SSRF private-address boundaries", async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const input = path.join(dir, "input.png"),
        output = path.join(dir, "input.bmp");
      await sharp({
        create: { width: 256, height: 256, channels: 3, background: "#123456" },
      })
        .png()
        .toFile(input);
      await promisify(execFile)(
        "ffmpeg",
        ["-v", "error", "-i", input, "-y", output],
        { windowsHide: true },
      );
      const result = await inspect(await fs.readFile(output), "input.bmp");
      assert.equal(result.kind, "image");
      assert.equal(result.metadata.width, 256);
      const { resolvePublic } = await import("../server/network");
      for (const url of [
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://10.0.0.1/",
        "file:///etc/passwd",
      ])
        await assert.rejects(() => resolvePublic(url));
    });
    await t.test(
      "existing result recovers after upstream expiry; reconciliation respects expired delivery",
      async () => {
        await db.query("UPDATE tasks SET next_poll=now()+interval '1 day'");
        const u = (
          await db.query("SELECT * FROM users WHERE id=$1", [admin.id])
        )[0];
        const q = (await request("/quotes", sample())).data;
        const payload = {
          output: { video_url: "https://example.invalid/video.mp4" },
          usage: {
            video_count: 1,
            duration: 4,
            input_video_duration: 0,
            output_video_duration: 4,
            SR: 1080,
          },
        };
        const a = await submitGeneration(
          u,
          undefined,
          q.input,
          q.token,
          randomUUID(),
        );
        await settleSuccess(a.id, payload);
        const { saveAsset } = await import("../server/assets");
        const image = await sharp({
          create: {
            width: 256,
            height: 256,
            channels: 3,
            background: "#228855",
          },
        })
          .png()
          .toBuffer();
        await saveAsset(
          admin.id,
          image,
          "isolated-result.png",
          undefined,
          undefined,
          a.id,
        );
        await db.query(
          "UPDATE tasks SET result_received_at=now()-interval '25 hours',next_poll=now() WHERE id=$1",
          [a.id],
        );
        await saveResults();
        assert.equal(
          (await db.query("SELECT status FROM tasks WHERE id=$1", [a.id]))[0]
            .status,
          "SUCCEEDED",
        );
        const b = await submitGeneration(
          u,
          undefined,
          q.input,
          q.token,
          randomUUID(),
        );
        await settleSuccess(b.id, {
          output: payload.output,
          usage: { duration: -1 },
        });
        await db.query(
          "UPDATE tasks SET result_received_at=now()-interval '25 hours',next_poll=now() WHERE id=$1",
          [b.id],
        );
        await saveResults();
        await settleSuccess(b.id, payload);
        assert.equal(
          (await db.query("SELECT status FROM tasks WHERE id=$1", [b.id]))[0]
            .status,
          "DELIVERY_FAILED",
        );
      },
    );
    await t.test(
      "ledger pagination preserves ordered records and role projection",
      async () => {
        const all = (
          await request(`/admin/users/${admin.id}/ledger?limit=1000`)
        ).data;
        assert.ok(all.length > 4);
        const pages = [];
        for (let offset = 0; offset < all.length; offset += 2) {
          const response = await request(
            `/admin/users/${admin.id}/ledger?limit=2&offset=${offset}`,
          );
          assert.equal(response.status, 200);
          pages.push(...response.data);
        }
        assert.deepEqual(
          pages.map((r: any) => r.id),
          all.map((r: any) => r.id),
        );
        const own = await request("/ledger?limit=2&offset=2");
        assert.deepEqual(
          own.data.map((r: any) => r.id),
          all.slice(2, 4).map((r: any) => r.id),
        );
        assert.ok(
          own.data.every((r: any) => !("cost" in r) && !("request_hash" in r)),
        );
      },
    );
    await t.test(
      "API key revoke physically removes credentials but preserves historical task bills",
      async () => {
        const [record] = await db.query(
          "SELECT * FROM api_keys WHERE key_hash=$1",
          [hash(key)],
        );
        assert.ok(record);
        const linked = await db.query(
          "SELECT id,charged_micro FROM tasks WHERE api_key_id=$1",
          [record.id],
        );
        const removed = await request(
          `/api-keys/${record.id}`,
          undefined,
          "DELETE",
        );
        assert.equal(removed.status, 200);
        assert.equal(
          (await db.query("SELECT id FROM api_keys WHERE id=$1", [record.id]))
            .length,
          0,
        );
        const after = await db.query(
          "SELECT id,api_key_id,charged_micro FROM tasks WHERE id=ANY($1::uuid[])",
          [linked.map((row: any) => row.id)],
        );
        if (linked.length) {
          assert.ok(after.every((row: any) => row.api_key_id === null));
          assert.deepEqual(
            after.map((row: any) => Number(row.charged_micro)),
            linked.map((row: any) => Number(row.charged_micro)),
          );
        }
        assert.equal(
          (await request("/quotes", sample(), undefined, `Bearer ${key}`))
            .status,
          401,
        );
      },
    );
  } finally {
    await app.close();
    await closeDb();
    if (dir.startsWith(path.join(os.tmpdir(), "infinite-canvas-test-")))
      await fs.rm(dir, { recursive: true, force: true });
  }
});
