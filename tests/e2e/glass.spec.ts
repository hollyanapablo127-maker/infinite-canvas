import { test, expect } from "@playwright/test";
import sharp from "sharp";

test("glass feedback paints, keeps controls in place and honors reduced motion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
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
  await page.getByRole("link", { name: "模型广场", exact: true }).click();
  const card = page.locator(".model-card").first();
  await page.getByRole("heading", { name: /^模型广场/ }).hover();
  const before = await card.screenshot({ animations: "disabled" });
  await card.hover();
  await expect(card).toHaveClass(/glass-lit/);
  const after = await card.screenshot({ animations: "disabled" });
  const first = await sharp(before).resize(128, 64).raw().toBuffer();
  const second = await sharp(after).resize(128, 64).raw().toBuffer();
  let changed = 0;
  for (let i = 0; i < first.length; i++)
    if (Math.abs(first[i] - second[i]) > 3) changed++;
  expect(changed).toBeGreaterThan(first.length * 0.02);
  await page.screenshot({
    path: "test-results/liquid-glass-desktop.png",
    animations: "disabled",
  });

  await page.getByRole("link", { name: "API 密钥", exact: true }).click();
  await page.getByRole("button", { name: "创建密钥", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const rect = (await dialog.boundingBox())!;
  await page.mouse.move(rect.x + 20, rect.y + 20);
  await expect(dialog).toHaveClass(/glass-lit/);
  expect(await dialog.boundingBox()).toEqual(rect);
  await page.mouse.down();
  await expect(page.locator(".liquid-ripple")).not.toHaveCount(0);
  await page.mouse.up();
  await page.screenshot({ path: "test-results/liquid-glass-key-dialog.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".glass-lit")).toHaveCount(0);
  await expect(page.locator(".liquid-ripple")).toHaveCount(0);
  await page.mouse.move(rect.x + 40, rect.y + 40);
  await expect(dialog).not.toHaveClass(/glass-lit/);
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 812 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const mobile = (await dialog.boundingBox())!;
    expect(mobile.x).toBeGreaterThanOrEqual(0);
    expect(mobile.x + mobile.width).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: "test-results/liquid-glass-reduced-mobile.png",
  });
  expect(errors).toEqual([]);
});
