import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOLS, apiRoot, chatBase } from "../shared/protocols";

test("Bailian endpoint normalization separates REST and compatible Chat roots", () => {
  for (const url of [
    "https://space.cn-beijing.maas.aliyuncs.com",
    "https://space.cn-beijing.maas.aliyuncs.com/api/v1",
    "https://space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
    "https://space.cn-beijing.maas.aliyuncs.com/v1",
  ]) {
    assert.equal(apiRoot(url), "https://space.cn-beijing.maas.aliyuncs.com");
  }
  assert.equal(
    chatBase("https://space.cn-beijing.maas.aliyuncs.com/api/v1"),
    "https://space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
  assert.equal(
    chatBase("https://custom.example/v1"),
    "https://custom.example/v1",
  );
});

test("unified Bailian channel, protocol families, multimodal tasks, RTC and authenticated WebSocket bridge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-multimodal-"));
  Object.assign(process.env, {
    DATA_DIR: dir,
    PORT: "4056",
    HOST: "127.0.0.1",
    APP_ORIGIN: "http://localhost:5173",
    PUBLIC_BASE_URL: "https://assets.example",
    DISABLE_WORKER: "1",
  });
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const calls: Array<{
    path: string;
    body: any;
    headers: http.IncomingHttpHeaders;
  }> = [];
  const websocketCalls: any[] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    calls.push({ path: req.url!, body, headers: req.headers });
    assert.equal(req.headers.authorization, "Bearer isolated-bailian-key");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/compatible-mode/v1/models") {
      res.end(
        JSON.stringify({
          data: [{ id: "qwen-plus" }, { id: "Tripo/Tripo-H3.1" }],
        }),
      );
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "多模态文本回复" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    if (req.url?.includes("build-status")) {
      res.end(JSON.stringify({ code: 0, data: { status: "ready" } }));
      return;
    }
    if (req.url?.endsWith("/worlds/get-travel-credential")) {
      res.end(
        JSON.stringify({ code: 0, data: { ticket: "one-use-world-ticket" } }),
      );
      return;
    }
    if (req.url?.endsWith("/travels/enter-travel")) {
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            encryptedTravelId: "travel-001",
            mode: 1,
            rtcConfig: {
              channelId: "rtc-world",
              userId: "rtc-user",
              token: "short-lived-rtc-token",
              appId: "rtc-app",
            },
            playUrl: null,
          },
        }),
      );
      return;
    }
    if (req.url?.includes("/travels/")) {
      res.end(JSON.stringify({ code: 0, data: { status: "completed" } }));
      return;
    }
    if (req.url?.endsWith("/worlds")) {
      res.end(
        JSON.stringify({ code: 0, data: { encryptedWorldId: "world-001" } }),
      );
      return;
    }
    if (req.url?.includes("/api/v1/tasks/")) {
      const id = req.url.split("/").at(-1);
      res.end(
        JSON.stringify({
          output: {
            task_status: "SUCCEEDED",
            ...(id === "3d-task"
              ? {
                  results: [
                    {
                      base_model_url:
                        "data:model/gltf-binary;base64,Z2xURgIAAAAMAAAA",
                    },
                  ],
                }
              : id === "asr-task"
                ? {
                    result: {
                      transcription_url:
                        "data:application/json;base64," +
                        Buffer.from(
                          JSON.stringify({
                            transcripts: [{ text: "录音文件转写结果" }],
                          }),
                        ).toString("base64"),
                    },
                  }
                : {
                    video_url:
                      "data:video/mp4;base64,AAAAHGZ0eXBpc29tAAAAAGlzb20=",
                  }),
          },
          usage: { seconds: 5 },
        }),
      );
      return;
    }
    if (req.url?.endsWith("3d-generation")) {
      res.end(
        JSON.stringify({
          output: { task_id: "3d-task", task_status: "PENDING" },
        }),
      );
      return;
    }
    if (req.url?.endsWith("transcription")) {
      res.end(
        JSON.stringify({
          output: { task_id: "asr-task", task_status: "PENDING" },
        }),
      );
      return;
    }
    if (req.url?.endsWith("video-synthesis")) {
      res.end(
        JSON.stringify({
          output: { task_id: "video-task", task_status: "PENDING" },
        }),
      );
      return;
    }
    if (
      req.url?.endsWith("multimodal-generation/generation") &&
      body.model === "native-vl"
    ) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ output: { choices: [{ message: { content: [{ text: "原生视觉理解" }] }, finish_reason: "stop" }] }, usage: { input_tokens: 11, output_tokens: 22 } })}\n\n`,
      );
      return;
    }
    res.end(
      JSON.stringify({
        output: {
          audio: {
            url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQAAAAA=",
            duration: 2,
          },
        },
        usage: { duration: 2 },
      }),
    );
  });
  const upstreamWs = new WebSocketServer({ server: upstream });
  upstreamWs.on("connection", (client, req) => {
    assert.equal(req.headers.authorization, "Bearer isolated-bailian-key");
    const inference = req.url?.includes("inference");
    if (!inference) client.send(JSON.stringify({ type: "session.created" }));
    client.on("message", (data, binary) => {
      if (binary) return;
      const e = JSON.parse(data.toString());
      websocketCalls.push(e);
      if (e.type === "session.update")
        client.send(JSON.stringify({ type: "session.updated" }));
      if (e.type === "response.create") {
        client.send(
          JSON.stringify({ type: "response.text.delta", delta: "实时回复" }),
        );
        client.send(
          JSON.stringify({
            type: "response.done",
            response: { usage: { input_tokens: 10, output_tokens: 12 } },
          }),
        );
      }
      if (e.header?.action === "run-task")
        client.send(
          JSON.stringify({
            header: { event: "task-started", task_id: e.header.task_id },
          }),
        );
      if (e.header?.action === "finish-task") {
        client.send(
          JSON.stringify({
            header: { event: "task-finished", task_id: e.header.task_id },
          }),
        );
        client.close();
      }
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const { app } = await import("../server/main"),
    { db, transaction, closeDb, migrate } = await import("../server/db"),
    { walletEntry } = await import("../server/finance"),
    { processCapabilityJobs } = await import("../server/capabilities");
  let cookie = "";
  const api = "http://127.0.0.1:4056/api/v1";
  const request = async (endpoint: string, body?: any, method?: string) => {
    const r = await fetch(api + endpoint, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const setup = await fetch(api + "/auth/setup", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "multimodaladmin",
        password: "isolated-test-123",
        display_name: "多模态测试",
      }),
    });
    cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const user = (await setup.json()).user;
    await transaction((tx) =>
      walletEntry(tx, user.id, {
        type: "recharge",
        amount: 100_000_000,
        key: "multimodal-fund",
        reason: "isolated test funding",
      }),
    );
    const channelBody = {
      provider: "bailian",
      name: "百炼全能力",
      workspace: "test-space",
      region: "cn-beijing",
      baseUrl,
      key: "isolated-bailian-key",
      models: [
        "qwen-plus",
        "wan3.0-video",
        "qwen-image-3.0",
        "test-3d",
        "test-audio",
        "test-world",
        "test-live",
        "test-asr",
        "test-video",
        "native-vl",
        "qwen3-tts-flash",
        "cosyvoice-v3-flash",
      ],
      request_key: randomUUID(),
    };
    const created = await Promise.all([
      request("/admin/channels", channelBody),
      request("/admin/channels", channelBody),
    ]);
    assert.equal(created[0].status, 200, JSON.stringify(created[0].data));
    assert.equal(created[0].data.id, created[1].data.id);
    const groupId = created[0].data.id;
    const channels = (await request("/admin/channels")).data;
    assert.equal(
      channels.filter((c: any) => c.name === "百炼全能力").length,
      1,
    );
    assert.equal(channels[0].source, "bailian");
    assert.equal(
      JSON.stringify(channels).includes("isolated-bailian-key"),
      false,
    );
    assert.equal(channels[0].supported_types.length, 7);
    const link = (model: string) => [
      { id: groupId, source: "bailian", upstream_model: model },
    ];
    const define = async (
      model: string,
      type: string,
      protocol: string,
      upstreamModel = model,
      billingUnit = "request",
    ) => {
      const r = await request("/admin/models", {
        model,
        display_name: model,
        type,
        protocol,
        billing_unit: billingUnit,
        channels: type === "image" ? [] : link(upstreamModel),
        input_price: 0,
        output_price: 0.1,
        ...(type === "video"
          ? { tiers: [{ tier: "1080P", official: 0.2, sale: 0.1 }] }
          : {}),
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
    };
    for (const model of ["image-test-2", "image-test-2-5"])
      await define(model, "image", "openai-image");
    const announcement = {
      title: "静默测试公告",
      body: "正文",
      level: "normal",
      audience: "all",
      published: true,
      pinned: false,
      starts_at: new Date(Date.now() - 1000).toISOString(),
      ends_at: null,
      display_mode: "silent",
      sort: -10,
    };
    const news = await request("/admin/announcements", announcement);
    assert.equal(news.status, 200);
    const listed = (await request("/announcements")).data.find(
      (a: any) => a.id === news.data.id,
    );
    assert.equal(listed.display_mode, "silent");
    assert.equal(listed.sort, -10);
    await request(`/announcements/${news.data.id}/read`, {});
    assert.equal(
      (await request("/admin/announcements")).data.find(
        (a: any) => a.id === news.data.id,
      ).read_count,
      1,
    );
    assert.equal(
      (
        await request(
          "/admin/settings",
          { terms: "本站创作服务说明", supportEmail: "support@example.com" },
          "PATCH",
        )
      ).status,
      200,
    );
    const authConfig = (await request("/auth/config")).data;
    assert.equal(authConfig.terms, "本站创作服务说明");
    assert.equal(authConfig.supportEmail, "support@example.com");
    assert.equal(
      (
        await request(
          "/admin/models/image-test-2-5",
          {
            model: "image-test-2-5",
            display_name: "image-test-2-5",
            type: "image",
            protocol: "openai-image",
            channels: [],
            capabilities: { maxImages: 10, maxN: 2 },
          },
          "PATCH",
        )
      ).status,
      200,
    );
    const familyCatalog = (await request("/admin/models")).data;
    assert.equal(
      familyCatalog.find((m: any) => m.model === "image-test-2").protocol,
      "openai-image",
    );
    assert.equal(
      familyCatalog.find((m: any) => m.model === "image-test-2-5").adapter,
      "gpt-image-2",
    );
    assert.equal(
      familyCatalog.find((m: any) => m.model === "image-test-2-5").capability
        .maxImages,
      10,
    );
    assert.equal(
      familyCatalog.find((m: any) => m.model === "image-test-2-5").capability
        .maxN,
      2,
    );

    await define(
      "test-text",
      "language",
      "openai-chat",
      "qwen-plus",
      "million_tokens",
    );
    await define(
      "native-text",
      "language",
      "bailian-multimodal",
      "native-vl",
      "million_tokens",
    );
    await define(
      "test-tts",
      "speech",
      "bailian-tts",
      "qwen3-tts-flash",
      "million_characters",
    );
    await define(
      "test-audio",
      "speech",
      "bailian-audio",
      "qwen-audio-3.1-tts-next",
      "second",
    );
    await define(
      "test-asr",
      "speech",
      "bailian-asr",
      "qwen3-asr-flash-filetrans",
      "second",
    );
    await define("test-3d", "threed", "bailian-3d", "Tripo/Tripo-H3.1");
    await define(
      "test-video",
      "video",
      "bailian-video",
      "wan2.7-t2v",
      "second",
    );
    await define(
      "test-world",
      "world",
      "happyoyster",
      "happyoyster-1.0-adventure",
      "second",
    );
    await define(
      "test-live",
      "realtime",
      "bailian-realtime",
      "qwen3.5-omni-plus-realtime",
      "second",
    );
    await define(
      "test-inference",
      "realtime",
      "bailian-inference",
      "cosyvoice-v3-flash",
      "second",
    );
    const incompatible = await request("/admin/models", {
      model: "bad-image",
      display_name: "bad",
      type: "image",
      protocol: "openai-image",
      channels: link("gpt-image-2"),
    });
    assert.equal(incompatible.status, 400);
    const assetId = randomUUID();
    await db.query(
      "INSERT INTO assets(id,user_id,name,kind,object_key,storage,metadata,size,expires_at) VALUES($1,$2,'test-input.wav','audio','test/input.wav','local',$3,0,now()+interval '1 day')",
      [assetId, user.id, { duration: 5, mime: "audio/wav" }],
    );
    const imageId = randomUUID();
    await db.query(
      "INSERT INTO assets(id,user_id,name,kind,object_key,storage,metadata,size,expires_at) VALUES($1,$2,'test-image.png','image','test/input.png','local',$3,0,now()+interval '1 day')",
      [imageId, user.id, { width: 1600, height: 900, mime: "image/png" }],
    );
    const create = async (
      model: string,
      parameters: any = {},
      references: any[] = [],
      prompt = "测试创作",
    ) => {
      const input = { model, prompt, parameters, references };
      const q = await request("/capabilities/quote", input);
      assert.equal(q.status, 200, JSON.stringify(q.data));
      const body = {
        ...input,
        quoteToken: q.data.token,
        request_key: randomUUID(),
      };
      const r = await request("/capabilities", body);
      assert.equal(r.status, 202, JSON.stringify(r.data));
      const replay = await request("/capabilities", body);
      assert.equal(replay.data.id, r.data.id);
      return r.data;
    };
    const finish = async (id: string) => {
      for (let i = 0; i < 4; i++) {
        await processCapabilityJobs();
        await db.query(
          "UPDATE capability_jobs SET next_poll_at=now() WHERE id=$1",
          [id],
        );
        const job = (await request(`/capabilities/${id}`)).data;
        if (
          ["SUCCEEDED", "READY", "FAILED", "UNKNOWN", "RECONCILE"].includes(
            job.status,
          )
        )
          return job;
      }
      return (await request(`/capabilities/${id}`)).data;
    };
    for (const model of [
      "test-text",
      "native-text",
      "test-tts",
      "test-audio",
      "test-asr",
      "test-3d",
      "test-video",
    ]) {
      const j = await create(
        model,
        model === "test-video"
          ? { duration: 5, resolution: "1080P" }
          : { max_seconds: 10 },
        model === "test-asr" ? [{ asset_id: assetId }] : [],
      );
      const result = await finish(j.id);
      assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
      assert.equal(result.reserved, 0);
      if (model === "test-asr")
        assert.equal(result.output.text, "录音文件转写结果");
      if (model === "test-3d") {
        assert.equal(result.output.files[0].kind, "model");
        const response = await fetch(
          `http://127.0.0.1:4056${result.output.files[0].url}`,
          { headers: { Cookie: cookie } },
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "model/gltf-binary");
      }
      if (model === "test-audio")
        assert.equal(result.output.files[0].kind, "audio");
    }
    const videoCall = calls.find((c) => c.path.endsWith("video-synthesis"));
    assert.equal(videoCall?.body.model, "wan2.7-t2v");
    assert.equal(videoCall?.body.parameters.resolution, "1080P");
    assert.equal(videoCall?.headers["x-dashscope-async"], "enable");
    const threeCall = calls.find((c) => c.path.endsWith("3d-generation"));
    assert.equal(threeCall?.body.input.prompt, "测试创作");
    const asrCall = calls.find((c) => c.path.endsWith("transcription"));
    assert.ok(
      asrCall?.body.input.file_url.startsWith("https://assets.example/"),
    );
    const world = await create("test-world", { max_seconds: 60 }, [
      { asset_id: imageId },
    ]);
    const worldReady = await finish(world.id);
    assert.equal(worldReady.status, "READY", JSON.stringify(worldReady));
    const entered = await request(`/capabilities/${world.id}/world/start`, {});
    assert.equal(entered.status, 200, JSON.stringify(entered.data));
    assert.equal(entered.data.mode, 1);
    assert.ok(entered.data.rtcConfig.token);
    assert.equal(
      JSON.stringify(entered.data).includes("isolated-bailian-key"),
      false,
    );
    assert.equal(
      JSON.stringify(entered.data).includes("one-use-world-ticket"),
      false,
    );
    assert.equal(
      (
        await request(`/capabilities/${world.id}/world/control`, {
          action: "pause",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/capabilities/${world.id}/world/control`, {
          action: "end",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`/capabilities/${world.id}`)).data.status,
      "SUCCEEDED",
    );
    const connect = async (model: string, inference = false) => {
      const j = await create(model, { max_seconds: 10 });
      assert.equal((await finish(j.id)).status, "READY");
      const issued = await request(`/capabilities/${j.id}/realtime-ticket`, {});
      assert.equal(issued.status, 200, JSON.stringify(issued.data));
      const url = `ws://127.0.0.1:4056${issued.data.path}`;
      const client = new WebSocket(url, {
        headers: { Origin: "http://localhost:5173", Cookie: cookie },
      });
      const events: any[] = [];
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.terminate();
          reject(new Error("WS timeout"));
        }, 5000);
        client.on("error", reject);
        client.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
        client.on("message", (raw) => {
          const e = JSON.parse(raw.toString());
          events.push(e);
          if (e.type === "bridge.ready")
            client.send(
              JSON.stringify(
                inference
                  ? {
                      header: { action: "run-task" },
                      payload: { model: "forged-model" },
                    }
                  : {
                      type: "session.update",
                      session: { model: "forged-model" },
                    },
              ),
            );
          if (e.type === "session.updated")
            client.send(JSON.stringify({ type: "response.create" }));
          if (e.type === "response.done")
            client.send(JSON.stringify({ type: "bridge.end" }));
          if (e.header?.event === "task-started")
            client.send(JSON.stringify({ header: { action: "finish-task" } }));
        });
      });
      await completed;
      for (let i = 0; i < 20; i++) {
        const result = (await request(`/capabilities/${j.id}`)).data;
        if (result.settlement === "charged") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        (await request(`/capabilities/${j.id}`)).data.settlement,
        "charged",
      );
      const replay = new WebSocket(url, {
        headers: { Origin: "http://localhost:5173", Cookie: cookie },
      });
      const status = await new Promise<number>((resolve) => {
        replay.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode!);
          res.resume();
          replay.terminate();
        });
        replay.on("error", () => {});
      });
      assert.equal(status, 401);
      if (!inference) assert.ok(events.some((e) => e.delta === "实时回复"));
      else
        assert.equal(
          websocketCalls.find((e) => e.header?.action === "run-task").payload
            .model,
          "cosyvoice-v3-flash",
        );
    };
    await connect("test-live");
    await connect("test-inference", true);
    // A unified language route must also work through the text-node optimizer.
    const optimized = await fetch(api + "/language/optimize", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "test-text",
        prompt: "优化测试",
        reasoning: "auto",
      }),
    });
    assert.equal(optimized.status, 200);
    const optimizedText = await optimized.text();
    assert.match(optimizedText, /event: done/);
    assert.match(optimizedText, /多模态文本回复/);
    // Revoking a channel model removes its old route; changing a mapping updates future requests only.
    const editBody = {
      ...channelBody,
      models: [...channelBody.models, "test-text"],
      model_mapping: { "test-text": "qwen-plus" },
      request_key: undefined,
    };
    assert.equal(
      (await request(`/admin/channels/${groupId}`, editBody, "PATCH")).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/admin/channels/${groupId}`,
          { ...editBody, model_mapping: {} },
          "PATCH",
        )
      ).status,
      200,
    );
    const [identityRoute] = await db.query(
      "SELECT upstream_model FROM model_channels WHERE model='test-text' AND channel_id=$1",
      [groupId],
    );
    assert.equal(identityRoute.upstream_model, "test-text");
    assert.equal(
      (
        await request(
          `/admin/channels/${groupId}`,
          {
            ...editBody,
            models: editBody.models.filter((m) => m !== "test-text"),
            model_mapping: {},
          },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM model_channels WHERE model='test-text' AND channel_id=$1",
          [groupId],
        )
      ).length,
      0,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const racing = await create("test-audio", { max_seconds: 10 });
      const beforeCalls = calls.length;
      const [_, cancel] = await Promise.all([
        processCapabilityJobs(),
        request(`/capabilities/${racing.id}/cancel`, {}),
      ]);
      const ended = (await request(`/capabilities/${racing.id}`)).data;
      if (cancel.status === 200) {
        assert.equal(ended.status, "CANCELED");
        assert.equal(calls.length, beforeCalls);
      } else {
        assert.ok([400, 409].includes(cancel.status));
        assert.equal(ended.status, "SUCCEEDED");
      }
    }
    const preserved = await create("test-3d", {}, [], "删除前已提交的3D");
    await processCapabilityJobs();
    assert.equal(
      (await request(`/capabilities/${preserved.id}`)).data.status,
      "PENDING",
    );
    const queued = await create("test-audio", { max_seconds: 10 });
    const [before] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
      user.id,
    ]);
    assert.ok(Number(before.frozen) > 0);
    const deleted = await request(
      `/admin/channels/${groupId}`,
      undefined,
      "DELETE",
    );
    assert.equal(deleted.status, 200);
    await db.query(
      "UPDATE capability_jobs SET next_poll_at=now() WHERE id=$1",
      [preserved.id],
    );
    await processCapabilityJobs();
    assert.equal(
      (await request(`/capabilities/${preserved.id}`)).data.status,
      "SUCCEEDED",
    );
    assert.equal(
      (await request(`/capabilities/${queued.id}`)).data.status,
      "CANCELED",
    );
    assert.equal(
      (await request("/admin/channels")).data.some(
        (c: any) => c.id === groupId,
      ),
      false,
    );
    const [after] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
      user.id,
    ]);
    assert.equal(Number(after.frozen), 0);
    assert.ok(
      (
        await db.query(
          "SELECT * FROM provider_channel_versions WHERE channel_id=$1",
          [groupId],
        )
      ).length,
    );
    const another = await request("/capabilities/quote", {
      model: "test-audio",
      prompt: "x",
      parameters: { max_seconds: 5 },
    });
    const noChannel = await request("/capabilities", {
      model: "test-audio",
      prompt: "x",
      parameters: { max_seconds: 5 },
      quoteToken: another.data.token,
      request_key: randomUUID(),
    });
    assert.equal(noChannel.status, 503);
  } catch (error) {
    // Continue only through the outer cleanup; assertions must remain visible.
    throw error;
  } finally {
    await app.close();
    await closeDb();
    for (const c of upstreamWs.clients) c.terminate();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
