import { test, expect } from "@playwright/test";

test("image node exposes model-specific controls on desktop and mobile", async ({ page }) => {
  await page.goto("/");
  const authConfig = await page.request.get("/api/v1/auth/config");
  const setupRequired = (await authConfig.json()).setupRequired;
  if (setupRequired) {
    await page.getByLabel("账号", { exact: true }).fill("imagebrowseradmin");
    await page.getByLabel("密码（至少 8 位）", { exact: true }).fill("image-browser-123");
    await page.getByLabel("显示名称", { exact: true }).fill("图片测试管理员");
    await page.getByRole("button", { name: "初始化并进入" }).click();
  } else {
    await page.getByLabel("邮箱或账号", { exact: true }).fill("browseradmin");
    await page.getByLabel("密码", { exact: true }).fill("browser-test-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }

  await expect(page.getByRole("heading", { name: "我的画布", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新建画布" }).click();
  await page.getByLabel("画布名称").fill("图片节点浏览器测试");
  await page.getByLabel("起始模板").selectOption("blank");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator(".canvas-title")).toHaveValue("图片节点浏览器测试");
  await page.getByTitle("添加图片节点").click();
  await expect(page.locator(".image-generation-node")).toHaveCount(1);

  const model = page.locator(".inspector-content select").nth(1);
  await expect(model.locator("option")).toHaveCount(5);
  await expect(page.getByLabel("负面提示词")).toBeVisible();
  await expect(page.getByLabel("随机种子")).toBeVisible();
  await expect(page.getByLabel("智能改写")).toBeVisible();

  await model.selectOption("gpt-image-2.5-flare");
  await expect(page.getByLabel("输出格式")).toBeVisible();
  await expect(page.getByLabel("背景")).toBeVisible();
  await expect(page.locator(".inspector-content select").nth(3)).toBeVisible();
  await expect(page.getByLabel("负面提示词")).toHaveCount(0);
  await page.getByLabel("输出尺寸").selectOption("4096x2160");
  await page.getByLabel("生成模式").selectOption("image");
  await expect(page.getByText("0 / 16", { exact: true })).toBeVisible();
  await expect(page.locator(".image-node-ports .node-port")).toHaveCount(2);
  await page.screenshot({ path: "test-results/image-node-desktop.png", fullPage: true });

  await model.selectOption("qwen-image-3.0-pro");
  await expect(page.getByLabel("负面提示词")).toBeVisible();
  await expect(page.getByLabel("输出格式")).toHaveCount(0);
  await expect(page.getByText("0 / 3", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("生成模式")).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCSS("transform", "matrix(1, 0, 0, 1, -222, 0)");
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: "test-results/image-node-mobile.png", fullPage: true });
});
