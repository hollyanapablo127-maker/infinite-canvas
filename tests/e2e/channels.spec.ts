import { test, expect } from "@playwright/test";

test("sidebar hit boxes stay stable, one Bailian channel can be edited and deleted, family protocols are shared", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
  const menu = page.getByRole("link", { name: "模型广场", exact: true });
  const before = await menu.boundingBox();
  expect(before).toBeTruthy();
  await page.mouse.move(before!.x + 1, before!.y + before!.height / 2);
  for (let i = 0; i < 15; i++)
    await page.mouse.move(
      before!.x + 1 + (i % 2) * 0.05,
      before!.y + before!.height / 2,
    );
  const after = await menu.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 2);
  expect(after!.y).toBeCloseTo(before!.y, 2);
  await expect(page.locator(".sidebar")).toHaveCSS("position", "sticky");
  await expect(menu).toHaveCSS("transform", "none");
  expect(
    await page
      .locator(".sidebar nav")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.getByRole("link", { name: "渠道管理", exact: true }).click();
  await page.getByRole("button", { name: "添加渠道", exact: true }).click();
  await page.getByRole("dialog").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const modalBefore = await page.getByRole("dialog").boundingBox();
  await page.getByRole("dialog").hover();
  const modalAfter = await page.getByRole("dialog").boundingBox();
  expect(modalAfter!.x).toBeCloseTo(modalBefore!.x, 0);
  expect(modalAfter!.y).toBeCloseTo(modalBefore!.y, 0);
  await expect(page.getByRole("dialog")).toHaveCSS("position", "fixed");
  await page.getByRole("button", { name: /^百炼 API/ }).click();
  await page.getByLabel("渠道名称", { exact: true }).fill("统一百炼浏览器渠道");
  await page
    .getByLabel("Workspace ID", { exact: true })
    .fill("test-browser-workspace");
  await page.getByLabel("百炼地域").selectOption("ap-southeast-1");
  await page
    .getByLabel("百炼 API Key", { exact: true })
    .fill("isolated-browser-key");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加渠道", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("统一百炼浏览器渠道", { exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("ap-southeast-1");
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByLabel("渠道名称", { exact: true })
    .fill("统一百炼浏览器渠道·改");
  await page.getByRole("button", { name: "保存渠道", exact: true }).click();
  const edited = page
    .getByRole("row")
    .filter({ has: page.getByText("统一百炼浏览器渠道·改", { exact: true }) });
  await expect(edited).toHaveCount(1);
  await page.getByRole("link", { name: "模型定价", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "图片模型", exact: true })
    .click();
  const protocols = page.getByLabel("兼容接入协议");
  await protocols.selectOption("openai-image");
  await expect(protocols.locator("option")).toHaveCount(2);
  await expect(protocols).toContainText("GPT Image 系列");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByLabel("百炼模型预设").selectOption("Tripo/Tripo-H3.1");
  await expect(page.getByLabel("模型 ID", { exact: true })).toHaveValue(
    "Tripo/Tripo-H3.1",
  );
  await expect(page.getByLabel("兼容接入协议")).toHaveValue("bailian-3d");
  await expect(
    page
      .getByRole("dialog")
      .getByText("统一百炼浏览器渠道·改", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/bailian-3d-model-preset.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "多模态工作台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "多模态工作台", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/multimodal-workbench.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("link", { name: "渠道管理", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await edited.getByRole("button", { name: "删除", exact: true }).click();
  await expect(edited).toHaveCount(0);
  expect(errors).toEqual([]);
});
