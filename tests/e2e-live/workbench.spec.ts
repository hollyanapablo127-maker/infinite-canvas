import { test, expect } from "@playwright/test";
import http from "node:http";
test("Bailian TTS from administrator preset to quoted workbench result and audio player", async ({
  page,
}) => {
  const calls: any[] = [];
  const wav = Buffer.alloc(44 + 24000 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    calls.push({
      path: req.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        output: {
          audio: {
            url: "data:audio/wav;base64," + wav.toString("base64"),
            duration: 1,
          },
        },
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto("/");
    await page.getByLabel("账号", { exact: true }).fill("ttsadmin");
    await page
      .getByLabel("密码（至少 8 位）", { exact: true })
      .fill("test-workbench-123");
    await page.getByLabel("显示名称").fill("TTS管理员");
    await page.getByRole("button", { name: "初始化并进入" }).click();
    await expect(
      page.getByRole("heading", { name: "我的画布", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "渠道管理", exact: true }).click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await page.getByRole("button", { name: /^百炼 API/ }).click();
    await page.getByLabel("渠道名称", { exact: true }).fill("TTS端到端渠道");
    await page
      .getByLabel("API Base URL", { exact: true })
      .fill(`http://127.0.0.1:${(server.address() as any).port}`);
    await page
      .getByLabel("百炼 API Key", { exact: true })
      .fill("isolated-tts-key");
    await page.getByRole("checkbox", { name: /qwen3-tts-flash/ }).check();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "添加渠道", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: "模型定价", exact: true }).click();
    await page.getByLabel("百炼模型预设").selectOption("qwen3-tts-flash");
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("checkbox", { name: "TTS端到端渠道", exact: true })
      .check();
    await dialog.getByRole("button", { name: "添加并发布模型" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: "多模态工作台", exact: true }).click();
    await page.getByLabel("多模态模型").selectOption("qwen3-tts-flash");
    await page.getByLabel("多模态提示词").fill("你好，让灵感拥有自己的声音。");
    await page.getByLabel("合成音色").fill("Cherry");
    await page.getByRole("button", { name: "开始创作", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("本次最多预占");
    await page.getByRole("button", { name: "确认并提交", exact: true }).click();
    await expect(page.locator(".capability-result")).toContainText("已完成", {
      timeout: 20000,
    });
    await expect(page.locator(".capability-result audio")).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.path.endsWith("/multimodal-generation/generation") &&
          c.body.model === "qwen3-tts-flash" &&
          c.body.input.text === "你好，让灵感拥有自己的声音。",
      ),
    ).toBe(true);
    await expect(page.locator(".workbench-history")).toContainText("已完成");
    await page.screenshot({
      path: "test-results/bailian-tts-result-desktop.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/bailian-tts-result-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
