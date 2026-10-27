import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  DEFAULT_IMAGE_PARAMETERS,
  IMAGE_MODEL_IDS,
  IMAGE_OFFICIAL_PRICES,
  MODEL_CAPABILITIES,
  getSizeCategory,
  imageGenerationSchema,
  validateImageGeneration,
} from "../shared/image";

test("image capabilities, model-specific limits, and price tiers", () => {
  assert.equal(IMAGE_MODEL_IDS.length, 5);
  assert.deepEqual(IMAGE_OFFICIAL_PRICES["qwen-image-3.0-pro"]["2K"], {
    input: 0.02,
    output: 0.5,
  });
  assert.equal(IMAGE_OFFICIAL_PRICES["gpt-image-2.5-flare"]["4K"].output, 0.2);
  assert.equal(getSizeCategory("1536x1024", "qwen-image-3.0"), "1K");
  assert.equal(getSizeCategory("1536x1024", "gpt-image-2"), "2K");

  const base = {
    model: "qwen-image-3.0-pro",
    mode: "text",
    input: { prompt: "A red paper crane in soft daylight" },
    parameters: { ...DEFAULT_IMAGE_PARAMETERS, size: "auto" },
  };
  assert.equal(validateImageGeneration(base).sizeCategory, "2K");

  const image = { kind: "image", extension: "png", width: 1024, height: 768, size: 2000 };
  const references = Array.from({ length: 3 }, () => ({ type: "reference_image", asset_id: crypto.randomUUID() }));
  assert.equal(
    validateImageGeneration(
      { ...base, mode: "image", input: { ...base.input, images: references } },
      [image, image, image],
    ).inputCount,
    3,
  );
  assert.throws(() =>
    validateImageGeneration(
      { ...base, mode: "image", input: { ...base.input, images: [...references, references[0]] } },
      [image, image, image, image],
    ),
  );
  assert.throws(() =>
    validateImageGeneration({
      ...base,
      model: "gpt-image-2",
      input: { ...base.input, images: [references[0]] },
      mode: "image",
      parameters: { ...base.parameters, size: "4096x2160", negative_prompt: "text" },
    }),
  );
  assert.equal(
    imageGenerationSchema.parse({ ...base, input: { prompt: "  a lighthouse  " } }).input.prompt,
    "  a lighthouse  ",
  );
  assert.ok(MODEL_CAPABILITIES["gpt-image-2"].maxImages > 0);
});

test("Qwen image quote, queue, polling, delivery, and settlement", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "infinite-canvas-images-"));
  process.env.DATA_DIR = dir;
  process.env.PORT = "4041";
  process.env.HOST = "127.0.0.1";
  process.env.APP_ORIGIN = "http://localhost:5173";
  process.env.DISABLE_WORKER = "1";
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;

  const { app } = await import("../server/main");
  const { db, transaction, closeDb } = await import("../server/db");
  const { walletEntry } = await import("../server/finance");
  const { dispatchImageTask, pollImageTasks, saveImageResults } = await import("../server/images");
  const base = "http://127.0.0.1:4041/api/v1";
  let cookie = "";
  const request = async (endpoint: string, body?: unknown, headers: Record<string, string> = {}, method?: string) => {
    const response = await fetch(base + endpoint, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: "http://localhost:5173",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined || method === "DELETE" ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  try {
    const setup = await request("/auth/setup", {
      username: "imageadmin",
      password: "test-password-123",
      display_name: "Image Admin",
    });
    assert.equal(setup.status, 200);
    const setupResponse = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "imageadmin", password: "test-password-123" }),
    });
    cookie = setupResponse.headers.get("set-cookie")!.split(";")[0];
    const admin = (await setupResponse.json()).user;

    const imagePriceRows = await request("/admin/image-prices");
    const editableImagePrice = imagePriceRows.data.find(
      (price: any) => price.model === "gpt-image-2.5-flare" && price.size_category === "1K",
    );
    assert.ok(editableImagePrice);
    const modelCatalog = await request("/models");
    assert.equal(modelCatalog.status, 200);
    assert.ok(modelCatalog.data.models.includes("wan3.0-video"));
    assert.ok(modelCatalog.data.models.includes("gpt-image-2.5-flare"));
    assert.equal(
      modelCatalog.data.imagePrices.find(
        (price: any) => price.model === editableImagePrice.model && price.size_category === "1K",
      ).output_sale,
      Number(editableImagePrice.output_sale_micro) / 1e6,
    );
    const originalPrice = {
      input_official: Number(editableImagePrice.input_official_micro) / 1e6,
      input_sale: Number(editableImagePrice.input_sale_micro) / 1e6,
      output_official: Number(editableImagePrice.output_official_micro) / 1e6,
      output_sale: Number(editableImagePrice.output_sale_micro) / 1e6,
      enabled: editableImagePrice.enabled,
    };
    assert.equal(
      (await request("/admin/image-prices", {
        ...originalPrice,
        model: "qwen-image-3.0-pro",
        size_category: "4K",
      })).status,
      400,
    );
    const editedPrice = { ...originalPrice, output_sale: originalPrice.output_sale + 0.01 };
    assert.equal(
      (await request(`/admin/image-prices/${editableImagePrice.id}`, editedPrice, {}, "PATCH")).status,
      200,
    );
    const updatedImagePrice = (await request("/admin/image-prices")).data.find(
      (price: any) => price.id === editableImagePrice.id,
    );
    assert.equal(updatedImagePrice.version, editableImagePrice.version + 1);
    assert.equal(
      (await request("/models")).data.imagePrices.find(
        (price: any) => price.model === editableImagePrice.model && price.size_category === "1K",
      ).output_sale,
      editedPrice.output_sale,
    );
    assert.equal(
      (await request(`/admin/image-prices/${editableImagePrice.id}`, undefined, {}, "DELETE")).status,
      200,
    );
    assert.equal(
      (await request("/models")).data.imagePrices.some(
        (price: any) => price.id === editableImagePrice.id,
      ),
      false,
    );
    const restoredPrice = await request(
      "/admin/image-prices",
      {
        ...originalPrice,
        model: editableImagePrice.model,
        size_category: editableImagePrice.size_category,
      },
    );
    assert.equal(restoredPrice.status, 200);
    assert.equal(
      (await request("/admin/image-prices", {
        ...originalPrice,
        model: editableImagePrice.model,
        size_category: editableImagePrice.size_category,
      })).status,
      409,
    );

    const openAiChannel = await request("/admin/channels", {
      provider: "openai",
      name: "Test OpenAI Relay",
      baseUrl: "https://images.example/v1",
      key: "test-openai-channel-key",
      models: ["gpt-image-2.5-flare"],
      priority: 7,
      enabled: true,
    });
    assert.equal(openAiChannel.status, 200);
    assert.equal(openAiChannel.data.videoId, null);
    assert.ok(openAiChannel.data.imageId);
    const managedChannels = await request("/admin/channels");
    assert.equal(managedChannels.status, 200);
    const visibleOpenAi = managedChannels.data.find((row: any) => row.name === "Test OpenAI Relay");
    assert.equal(visibleOpenAi.provider, "openai");
    assert.equal(visibleOpenAi.base_url, "https://images.example/v1");
    assert.deepEqual(visibleOpenAi.models, ["gpt-image-2.5-flare"]);
    assert.equal(JSON.stringify(visibleOpenAi).includes("test-openai-channel-key"), false);
    assert.equal("encrypted_key" in visibleOpenAi, false);

    const rejectedChannel = await request("/admin/channels", {
      provider: "openai",
      name: "Invalid OpenAI Relay",
      baseUrl: "https://images.example/v1",
      key: "test-invalid-channel-key",
      models: ["qwen-image-3.0"],
      enabled: true,
    });
    assert.equal(rejectedChannel.status, 400);

    const channel = await request("/admin/image-credentials", {
      provider: "qwen",
      name: "Test Qwen",
      workspace: "test-workspace",
      key: "test-api-key",
      priority: 0,
      enabled: true,
    });
    assert.equal(channel.status, 200);
    const visibleChannels = await request("/admin/image-credentials");
    assert.equal(visibleChannels.status, 200);
    assert.equal(visibleChannels.data[0].workspace, "test-workspace");
    assert.equal("encrypted_key" in visibleChannels.data[0], false);

    await transaction((tx) =>
      walletEntry(tx, admin.id, {
        type: "recharge",
        amount: 2_000_000,
        key: "image-test-credit",
        reason: "image test funding",
      }),
    );

    const input = {
      model: "qwen-image-3.0-pro",
      mode: "text",
      input: { prompt: "A small red paper crane on white" },
      parameters: { ...DEFAULT_IMAGE_PARAMETERS, size: "1024x1024", n: 2 },
    };
    const quote = await request("/image-quotes", input);
    assert.equal(quote.status, 200);
    assert.equal(quote.data.sizeCategory, "1K");
    assert.equal(quote.data.reserved, 0.5);

    const submitted = await request(
      "/image-generations",
      { ...quote.data.input, quote: quote.data.token },
      { "Idempotency-Key": "image-test-idempotency-1" },
    );
    assert.equal(submitted.status, 202, JSON.stringify(submitted.data));
    assert.equal(submitted.data.status, "QUEUED");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({ output: { task_id: "qwen-image-task-1", task_status: "PENDING" } })) as typeof fetch;
      await dispatchImageTask();
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal((await request(`/image-generations/${submitted.data.id}`)).data.status, "PENDING");

    await db.query("UPDATE image_tasks SET next_poll_at=now() WHERE id=$1", [submitted.data.id]);
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#d54335" },
    }).png().toBuffer();
    const base64 = `data:image/png;base64,${png.toString("base64")}`;
    try {
      globalThis.fetch = (async () =>
        Response.json({
          output: {
            task_status: "SUCCEEDED",
            choices: [{ message: { content: [{ image: base64 }, { image: base64 }] } }],
          },
          usage: { input_image_count: 0, output_image_count: 2, output_image_type: "qima_output_1k" },
        })) as typeof fetch;
      await pollImageTasks();
    } finally {
      globalThis.fetch = originalFetch;
    }
    await saveImageResults();

    const completed = await request(`/image-generations/${submitted.data.id}`);
    assert.equal(completed.data.status, "SUCCEEDED");
    assert.equal(completed.data.result_assets.length, 2);
    assert.equal(completed.data.actual_output_count, 2);
    assert.equal(completed.data.charged, 0.5);
    const [chargeEntry] = await db.query(
      "SELECT task_id,image_task_id,type,amount,frozen_delta FROM ledger WHERE business_key=$1",
      [`image-settle:${submitted.data.id}`],
    );
    assert.equal(chargeEntry.task_id, null);
    assert.equal(chargeEntry.image_task_id, submitted.data.id);
    assert.equal(chargeEntry.type, "settle");
    assert.equal(Number(chargeEntry.amount), 0);
    assert.equal(Number(chargeEntry.frozen_delta), -500_000);
    const [wallet] = await db.query("SELECT available,frozen FROM wallets WHERE user_id=$1", [admin.id]);
    assert.equal(Number(wallet.frozen), 0);
    assert.equal(Number(wallet.available), 1_500_000);
  } finally {
    globalThis.fetch = fetch;
    await app.close();
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
