import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import sharp from "sharp";
test("video assets can extract true first and last frames into owned derived images", async (t) => {
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  if (spawnSync(bin, ["-version"], { stdio: "ignore" }).status !== 0) {
    t.skip("ffmpeg is unavailable");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-frame-")),
    data = path.join(root, "data"),
    video = path.join(root, "two-colors.mp4");
  Object.assign(process.env, {
    DATA_DIR: data,
    PORT: "0",
    HOST: "127.0.0.1",
    APP_ORIGIN: "http://localhost:5173",
    DISABLE_WORKER: "1",
    FFMPEG_PATH: bin,
  });
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main"),
    { db, closeDb } = await import("../server/db"),
    { hash } = await import("../server/security"),
    { readObject } = await import("../server/storage");
  const address = app.getHttpServer().address() as any,
    base = `http://127.0.0.1:${address.port}/api/v1`;
  const owner = randomUUID(),
    session = randomUUID();
  await db.query(
    "INSERT INTO users(id,username,display_name,password_hash,role) VALUES($1,$2,'frame tester','unused','user')",
    [owner, `frame-${owner}`],
  );
  await db.query("INSERT INTO wallets(user_id) VALUES($1)", [owner]);
  await db.query(
    "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
    [hash(session), owner],
  );
  const cookie = `canvas_session=${session}`;
  const request = async (url: string, body?: any, method?: string) => {
    const r = await fetch(base + url, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Cookie: cookie,
        Origin: "http://localhost:5173",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    execFileSync(
      bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=96x64:r=10:d=1.9",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=96x64:r=10:d=0.1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
        "-map",
        "[v]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "1",
        "-pix_fmt",
        "yuv420p",
        "-t",
        "2",
        video,
      ],
      { timeout: 30000, windowsHide: true },
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await fs.readFile(video))], {
        type: "video/mp4",
      }),
      "color-shift.mp4",
    );
    const uploaded = await fetch(base + "/assets/upload", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost:5173" },
      body: form,
    });
    assert.equal(uploaded.status, 201);
    const asset = await uploaded.json();
    assert.equal(asset.kind, "video");
    assert.ok(asset.metadata.fps >= 9);
    const first = await request(`/assets/${asset.id}/derive`, {
      operation: "frame_first",
    });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.match(first.data.name, /首帧\.jpg$/);
    assert.equal(first.data.parent_id, asset.id);
    const last = await request(`/assets/${asset.id}/derive`, {
      operation: "frame_last",
    });
    assert.equal(last.status, 200, JSON.stringify(last.data));
    assert.match(last.data.name, /尾帧\.jpg$/);
    assert.equal(last.data.parent_id, asset.id);
    const firstRow = (
        await db.query("SELECT * FROM assets WHERE id=$1", [first.data.id])
      )[0],
      lastRow = (
        await db.query("SELECT * FROM assets WHERE id=$1", [last.data.id])
      )[0];
    const pixel = async (row: any) =>
      Array.from(
        await sharp(await readObject(row.object_key, row.storage))
          .resize(1, 1)
          .removeAlpha()
          .raw()
          .toBuffer(),
      );
    const p1 = await pixel(firstRow),
      p2 = await pixel(lastRow);
    assert.ok(p1[0] > p1[2] * 1.6, `first pixel should be red: ${p1}`);
    assert.ok(p2[2] > p2[0] * 1.6, `last pixel should be blue: ${p2}`);
    for (const variant of ["long-audio", "variable-fps"]) {
      const variantPath = path.join(root, `${variant}.mp4`);
      execFileSync(
        bin,
        [
          "-v",
          "error",
          "-i",
          video,
          ...(variant === "long-audio"
            ? [
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-t",
                "8",
              ]
            : [
                "-vf",
                "select='not(mod(n,3))+eq(n,19)'",
                "-fps_mode",
                "vfr",
                "-c:v",
                "libx264",
              ]),
          "-threads",
          "1",
          "-y",
          variantPath,
        ],
        { timeout: 30000, windowsHide: true },
      );
      const variantForm = new FormData();
      variantForm.append(
        "file",
        new Blob([new Uint8Array(await fs.readFile(variantPath))], {
          type: "video/mp4",
        }),
        `${variant}.mp4`,
      );
      const variantUpload = await fetch(base + "/assets/upload", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://localhost:5173" },
        body: variantForm,
      });
      assert.equal(variantUpload.status, 201);
      const variantAsset = await variantUpload.json();
      const derived = await request(`/assets/${variantAsset.id}/derive`, {
        operation: "frame_last",
      });
      assert.equal(
        derived.status,
        200,
        `${variant}: ${JSON.stringify(derived.data)}`,
      );
      const [derivedRow] = await db.query("SELECT * FROM assets WHERE id=$1", [
        derived.data.id,
      ]);
      const rgb = await pixel(derivedRow);
      assert.ok(
        rgb[2] > rgb[0] * 1.6,
        `${variant} must retain the final blue frame: ${rgb}`,
      );
    }
    const legacy = await request(`/assets/${asset.id}/derive`, {
      operation: "frame",
      start: 1.2,
    });
    assert.equal(legacy.status, 200);
    assert.match(legacy.data.name, /截帧\.jpg$/);
  } finally {
    await app.close();
    await closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
});
