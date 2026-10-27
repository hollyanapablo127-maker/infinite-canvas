import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PARAMETERS } from "../shared/wan";

test("pricing edits keep one current row and invalidate previous quotes", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "infinite-canvas-prices-"),
  );
  process.env.DATA_DIR = dir;
  process.env.PORT = "4033";
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://localhost:5173";
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main");
  const { db, migrate, closeDb } = await import("../server/db");
  const base = "http://127.0.0.1:4033/api/v1";
  let cookie = "";
  const request = async (endpoint: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        "Content-Type": "application/json",
        ...(endpoint === "/generations"
          ? { "Idempotency-Key": randomUUID() }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const setup = await fetch(base + "/auth/setup", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "priceadmin",
        password: "test-password-123",
        display_name: "Price Admin",
      }),
    });
    assert.equal(setup.status, 200);
    const admin = (await setup.json()).user;
    cookie = setup.headers.get("set-cookie")!.split(";")[0];

    const first = (await request("/admin/prices")).data;
    assert.equal(first.length, 6);
    const tier = first.find(
      (p: any) => p.model === "wan3.0-video" && p.resolution === "1080P",
    );
    assert.ok(tier);

    // Simulate the duplicate rows that a previous release allowed.
    await db.query("DROP INDEX prices_current_tier");
    const duplicateId = randomUUID();
    await db.query(
      "INSERT INTO prices(id,model,resolution,official_micro,sale_micro,enabled,effective_at) VALUES($1,$2,$3,$4,$5,true,now())",
      [
        duplicateId,
        tier.model,
        tier.resolution,
        tier.official_micro,
        tier.sale_micro,
      ],
    );
    await migrate();
    const rows = (await request("/admin/prices")).data;
    assert.equal(rows.length, 6);
    const current = rows.find(
      (p: any) => p.model === tier.model && p.resolution === tier.resolution,
    );
    assert.equal(current.id, duplicateId);
    assert.ok(
      (
        await db.query("SELECT deleted_at FROM prices WHERE id=$1", [tier.id])
      )[0].deleted_at,
    );

    const priceValues = {
      model: current.model,
      resolution: current.resolution,
      official: Number(current.official_micro) / 1e6,
      sale: Number(current.sale_micro) / 1e6,
      enabled: true,
    };
    const duplicate = await request("/admin/prices", "POST", priceValues);
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.data.message, /修改现有定价/);

    const quoteInput = {
      model: current.model,
      mode: "text",
      input: { prompt: "定价回归测试", media: [] },
      parameters: { ...DEFAULT_PARAMETERS, resolution: current.resolution },
    };
    const quote = await request("/quotes", "POST", quoteInput);
    assert.equal(quote.status, 200, JSON.stringify(quote.data));
    assert.equal(
      (
        await request(`/admin/prices/${current.id}`, "PATCH", {
          official: priceValues.official + 0.1,
          sale: priceValues.sale,
          enabled: true,
        })
      ).status,
      200,
    );
    const afterEdit = (await request("/admin/prices")).data;
    assert.equal(afterEdit.length, 6);
    const changed = afterEdit.find((p: any) => p.id === current.id);
    assert.equal(changed.version, current.version + 1);
    assert.equal(Number(changed.sale_micro), Number(current.sale_micro));
    assert.equal(
      Number(changed.official_micro),
      Number(current.official_micro) + 100_000,
    );
    const stale = await request("/generations", "POST", {
      input: quote.data.input,
      quoteToken: quote.data.token,
    });
    assert.equal(stale.status, 400);
    assert.match(stale.data.message, /价格/);
    const refreshed = await request("/quotes", "POST", quoteInput);
    assert.equal(refreshed.status, 200);
    const withoutChannel = await request("/generations", "POST", {
      input: refreshed.data.input,
      quoteToken: refreshed.data.token,
    });
    assert.equal(withoutChannel.status, 503);
    assert.match(withoutChannel.data.message, /渠道/);
    assert.equal(
      (
        await request("/admin/credentials", "POST", {
          name: "价格测试渠道",
          account_group: "pricing-test",
          workspace: "pricing-test-workspace",
          key: "sk-pricing-test-provider-key",
          multiplier: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/admin/users/${admin.id}/balance`, "POST", {
          type: "recharge",
          amount: 100,
          reason: "价格回归测试入账",
          idempotencyKey: randomUUID(),
        })
      ).status,
      200,
    );
    const created = await request("/generations", "POST", {
      input: refreshed.data.input,
      quoteToken: refreshed.data.token,
    });
    assert.equal(created.status, 202, JSON.stringify(created.data));
    const [taskBefore] = await db.query(
      "SELECT price_id,price_micro,official_micro FROM tasks WHERE id=$1",
      [created.data.id],
    );
    assert.equal(taskBefore.price_id, current.id);
    assert.equal(Number(taskBefore.price_micro), Number(current.sale_micro));
    assert.equal(
      (
        await request(`/admin/prices/${current.id}`, "PATCH", {
          official: priceValues.official + 0.2,
          sale: priceValues.sale + 0.2,
          enabled: true,
        })
      ).status,
      200,
    );

    assert.equal(
      (await request(`/admin/prices/${current.id}`, "DELETE")).status,
      200,
    );
    assert.equal((await request("/admin/prices")).data.length, 5);
    assert.equal((await request("/models")).data.prices.length, 5);
    assert.ok(
      (
        await db.query("SELECT deleted_at FROM prices WHERE id=$1", [
          current.id,
        ])
      )[0].deleted_at,
    );
    const [taskAfter] = await db.query(
      "SELECT price_id,price_micro,official_micro FROM tasks WHERE id=$1",
      [created.data.id],
    );
    assert.deepEqual(taskAfter, taskBefore);
    assert.equal(
      (await request("/admin/prices", "POST", priceValues)).status,
      200,
    );
    const restored = (await request("/admin/prices")).data.find(
      (p: any) =>
        p.model === current.model && p.resolution === current.resolution,
    );
    assert.notEqual(restored.id, current.id);
  } finally {
    await app.close();
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
