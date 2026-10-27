import { test, expect } from "@playwright/test";
import http from "node:http";

test("language channel discovery, real stream test, catalog filters and prompt comparison", async ({
  page,
}) => {
  test.setTimeout(120000);
  const calls: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "wire-browser" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const output = body.messages.some((m: any) => m.role === "system")
      ? "柔和的晨光洒在一只红色纸鹤上，纸张纹理细腻，背景简洁，特写构图。"
      : "Hi！真实流式连接已建立。";
    for (const text of [
      output.slice(0, 8),
      output.slice(8, 18),
      output.slice(18),
    ]) {
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 60 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto("/");
    const config = await (await page.request.get("/api/v1/auth/config")).json();
    if (config.setupRequired) {
      await page.getByLabel("账号", { exact: true }).fill("browseradmin");
      await page
        .getByLabel("密码（至少 8 位）", { exact: true })
        .fill("browser-test-123");
      await page.getByLabel("显示名称").fill("浏览器管理员");
      await page.getByRole("button", { name: "初始化并进入" }).click();
    } else {
      await page.getByLabel("邮箱或账号", { exact: true }).fill("browseradmin");
      await page.getByLabel("密码", { exact: true }).fill("browser-test-123");
      await page.getByRole("button", { name: "登录", exact: true }).click();
    }
    await expect(
      page.getByRole("heading", { name: "我的画布", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "渠道管理", exact: true }).click();
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await page.getByRole("button", { name: /^语言/ }).click();
    await page.getByLabel("语言渠道名称").fill("浏览器语言渠道");
    await page
      .getByLabel("语言渠道 Base URL")
      .fill(`http://127.0.0.1:${(server.address() as any).port}/v1`);
    await page.getByLabel("语言渠道 API Key").fill("mock-browser-key");
    await page.getByRole("button", { name: "自动获取模型" }).click();
    await expect(
      page.getByRole("checkbox", { name: "wire-browser", exact: true }),
    ).toBeChecked();
    await page.getByLabel("自定义语言模型").fill("browser-language");
    await page.getByRole("button", { name: "添加模型", exact: true }).click();
    await page.getByLabel("browser-language 的上游模型").fill("wire-browser");
    await page.getByLabel("测试语言模型").selectOption("browser-language");
    await page.getByLabel("测试思考强度").selectOption("high");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "测试连接", exact: true })
      .click();
    await expect(page.locator(".stream-test-result")).toContainText(
      "真实流式连接已建立",
    );
    await expect(page.locator(".stream-state")).toHaveText("流式回复已完成");
    expect(calls.at(-1).model).toBe("wire-browser");
    expect(calls.at(-1).reasoning_effort).toBe("high");
    expect(calls.at(-1).messages[0].content).toBe("Hi");
    await page.screenshot({
      path: "test-results/language-channel-stream-desktop.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "保存语言渠道" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: "模型定价", exact: true }).click();
    await page.getByRole("button", { name: "添加模型", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "语言模型", exact: true }).click();
    await dialog
      .getByLabel("模型 ID", { exact: true })
      .fill("browser-language");
    await dialog.getByLabel("模型显示名称").fill("灵感助手");
    await dialog
      .getByRole("checkbox", { name: "浏览器语言渠道", exact: true })
      .check();
    await dialog.getByLabel("模型输入价").fill("1");
    await dialog.getByLabel("模型输出价").fill("2");
    await dialog.getByRole("button", { name: "添加并发布模型" }).click();
    await page.getByRole("link", { name: "模型广场", exact: true }).click();
    await page
      .locator(".market-filters")
      .getByRole("button", { name: /语言模型/ })
      .click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    await page
      .locator(".market-filters")
      .getByRole("button", { name: /浏览器语言渠道/ })
      .click();
    await expect(page.locator(".model-card")).toContainText("灵感助手");
    await expect(page.locator(".price-table")).toHaveCount(0);
    await page.getByRole("button", { name: "查看 灵感助手 价格详情" }).click();
    await expect(page.getByRole("dialog")).toContainText("百万 token");
    await page.getByRole("button", { name: "在文本节点中使用" }).click();
    await expect(page.locator(".text-node")).toHaveCount(1);
    await page.locator(".text-node .node-head").click();
    await page.getByLabel("文本内容", { exact: true }).fill("一只红色纸鹤");
    await expect(
      page
        .locator(".text-node")
        .getByRole("checkbox", { name: "AI智能优化提示词", exact: true }),
    ).toBeChecked();
    await page.getByLabel("提示词优化模型").selectOption("browser-language");
    await page.getByLabel("提示词优化思考强度").selectOption("medium");
    await page.getByRole("button", { name: "开始优化", exact: true }).click();
    await expect(page.getByLabel("优化前提示词")).toHaveValue("一只红色纸鹤");
    await expect(page.getByLabel("优化后提示词")).toContainText("");
    await expect(
      page.getByRole("button", { name: "保留优化后", exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel("优化后提示词")).toHaveValue(/柔和的晨光/);
    await expect(page.locator(".text-node>p")).toHaveText("一只红色纸鹤");
    expect(calls.at(-1).messages[0].role).toBe("system");
    expect(calls.at(-1).messages[0].content).toContain("优化");
    expect(calls.at(-1).messages[1].content).toBe("一只红色纸鹤");
    expect(calls.at(-1).reasoning_effort).toBe("medium");
    await page.getByLabel("优化前提示词").fill("手动修改后的原始纸鹤提示词");
    await page.getByLabel("优化后提示词").fill("另一个优化版本");
    await page.screenshot({
      path: "test-results/prompt-comparison-desktop.png",
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "保留优化前", exact: true }).click();
    await expect(page.getByLabel("文本内容", { exact: true })).toHaveValue(
      "手动修改后的原始纸鹤提示词",
    );
    await page.getByRole("button", { name: "开始优化", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "保留优化后", exact: true }),
    ).toBeEnabled();
    await page.getByLabel("优化后提示词").fill("选择保留的最终优化提示词");
    await page.getByRole("button", { name: "保留优化后", exact: true }).click();
    await expect(page.getByLabel("文本内容", { exact: true })).toHaveValue(
      "选择保留的最终优化提示词",
    );
    await expect(page.locator(".canvas-header")).toContainText("已保存");
    await page.reload();
    await expect(page.locator(".text-node>p")).toHaveText(
      "选择保留的最终优化提示词",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/models");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /语言模型/ })
      .click();
    await page.getByRole("button", { name: /查看 1 个模型/ }).click();
    await expect(page.locator(".model-card")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/model-library-language-mobile.png",
      fullPage: true,
      animations: "disabled",
    });
    for (let index = 0; index < 12; index++) {
      const result = await page.request.post("/api/v1/admin/models", {
        headers: { Origin: "http://127.0.0.1:4022" },
        data: {
          model: `pagination-voice-${index}`,
          display_name: `分页语音 ${index}`,
          type: "speech",
          billing_unit: "request",
          input_price: 0,
          output_price: 0,
        },
      });
      expect(result.status()).toBe(201);
    }
    await page.goto("/models");
    await expect(page.locator(".model-card")).toHaveCount(12);
    await expect(
      page.getByRole("navigation", { name: "模型目录分页" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /下一页/ }).click();
    await expect(
      page.getByRole("navigation", { name: "模型目录分页" }),
    ).toContainText("2 / 2");
    await expect(page.locator(".model-card")).toHaveCount(8);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.locator(".model-card")).toHaveCount(12);
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
