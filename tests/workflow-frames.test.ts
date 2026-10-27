import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { DEFAULT_PARAMETERS } from "../shared/wan";

const exec = promisify(execFile);
const input = (mode = "text", duration = 5) => ({
  model: "wan3.0-video",
  mode,
  input: { prompt: "测试画面", media: [] },
  parameters: { ...DEFAULT_PARAMETERS, duration },
});

async function videoFixture(dir: string) {
  const file = path.join(dir, "result.mp4");
  await exec(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=320x240:r=2:d=15",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x240:r=2:d=1",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      "-y",
      file,
    ],
    { timeout: 30000, windowsHide: true },
  );
  return fs.readFile(file);
}

async function pixel(frame: Buffer) {
  const { data } = await sharp(frame)
    .resize(1, 1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

test("workflow frame dependencies validate and use real terminal frames", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-workflow-frames-"),
  );
  process.env.DATA_DIR = dir;
  process.env.PORT = "4047";
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://localhost:5173";
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { app } = await import("../server/main");
  const { db, closeDb } = await import("../server/db");
  const { saveAsset } = await import("../server/assets");
  const { extractVideoFrame } = await import("../server/frames");
  const { runWorkflows, dependencyTypeFor } =
    await import("../server/workflows");
  let cookie = "";
  const request = async (endpoint: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:4047/api/v1${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      headers: response.headers,
    };
  };
  try {
    const setup = await request("/auth/setup", {
      username: "frameadmin",
      password: "test-password-123",
      display_name: "Frame Admin",
    });
    assert.equal(setup.status, 200, JSON.stringify(setup.data));
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const userId = setup.data.user.id;
    const project = await request("/projects", { name: "帧依赖测试" });
    assert.equal(project.status, 201, JSON.stringify(project.data));
    const projectId = project.data.id;
    const steps = [
      { id: "a", input: input("text", 16), dependencies: [] },
      { id: "b", input: input("text", 16), dependencies: [] },
      {
        id: "c",
        input: input("frames"),
        dependencies: ["a", "b"],
        dependency_types: { a: "first_frame", b: "last_frame" },
      },
    ];
    const quote = await request("/workflows/quote", {
      project_id: projectId,
      steps,
    });
    assert.equal(quote.status, 200, JSON.stringify(quote.data));
    const signed = JSON.parse(
      Buffer.from(quote.data.token.split(".")[0], "base64url").toString(),
    );
    assert.ok(
      signed.steps.every((step: any) => Number.isInteger(step.price_version)),
    );
    const sameSource = await request("/workflows/quote", {
      project_id: projectId,
      steps: [
        steps[0],
        {
          id: "same-source",
          input: input("frames"),
          dependencies: ["a"],
          dependency_bindings: [
            { source: "a", type: "first_frame" },
            { source: "a", type: "last_frame" },
          ],
        },
      ],
    });
    assert.equal(sameSource.status, 200, JSON.stringify(sameSource.data));
    const tooManyFirst = await request("/workflows/quote", {
      project_id: projectId,
      steps: [
        steps[0],
        steps[1],
        {
          ...steps[2],
          dependency_types: { a: "first_frame", b: "first_frame" },
        },
      ],
    });
    assert.equal(tooManyFirst.status, 400);
    assert.match(tooManyFirst.data.message, /首帧/);
    const oldVideoDependency = await request("/workflows/quote", {
      project_id: projectId,
      steps: [
        steps[0],
        {
          id: "reference",
          input: input("reference"),
          dependencies: ["a"],
        },
      ],
    });
    assert.equal(oldVideoDependency.status, 400);
    assert.match(oldVideoDependency.data.message, /2-15 秒/);
    assert.equal(dependencyTypeFor({}, "a"), "reference_video");

    const video = await videoFixture(dir);
    const first = await extractVideoFrame(video, "first_frame");
    const last = await extractVideoFrame(video, "last_frame");
    const [firstR, , firstB] = await pixel(first);
    const [lastR, , lastB] = await pixel(last);
    assert.ok(firstR > firstB + 100, "first frame should be red");
    assert.ok(lastB > lastR + 100, "last frame should be blue");

    const source = await saveAsset(userId, video, "result.mp4");
    assert.ok(source.metadata.duration > 15);
    assert.equal(
      (
        await request("/admin/credentials", {
          name: "帧测试渠道",
          account_group: "workflow-frames",
          workspace: "workflow-frames",
          key: "sk-workflow-test",
          multiplier: 1,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/admin/users/${userId}/balance`, {
          type: "recharge",
          amount: 100,
          reason: "工作流测试",
          idempotencyKey: randomUUID(),
        })
      ).status,
      200,
    );
    const run = await request("/workflows", { token: quote.data.token });
    assert.equal(run.status, 202, JSON.stringify(run.data));
    const [row] = await db.query(
      "SELECT steps FROM workflow_runs WHERE id=$1",
      [run.data.id],
    );
    row.steps[0].state = "DONE";
    row.steps[0].asset_id = source.id;
    row.steps[1].state = "DONE";
    row.steps[1].asset_id = source.id;
    await db.query("UPDATE workflow_runs SET steps=$2 WHERE id=$1", [
      run.data.id,
      JSON.stringify(row.steps),
    ]);
    await runWorkflows();
    const [task] = await db.query(
      "SELECT * FROM tasks WHERE idempotency_key=$1",
      [`workflow:${run.data.id}:c`],
    );
    assert.ok(task, "dependent generation should be submitted");
    assert.deepEqual(
      task.input.input.media.map((m: any) => m.type),
      ["first_frame", "last_frame"],
    );
    const [firstAsset, lastAsset] = await Promise.all(
      task.input.input.media.map((m: any) =>
        db
          .query("SELECT * FROM assets WHERE id=$1", [m.asset_id])
          .then((rows) => rows[0]),
      ),
    );
    assert.equal(firstAsset.parent_id, source.id);
    assert.equal(lastAsset.parent_id, source.id);
    assert.equal(firstAsset.kind, "image");
    assert.equal(lastAsset.kind, "image");
    const [{ status, error }] = await db.query(
      "SELECT status,error FROM workflow_runs WHERE id=$1",
      [run.data.id],
    );
    assert.equal(status, "RUNNING", error);
  } finally {
    await app.close();
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
