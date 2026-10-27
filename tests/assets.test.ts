import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { execFileSync, spawnSync } from "node:child_process";

test("asset deletion respects ownership, lifecycle and active work", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-assets-test-"));
  process.env.DATA_DIR = dir;
  process.env.PORT = "0";
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://localhost:5173";
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main");
  const { db, closeDb } = await import("../server/db");
  const { hash } = await import("../server/security");
  const { cleanupAssets } = await import("../server/assets");
  const { localPath, readObject } = await import("../server/storage");
  const address = app.getHttpServer().address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const owner = randomUUID();
  const stranger = randomUUID();

  async function user(id: string) {
    const session = randomUUID();
    await db.query(
      "INSERT INTO users(id,username,display_name,email,password_hash,role) VALUES($1,$2,$3,$4,'unused','user')",
      [id, `${id}@example.test`, id, `${id}@example.test`],
    );
    await db.query("INSERT INTO wallets(user_id) VALUES($1)", [id]);
    await db.query(
      "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
      [hash(session), id],
    );
    return `canvas_session=${session}`;
  }
  async function request(
    cookie: string,
    route: string,
    method = "GET",
    body?: unknown,
  ) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: "http://localhost:5173",
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body instanceof FormData
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#43886a" },
  })
    .png()
    .toBuffer();
  async function upload(
    cookie: string,
    fileBuffer: Buffer = png,
    filename = "sample.png",
    mime = "image/png",
  ) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(fileBuffer)], { type: mime }),
      filename,
    );
    const response = await request(cookie, "/assets/upload", "POST", form);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }

  try {
    const ownCookie = await user(owner);
    const otherCookie = await user(stranger);
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0) {
      const videoPath = path.join(dir, "two-color.mp4");
      execFileSync(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=96x64:r=10:d=1",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=96x64:r=10:d=1",
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
          videoPath,
        ],
        { timeout: 30000, windowsHide: true },
      );
      const video = await upload(
        ownCookie,
        await fs.readFile(videoPath),
        "two-color.mp4",
        "video/mp4",
      );
      assert.equal(video.kind, "video");
      const first = await request(
        ownCookie,
        `/assets/${video.id}/derive`,
        "POST",
        { operation: "frame_first" },
      );
      assert.equal(first.status, 200, JSON.stringify(first.data));
      assert.match(first.data.name, /首帧\.jpg$/);
      assert.equal(first.data.parent_id, video.id);
      const last = await request(
        ownCookie,
        `/assets/${video.id}/derive`,
        "POST",
        { operation: "frame_last" },
      );
      assert.equal(last.status, 200, JSON.stringify(last.data));
      assert.match(last.data.name, /尾帧\.jpg$/);
      assert.equal(last.data.parent_id, video.id);
      const [firstRow] = await db.query("SELECT * FROM assets WHERE id=$1", [
        first.data.id,
      ]);
      const [lastRow] = await db.query("SELECT * FROM assets WHERE id=$1", [
        last.data.id,
      ]);
      const rgb = async (row: any) =>
        Array.from(
          await sharp(await readObject(row.object_key, row.storage))
            .resize(1, 1)
            .removeAlpha()
            .raw()
            .toBuffer(),
        );
      const firstPixel = await rgb(firstRow),
        lastPixel = await rgb(lastRow);
      assert.ok(
        firstPixel[0] > firstPixel[2] * 1.5,
        `expected red first frame, got ${firstPixel}`,
      );
      assert.ok(
        lastPixel[2] > lastPixel[0] * 1.5,
        `expected blue last frame, got ${lastPixel}`,
      );
      assert.equal(
        (
          await request(ownCookie, `/assets/${video.id}/derive`, "POST", {
            operation: "frame_first",
            start: 99,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(ownCookie, `/assets/${video.id}/derive`, "POST", {
            operation: "frame_last",
            start: -1,
          })
        ).status,
        400,
      );
    }
    const image = await upload(ownCookie);
    const [{ object_key: objectKey }] = await db.query(
      "SELECT object_key FROM assets WHERE id=$1",
      [image.id],
    );
    assert.equal(
      (await request(otherCookie, `/assets/${image.id}`, "DELETE")).status,
      404,
    );
    assert.equal(
      (await request(ownCookie, `/assets/${image.id}`, "DELETE")).status,
      400,
    );
    assert.equal(
      (
        await request(ownCookie, `/assets/${image.id}`, "PATCH", {
          deleted: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(ownCookie, `/assets/${image.id}`, "DELETE")).status,
      200,
    );
    assert.ok(
      !(await request(ownCookie, "/assets")).data.some(
        (asset: { id: string }) => asset.id === image.id,
      ),
    );
    assert.equal(
      (await request(ownCookie, `/assets/${image.id}/content`)).status,
      404,
    );
    await assert.rejects(fs.stat(localPath(objectKey)));

    const linkId = randomUUID();
    await db.query(
      "INSERT INTO assets(id,user_id,name,kind,storage,source_url,expires_at) VALUES($1,$2,'Example','link','external','https://example.test',now()+interval '1 day')",
      [linkId, owner],
    );
    assert.equal(
      (
        await request(ownCookie, `/assets/${linkId}`, "PATCH", {
          deleted: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(ownCookie, `/assets/${linkId}`, "DELETE")).status,
      200,
    );

    const expired = await upload(ownCookie);
    await db.query(
      "UPDATE assets SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.id],
    );
    assert.equal(
      (
        await request(ownCookie, `/assets/${expired.id}`, "PATCH", {
          deleted: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(ownCookie, `/assets/${expired.id}`, "DELETE")).status,
      200,
    );

    const autoExpired = await upload(ownCookie);
    await db.query(
      "UPDATE assets SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [autoExpired.id],
    );
    await cleanupAssets();
    assert.ok(
      !(await request(ownCookie, "/assets")).data.some(
        (asset: { id: string }) => asset.id === autoExpired.id,
      ),
    );

    const active = await upload(ownCookie);
    const [{ id: priceId }] = await db.query("SELECT id FROM prices LIMIT 1");
    const taskId = randomUUID();
    await db.query(
      "INSERT INTO tasks(id,user_id,source,input,prepared_media,model,resolution,mode,status,price_id,price_micro,official_micro,reserve_micro,idempotency_key,request_hash) VALUES($1,$2,'web','{}',$3,'wan3.0-video','720P','reference','RUNNING',$4,1000000,1000000,1000000,$5,'test')",
      [
        taskId,
        owner,
        JSON.stringify([{ type: "reference_image", asset_id: active.id }]),
        priceId,
        taskId,
      ],
    );
    assert.equal(
      (
        await request(ownCookie, `/assets/${active.id}`, "PATCH", {
          deleted: true,
        })
      ).status,
      400,
    );
    await db.query("UPDATE tasks SET status='SUCCEEDED' WHERE id=$1", [taskId]);
    await db.query("UPDATE tasks SET result_asset_id=$2 WHERE id=$1", [
      taskId,
      active.id,
    ]);

    const projectId = randomUUID();
    const runId = randomUUID();
    await db.query(
      "INSERT INTO projects(id,user_id,name) VALUES($1,$2,'test')",
      [projectId, owner],
    );
    await db.query(
      "INSERT INTO workflow_runs(id,user_id,project_id,steps) VALUES($1,$2,$3,$4)",
      [
        runId,
        owner,
        projectId,
        JSON.stringify([
          { input: { input: { media: [{ asset_id: active.id }] } } },
        ]),
      ],
    );
    assert.equal(
      (
        await request(ownCookie, `/assets/${active.id}`, "PATCH", {
          deleted: true,
        })
      ).status,
      400,
    );
    await db.query("UPDATE workflow_runs SET status='STOPPED' WHERE id=$1", [
      runId,
    ]);
    assert.equal(
      (
        await request(ownCookie, `/assets/${active.id}`, "PATCH", {
          deleted: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(ownCookie, `/assets/${active.id}`, "DELETE")).status,
      200,
    );
    assert.equal(
      (
        await db.query("SELECT result_asset_id FROM tasks WHERE id=$1", [
          taskId,
        ])
      )[0].result_asset_id,
      active.id,
    );
  } finally {
    await app.close();
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
