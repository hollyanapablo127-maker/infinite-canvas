import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("email registration, verification and legacy login", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "canvas-register-test-"),
  );
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  process.env.DATA_DIR = directory;
  process.env.PORT = String(port);
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = origin;
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main");
  const { db, closeDb } = await import("../server/db");
  const { hash } = await import("../server/security");
  const request = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(`${origin}/api/v1/auth${route}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const setPolicy = async (policy: Record<string, unknown>) =>
    db.query("UPDATE settings SET value=value || $1::jsonb WHERE id=1", [
      JSON.stringify(policy),
    ]);
  try {
    const setup = await request("/setup", {
      username: "legacyadmin",
      display_name: "Administrator",
      password: "administrator-pass-123",
    });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.equal(
      (
        await request("/register", {
          email: "closed@example.com",
          password: "password-123",
        })
      ).status,
      403,
    );
    await setPolicy({ registrationOpen: true });
    const plain = await request("/register", {
      email: "  Alice@Example.COM  ",
      password: "alice-password-123",
      username: "ignored",
      display_name: "ignored",
    });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.user.username, "alice@example.com");
    assert.equal(plain.body.user.display_name, "alice");
    assert.equal(plain.body.user.email, "alice@example.com");
    assert.equal(plain.body.user.email_verified, false);
    assert.equal(
      (
        await request("/login", {
          username: "ALICE@EXAMPLE.COM",
          password: "alice-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/login", {
          username: "legacyadmin",
          password: "administrator-pass-123",
        })
      ).status,
      200,
    );

    await setPolicy({ emailVerification: true });
    const verifiedEmail = "verified@example.com";
    const registration = {
      email: verifiedEmail,
      password: "verified-password-123",
    };
    assert.equal((await request("/register", registration)).status, 400);
    const id = randomUUID();
    await db.query(
      "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,$2,'register',$3,now()+interval '10 minutes')",
      [id, verifiedEmail, hash("123456")],
    );
    assert.equal(
      (await request("/register", { ...registration, code: "000000" })).status,
      400,
    );
    assert.equal(
      (await db.query("SELECT attempts FROM email_codes WHERE id=$1", [id]))[0]
        .attempts,
      1,
    );
    const verified = await request("/register", {
      ...registration,
      code: "123456",
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.user.username, verifiedEmail);
    assert.equal(verified.body.user.email_verified, true);
    assert.equal(
      (await db.query("SELECT consumed FROM email_codes WHERE id=$1", [id]))[0]
        .consumed,
      true,
    );

    const resetId = randomUUID();
    await db.query(
      "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,$2,'reset',$3,now()+interval '10 minutes')",
      [resetId, "alice@example.com", hash("654321")],
    );
    assert.equal(
      (
        await request("/reset-password", {
          email: "alice@example.com",
          code: "654321",
          password: "new-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/login", {
          username: "alice@example.com",
          password: "new-password-123",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query("SELECT email_verified FROM users WHERE email=$1", [
          "alice@example.com",
        ])
      )[0].email_verified,
      true,
    );
  } finally {
    await app.close();
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
});
