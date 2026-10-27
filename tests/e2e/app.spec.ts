import { test, expect } from "@playwright/test";
import path from "node:path";

test("administrator, personal workflows, canvas persistence and mobile", async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "创建管理员账号" }),
  ).toBeVisible();
  await page.getByLabel("账号", { exact: true }).fill("browseradmin");
  await page
    .getByLabel("密码（至少 8 位）", { exact: true })
    .fill("browser-test-123");
  await page.getByLabel("显示名称", { exact: true }).fill("浏览器管理员");
  await page.getByRole("button", { name: "初始化并进入" }).click();
  await expect(
    page.getByRole("heading", { name: "我的画布", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".nav-label", { hasText: "管理员" })).toBeVisible();
  await expect(
    page.locator(".nav-label", { hasText: "个人账号" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "模型广场", exact: true }).click();
  await expect(page.locator(".model-card")).toHaveCount(7);
  await expect(page.locator(".price-table")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/models-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "查看 gpt-image-2.5-flare 价格详情" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("1K · 输出图");
  await page.getByRole("button", { name: "在画布中使用" }).click();
  await expect(page.locator(".image-generation-node")).toHaveCount(1);
  await page.getByRole("link", { name: "模型广场", exact: true }).click();
  await page.getByRole("link", { name: "用户管理", exact: true }).click();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await page.getByLabel("账号（3-40 位字母、数字或 _. -）").fill("browseruser");
  await page.getByLabel("显示名称").fill("普通测试用户");
  await page.getByLabel("初始密码").fill("browser-user-123");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "browseruser", exact: true }),
  ).toBeVisible();
  const adminRow = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "browseradmin", exact: true }),
  });
  await adminRow.getByRole("button", { name: "余额", exact: true }).click();
  await page.getByLabel("金额（元）").fill("100");
  await page.getByLabel("操作原因").fill("隔离浏览器测试充值");
  await page.getByRole("button", { name: "确认入账" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await adminRow.getByRole("button", { name: "流水", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("隔离浏览器测试充值");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const ordinaryRow = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "browseruser", exact: true }),
  });
  await ordinaryRow
    .getByRole("button", { name: "专属倍率", exact: true })
    .click();
  await page.getByLabel("专属倍率", { exact: true }).fill("0.8");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(ordinaryRow).toContainText("0.8×");
  await page.getByRole("link", { name: "模型定价", exact: true }).click();
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  let modelDialog = page.getByRole("dialog");
  await modelDialog
    .getByRole("button", { name: "图片模型", exact: true })
    .click();
  await modelDialog
    .getByLabel("模型 ID", { exact: true })
    .fill("browser-custom-image");
  await modelDialog.getByLabel("模型显示名称").fill("浏览器自定义图片模型");
  await modelDialog.getByLabel("兼容接入协议").selectOption("openai-image");
  await modelDialog.getByRole("button", { name: "添加并发布模型" }).click();
  const customModelRow = page
    .getByRole("row")
    .filter({ has: page.getByText("浏览器自定义图片模型", { exact: true }) });
  await expect(customModelRow).toHaveCount(1);
  await customModelRow
    .getByRole("button", { name: "编辑模型", exact: true })
    .click();
  await page
    .getByLabel("模型说明")
    .fill("通过管理员界面手动新增并编辑的图片模型");
  await page.getByRole("button", { name: "保存模型", exact: true }).click();
  await customModelRow
    .getByRole("button", { name: "管理价格", exact: true })
    .click();
  const image2kPrice = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "2K", exact: true }) });
  page.once("dialog", (dialog) => dialog.accept());
  await image2kPrice.getByRole("button", { name: "删除", exact: true }).click();
  await expect(image2kPrice).toHaveCount(0);
  await page.getByRole("button", { name: "添加价格档位", exact: true }).click();
  await expect(page.getByLabel("未配置模型档位").locator("option")).toHaveCount(
    1,
  );
  await expect(page.getByLabel("未配置模型档位")).toHaveValue("2K");
  await page.getByLabel("输入原价（元 / 张）").fill("0");
  await page.getByLabel("输入售价（元 / 张）").fill("0");
  await page.getByLabel("输出原价（元 / 张）").fill("0.14");
  await page.getByLabel("输出售价（元 / 张）").fill("0.12");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(image2kPrice).toHaveCount(1);
  await expect(image2kPrice).toContainText("¥0.12");
  await page.screenshot({
    path: "test-results/admin-pricing-images-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("link", { name: "模型广场", exact: true }).click();
  await expect(page.locator(".model-card")).toHaveCount(8);
  await page
    .getByLabel("搜索模型", { exact: true })
    .fill("browser-custom-image");
  await expect(page.locator(".model-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "查看 浏览器自定义图片模型 价格详情" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("¥0.12");
  await page.getByRole("button", { name: "在画布中使用", exact: true }).click();
  await expect(page.locator(".image-generation-node")).toHaveCount(1);
  const historicalImageUrl = page.url();
  await page.getByRole("link", { name: "模型定价", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("row")
    .filter({ has: page.getByText("浏览器自定义图片模型", { exact: true }) })
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(customModelRow).toHaveCount(0);
  await page.goto(historicalImageUrl);
  await page.locator(".image-generation-node .node-head").click();
  await expect(page.getByLabel("输出尺寸")).toBeVisible();
  await page.reload();
  await page.locator(".image-generation-node .node-head").click();
  await expect(page.getByLabel("输出尺寸")).toBeVisible();
  await page.getByRole("link", { name: "渠道管理", exact: true }).click();
  await page.getByRole("button", { name: "添加渠道" }).click();
  let channelDialog = page.getByRole("dialog");
  await channelDialog.getByRole("button", { name: /百炼 API/ }).click();
  await channelDialog.getByLabel("渠道名称").fill("测试百炼渠道");
  await channelDialog.getByLabel("Workspace ID").fill("browser-workspace");
  await channelDialog
    .getByLabel("百炼 API Key")
    .fill("sk-browser-test-not-real-key");
  await channelDialog
    .getByRole("button", { name: "添加渠道", exact: true })
    .click();
  await expect(page.getByText("测试百炼渠道", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "添加渠道" }).click();
  channelDialog = page.getByRole("dialog");
  await channelDialog.getByRole("button", { name: /^OpenAI/ }).click();
  await channelDialog.getByLabel("渠道名称").fill("测试 OpenAI 渠道");
  await channelDialog
    .getByLabel("API Base URL")
    .fill("https://images.example/v1");
  await channelDialog.getByLabel("API Key").fill("sk-openai-browser-test-key");
  await channelDialog
    .getByRole("button", { name: "添加渠道", exact: true })
    .click();
  await expect(
    page.getByText("测试 OpenAI 渠道", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".table-wrap")).not.toContainText(
    "sk-openai-browser-test-key",
  );
  await page.screenshot({
    path: "test-results/admin-channels-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "导航菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByLabel("邮箱或账号", { exact: true }).fill("browseruser");
  await page.getByLabel("密码", { exact: true }).fill("browser-user-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "导航菜单" }).click();
  await expect(page.locator(".nav-label", { hasText: "管理员" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "我的画布", exact: true }).click();
  await expect(page.getByText("还没有画布", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导航菜单" }).click();
  await page.getByRole("link", { name: "API 密钥", exact: true }).click();
  await page.getByRole("button", { name: "创建密钥", exact: true }).click();
  const keyDialog = page.getByRole("dialog");
  await expect(keyDialog.getByLabel("不限模型")).toBeChecked();
  await expect(
    keyDialog.getByRole("checkbox", {
      name: "API 模型 wan3.0-video",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    keyDialog.getByRole("checkbox", {
      name: "API 模型 gpt-image-2",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/api-key-default-mobile.png",
    animations: "disabled",
  });
  await keyDialog.getByLabel("密钥名称").fill("不限模型默认密钥");
  await keyDialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".secret")).toContainText("ic_");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const unlimitedKeyRow = page.getByRole("row").filter({
    hasText: "不限模型默认密钥",
  });
  await expect(unlimitedKeyRow).toBeVisible();

  await page.getByRole("button", { name: "创建密钥", exact: true }).click();
  const scopedKeyDialog = page.getByRole("dialog");
  await scopedKeyDialog.getByLabel("密钥名称").fill("未来模型");
  await scopedKeyDialog.getByLabel("不限模型").uncheck();
  await scopedKeyDialog
    .getByLabel("自定义 API 模型")
    .fill("future-model:alpha");
  await scopedKeyDialog
    .getByRole("button", { name: "添加", exact: true })
    .click();
  await expect(
    scopedKeyDialog.getByRole("list", { name: "已选自定义模型" }),
  ).toContainText("future-model:alpha");
  await scopedKeyDialog.getByLabel("自定义 API 模型").fill("remove-this-model");
  await scopedKeyDialog
    .getByRole("button", { name: "添加", exact: true })
    .click();
  await scopedKeyDialog
    .getByRole("button", { name: "移除模型 remove-this-model", exact: true })
    .click();
  await expect(scopedKeyDialog.getByRole("list")).not.toContainText(
    "remove-this-model",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/api-key-custom-mobile.png",
    animations: "disabled",
  });
  await scopedKeyDialog
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const scopedKeyRow = page.getByRole("row").filter({ hasText: "未来模型" });
  await expect(scopedKeyRow).toBeVisible();
  await scopedKeyRow.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("list")).toContainText(
    "future-model:alpha",
  );
  await page
    .getByRole("button", { name: "移除模型 future-model:alpha", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByText("wan3.0-video · 视频", { exact: true })
    .click();
  await expect(page.getByLabel("不限模型")).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "API 模型 wan3.0-video", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(scopedKeyRow).toContainText("wan3.0-video");
  await expect(scopedKeyRow).not.toContainText("future-model:alpha");
  await scopedKeyRow.getByRole("button", { name: "撤销密钥" }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(scopedKeyRow).toHaveCount(0);
  await page.getByRole("button", { name: "导航菜单" }).click();
  await page.getByRole("link", { name: "模型广场", exact: true }).click();
  await page
    .getByRole("button", { name: "查看 wan3.0-video 价格详情" })
    .click();
  await expect(page.locator(".personal-price-banner")).toContainText(
    "8.0 折优惠",
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "480P", exact: true }) }),
  ).toContainText("¥0.24");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  expect(errors).toEqual([]);
});
