import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { DEFAULT_PARAMETERS } from "../shared/wan";
import { DEFAULT_IMAGE_PARAMETERS } from "../shared/image";

test("dynamic catalog, per-user discounts, mapped routes, and real SSE optimization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-catalog-"));
  Object.assign(process.env, {
    DATA_DIR: dir,
    PORT: "4051",
    HOST: "127.0.0.1",
    APP_ORIGIN: "http://localhost:5173",
    DISABLE_WORKER: "1",
  });
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const calls: any[] = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer mock-key");
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "wire-language" }, { id: "custom-alias" }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    if (body.model === "fail-model") {
      res.writeHead(401);
      res.end("secret should never be forwarded");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (value: any) => `data: ${JSON.stringify(value)}\r\n\r\n`;
    if (body.model === "broken-stream") {
      res.end(event({ choices: [{ delta: { content: "部分优化文本" } }] }));
      return;
    }
    if (body.model === "no-usage") {
      res.write(
        event({ choices: [{ delta: { content: "没有 usage 的优化结果" } }] }),
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    res.write(
      event({ choices: [{ delta: { reasoning_content: "正在分析" } }] }),
    );
    const data = Buffer.from(
      event({
        choices: [
          { delta: { content: "柔和晨光下的红色纸鹤，细腻纸张纹理。" } },
        ],
      }),
    );
    // Split in the middle of a multi-byte UTF-8 sequence.
    res.write(data.subarray(0, 45));
    await new Promise((resolve) => setTimeout(resolve, 2));
    res.write(data.subarray(45, -1));
    await new Promise((resolve) => setTimeout(resolve, 2));
    res.write(data.subarray(-1));
    res.write(event({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    res.write(
      event({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const { app } = await import("../server/main");
  const { db, closeDb, migrate, transaction } = await import("../server/db");
  const { walletEntry } = await import("../server/finance");
  const { settleSuccess } = await import("../server/generations");
  const { recoverLanguageRuns } = await import("../server/language");
  let cookie = "";
  const base = "http://127.0.0.1:4051/api/v1";
  const request = async (endpoint: string, body?: any, method?: string) => {
    const response = await fetch(base + endpoint, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: "http://localhost:5173",
        "Idempotency-Key": randomUUID(),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const stream = async (endpoint: string, body: any) => {
    const response = await fetch(base + endpoint, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    const response = await fetch(base + "/auth/setup", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "catalogadmin",
        password: "catalog-test-123",
        display_name: "Catalog Admin",
      }),
    });
    const admin = (await response.json()).user;
    cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await request("/models")).data.catalog.length, 7);
    await transaction((tx) =>
      walletEntry(tx, admin.id, {
        type: "recharge",
        amount: 10_000_000,
        key: "catalog-fund",
        reason: "isolated test",
      }),
    );
    const discovered = await request("/admin/language-channels/discover", {
      baseUrl: upstreamUrl,
      key: "mock-key",
    });
    assert.deepEqual(discovered.data.models, ["custom-alias", "wire-language"]);
    const created = await request("/admin/language-channels", {
      name: "Mock language",
      baseUrl: upstreamUrl,
      key: "mock-key",
      models: [
        "custom-alias",
        "wire-language",
        "fail-model",
        "no-usage",
        "broken-stream",
      ],
      model_mapping: { "custom-alias": "wire-language" },
    });
    assert.equal(created.status, 201);
    const channel = created.data.id;
    const publicChannels = await request("/admin/channels");
    assert.equal(
      JSON.stringify(publicChannels.data).includes("mock-key"),
      false,
    );
    assert.equal(
      JSON.stringify(publicChannels.data).includes("encrypted_key"),
      false,
    );
    const testStream = await stream("/admin/language-channels/test", {
      id: channel,
      model: "custom-alias",
      prompt: "Hi",
      reasoning: "high",
    });
    assert.equal(testStream.status, 200);
    assert.match(testStream.text, /event: delta/);
    assert.match(testStream.text, /纸鹤/);
    assert.match(testStream.text, /event: done/);
    assert.equal(calls.at(-1).model, "wire-language");
    assert.equal(calls.at(-1).messages[0].content, "Hi");
    assert.equal(calls.at(-1).reasoning_effort, "high");
    assert.equal(calls.at(-1).stream, true);
    const modelBody = {
      model: "custom-alias",
      display_name: "灵感编辑",
      type: "language",
      input_price: 10,
      output_price: 20,
      channels: [
        { id: channel, source: "language", upstream_model: "wire-language" },
      ],
    };
    assert.equal((await request("/admin/models", modelBody)).status, 201);
    assert.equal((await request("/admin/models", modelBody)).status, 409);
    assert.equal(
      (
        await request(
          `/admin/users/${admin.id}`,
          { discount_multiplier: 0.8 },
          "PATCH",
        )
      ).status,
      200,
    );
    const catalog = (await request("/models")).data;
    assert.equal(catalog.multiplier, 0.8);
    const language = catalog.catalog.find(
      (m: any) => m.model === "custom-alias",
    );
    assert.equal(language.prices[0].input_sale, 8);
    assert.equal(language.channels[0].name, "Mock language");
    const requestKey = randomUUID();
    const optimized = await stream("/language/optimize", {
      request_key: requestKey,
      model: "custom-alias",
      prompt: "一只红色纸鹤",
      reasoning: "medium",
    });
    assert.equal(optimized.status, 200, optimized.text);
    assert.match(optimized.text, /event: done/);
    assert.match(optimized.text, /柔和晨光/);
    assert.match(optimized.text, /"charged":0.00144/);
    assert.equal(calls.at(-1).messages[0].role, "system");
    assert.match(calls.at(-1).messages[0].content, /优化/);
    assert.equal(calls.at(-1).messages[1].content, "一只红色纸鹤");
    assert.equal(calls.at(-1).model, "wire-language");
    const [run] = await db.query(
      "SELECT * FROM language_runs WHERE model='custom-alias'",
    );
    assert.equal(run.status, "completed");
    assert.equal(Number(run.charged_micro), 1440);
    assert.equal(Number(run.reserved_micro), 0);
    assert.equal(Number(run.discount_multiplier), 0.8);
    const callCount = calls.length;
    const duplicateStream = await stream("/language/optimize", {
      request_key: requestKey,
      model: "custom-alias",
      prompt: "一只红色纸鹤",
      reasoning: "medium",
    });
    assert.match(duplicateStream.text, /"replayed":true/);
    assert.match(duplicateStream.text, /柔和晨光/);
    assert.equal(calls.length, callCount);
    assert.equal(
      (
        await stream("/language/optimize", {
          request_key: requestKey,
          model: "custom-alias",
          prompt: "不同的提示词",
          reasoning: "medium",
        })
      ).status,
      409,
    );
    for (const [name, upstreamModel] of [
      ["failed-language", "fail-model"],
      ["estimated-language", "no-usage"],
      ["broken-language", "broken-stream"],
    ]) {
      assert.equal(
        (
          await request("/admin/models", {
            ...modelBody,
            model: name,
            display_name: name,
            channels: [
              {
                id: channel,
                source: "language",
                upstream_model: upstreamModel,
              },
            ],
          })
        ).status,
        201,
      );
      const [before] = await db.query(
        "SELECT * FROM wallets WHERE user_id=$1",
        [admin.id],
      );
      const result = await stream("/language/optimize", {
        model: name,
        prompt: "测试提示词",
      });
      assert.equal(result.status, 200);
      const [saved] = await db.query(
        "SELECT * FROM language_runs WHERE model=$1",
        [name],
      );
      const [after] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
        admin.id,
      ]);
      assert.equal(Number(after.frozen), Number(before.frozen));
      if (upstreamModel === "fail-model") {
        assert.match(result.text, /event: error/);
        assert.equal(Number(saved.charged_micro), 0);
        assert.equal(Number(after.available), Number(before.available));
      } else if (upstreamModel === "no-usage") {
        assert.match(result.text, /"estimated":true/);
        assert.equal(saved.status, "completed");
        assert.ok(Number(saved.charged_micro) > 0);
      } else {
        assert.match(result.text, /event: error/);
        assert.match(result.text, /部分优化文本/);
        assert.equal(saved.status, "interrupted");
        assert.ok(Number(saved.charged_micro) > 0);
      }
    }

    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM ledger WHERE language_run_id=$1",
          [run.id],
        )
      )[0].count,
      1,
    );
    const recoveryId = randomUUID();
    const [beforeRecovery] = await db.query(
      "SELECT * FROM wallets WHERE user_id=$1",
      [admin.id],
    );
    await transaction(async (tx) => {
      await tx.query(
        "INSERT INTO language_runs(id,user_id,model,channel_id,upstream_model,input_price_micro,output_price_micro,discount_multiplier,reserved_micro,created_at) VALUES($1,$2,'custom-alias',$3,'wire-language',8000000,16000000,0.8,500,now()-interval '11 minutes')",
        [recoveryId, admin.id, channel],
      );
      await walletEntry(tx, admin.id, {
        type: "reserve",
        amount: -500,
        frozen: 500,
        key: `recovery-fixture:${recoveryId}`,
        reason: "simulated crash",
      });
    });
    await recoverLanguageRuns();
    await recoverLanguageRuns();
    const [afterRecovery] = await db.query(
      "SELECT * FROM wallets WHERE user_id=$1",
      [admin.id],
    );
    assert.equal(
      Number(afterRecovery.available),
      Number(beforeRecovery.available),
    );
    assert.equal(Number(afterRecovery.frozen), Number(beforeRecovery.frozen));
    assert.equal(
      (
        await db.query("SELECT status FROM language_runs WHERE id=$1", [
          recoveryId,
        ])
      )[0].status,
      "interrupted",
    );
    const imageRows = (await request("/admin/image-prices")).data;
    const removedTier = imageRows.find(
      (p: any) => p.model === "gpt-image-2" && p.size_category === "4K",
    );
    await request(`/admin/image-prices/${removedTier.id}`, undefined, "DELETE");
    const replacement = {
      model: "gpt-image-2",
      size_category: "4K",
      input_official: 0,
      input_sale: 0,
      output_official: 0.15,
      output_sale: 0.15,
      enabled: true,
    };
    const concurrent = await Promise.all([
      request("/admin/image-prices", replacement),
      request("/admin/image-prices", replacement),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM image_prices WHERE model='gpt-image-2' AND size_category='4K' AND deleted_at IS NULL",
        )
      )[0].count,
      1,
    );
    await assert.rejects(
      db.query(
        "INSERT INTO image_prices(id,model,size_category,input_official_micro,input_sale_micro,output_official_micro,output_sale_micro) VALUES(gen_random_uuid(),'gpt-image-2','4K',0,0,150000,150000)",
      ),
      (error: any) => error.code === "23505",
    );
    const vc = await request("/admin/channels", {
      provider: "bailian",
      name: "Mock media",
      workspace: "mock-workspace",
      key: "mock-key",
      models: ["wan3.0-video", "qwen-image-3.0"],
      multiplier: 0.5,
    });
    assert.equal(vc.status, 200);
    const customVideo = {
      model: "studio-video",
      display_name: "工作室视频",
      type: "video",
      adapter: "wan3.0-video",
      channels: [
        { id: vc.data.videoId, source: "video", upstream_model: "wire-video" },
      ],
      tiers: [{ tier: "1080P", official: 1.2, sale: 1.2 }],
    };
    assert.equal((await request("/admin/models", customVideo)).status, 201);
    const input = {
      model: "studio-video",
      mode: "text",
      input: { prompt: "a paper crane", media: [] },
      parameters: { ...DEFAULT_PARAMETERS },
    };
    const quote = await request("/quotes", input);
    assert.equal(quote.status, 200, JSON.stringify(quote.data));
    assert.equal(quote.data.unitPrice, 0.96);
    assert.equal(quote.data.reserved, 4.8);
    const taskResponse = await fetch(base + "/generations", {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        Cookie: cookie,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ input, quoteToken: quote.data.token }),
    });
    assert.equal(taskResponse.status, 202);
    const task = await taskResponse.json();
    const [storedTask] = await db.query("SELECT * FROM tasks WHERE id=$1", [
      task.id,
    ]);
    assert.equal(storedTask.upstream_model, "wire-video");
    assert.equal(Number(storedTask.price_micro), 960000);
    assert.equal(Number(storedTask.base_price_micro), 1200000);
    assert.equal(
      (
        await request(
          `/admin/users/${admin.id}`,
          { discount_multiplier: 0.5 },
          "PATCH",
        )
      ).status,
      200,
    );
    await db.query(
      "UPDATE tasks SET status='RUNNING',upstream_id='mock-video',attempts=1 WHERE id=$1",
      [task.id],
    );
    await settleSuccess(task.id, {
      output: {
        task_id: "mock-video",
        task_status: "SUCCEEDED",
        video_url: "https://media.example/video.mp4",
      },
      usage: {
        video_count: 1,
        duration: 5,
        input_video_duration: 0,
        output_video_duration: 5,
        SR: 1080,
      },
    });
    const [settled] = await db.query("SELECT * FROM tasks WHERE id=$1", [
      task.id,
    ]);
    assert.equal(Number(settled.charged_micro), 4800000);
    assert.equal(Number(settled.cost_micro), 3000000);
    const stale = await request("/generations", {
      input,
      quoteToken: quote.data.token,
    });
    assert.equal(stale.status, 400);
    assert.match(stale.data.message, /价格|倍率/);
    assert.equal(
      (
        await request(
          "/admin/models/studio-video",
          { ...customVideo, enabled: false },
          "PATCH",
        )
      ).status,
      200,
    );
    const adminVideo = (await request("/admin/models")).data.find(
      (m: any) => m.model === "studio-video",
    );
    assert.equal(adminVideo.prices[0].enabled, true);
    assert.equal(
      (await request("/models")).data.catalog.find(
        (m: any) => m.model === "studio-video",
      ).prices[0].enabled,
      false,
    );
    assert.equal(
      (await request("/admin/models/studio-video", customVideo, "PATCH"))
        .status,
      200,
    );
    assert.equal(
      (
        await request("/admin/models", {
          model: "unrouted-video",
          display_name: "尚未关联的视频",
          type: "video",
          adapter: "wan3.0-video",
          channels: [],
          tiers: [{ tier: "1080P", official: 1.2, sale: 1.2 }],
        })
      ).status,
      201,
    );
    const unroutedInput = { ...input, model: "unrouted-video" };
    const unroutedQuote = await request("/quotes", unroutedInput);
    assert.equal(unroutedQuote.status, 200);
    const unroutedTask = await request("/generations", {
      input: unroutedInput,
      quoteToken: unroutedQuote.data.token,
    });
    assert.equal(unroutedTask.status, 503);
    assert.match(unroutedTask.data.message, /渠道/);
    const imageInput = {
      model: "qwen-image-3.0",
      mode: "text",
      input: { prompt: "paper crane", images: [] },
      parameters: { ...DEFAULT_IMAGE_PARAMETERS },
    };
    const imageQuote = await request("/image-quotes", imageInput);
    assert.equal(imageQuote.status, 200, JSON.stringify(imageQuote.data));
    assert.equal(imageQuote.data.outputPrice, 0.09);
    const imageTask = await request("/image-generations", {
      ...imageInput,
      quote: imageQuote.data.token,
    });
    assert.equal(imageTask.status, 202, JSON.stringify(imageTask.data));
    const [savedImage] = await db.query(
      "SELECT * FROM image_tasks WHERE id=$1",
      [imageTask.data.id],
    );
    assert.equal(Number(savedImage.output_unit_micro), 90000);
    assert.equal(Number(savedImage.price_snapshot["1K"].output), 90000);
    const imageModel = {
      model: "studio-image",
      display_name: "工作室图片",
      type: "image",
      adapter: "qwen-image-3.0",
      channels: [
        { id: vc.data.imageId, source: "image", upstream_model: "wire-image" },
      ],
      tiers: [
        {
          tier: "1K",
          input_official: 0.02,
          input_sale: 0.02,
          output_official: 0.18,
          output_sale: 0.18,
        },
      ],
    };
    assert.equal((await request("/admin/models", imageModel)).status, 201);
    const aliasImageInput = { ...imageInput, model: "studio-image" };
    const aliasQuote = await request("/image-quotes", aliasImageInput);
    assert.equal(aliasQuote.status, 200, JSON.stringify(aliasQuote.data));
    const aliasImageTask = await request("/image-generations", {
      ...aliasImageInput,
      quote: aliasQuote.data.token,
    });
    assert.equal(
      aliasImageTask.status,
      202,
      JSON.stringify(aliasImageTask.data),
    );
    const [mappedImage] = await db.query(
      "SELECT * FROM image_tasks WHERE id=$1",
      [aliasImageTask.data.id],
    );
    assert.equal(mappedImage.upstream_model, "wire-image");
    assert.equal(mappedImage.credential_id, vc.data.imageId);
    assert.equal(Number(mappedImage.output_unit_micro), 90000);

    assert.equal(
      (
        await request("/admin/models", {
          model: "voice-studio",
          display_name: "语音工作室",
          type: "speech",
          billing_unit: "million_characters",
          input_price: 2,
          output_price: 3,
        })
      ).status,
      201,
    );
    assert.equal(
      (await request("/models")).data.catalog.find(
        (m: any) => m.model === "voice-studio",
      ).billing_unit,
      "million_characters",
    );
    assert.equal(
      (await request("/admin/models/custom-alias", undefined, "DELETE")).status,
      200,
    );
    await migrate();
    assert.equal(
      (await request("/models")).data.models.includes("custom-alias"),
      false,
    );
    const unavailable = await stream("/language/optimize", {
      model: "custom-alias",
      prompt: "a crane",
    });
    assert.equal(unavailable.status, 503);
    const [wallet] = await db.query("SELECT * FROM wallets WHERE user_id=$1", [
      admin.id,
    ]);
    assert.ok(Number(wallet.available) >= 0);
    assert.ok(Number(wallet.frozen) >= 0);
  } finally {
    await app.close();
    await closeDb();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
