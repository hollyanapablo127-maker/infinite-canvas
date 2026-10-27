import { test, expect } from "@playwright/test";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("video asset detail can extract first and last frames into the library", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/");
  const config = await (await page.request.get("/api/v1/auth/config")).json();
  if (config.setupRequired) {
    await page.getByLabel("账号", { exact: true }).fill("framebrowseradmin");
    await page
      .getByLabel("密码（至少 8 位）", { exact: true })
      .fill("frame-browser-123");
    await page.getByLabel("显示名称").fill("帧测试管理员");
    await page.getByRole("button", { name: "初始化并进入" }).click();
  } else {
    await page.getByLabel("邮箱或账号", { exact: true }).fill("browseradmin");
    await page.getByLabel("密码", { exact: true }).fill("browser-test-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  await page.getByRole("link", { name: "资产库", exact: true }).click();
  const dialogAsset = page.getByRole("button", { name: "导入链接" });
  await expect(dialogAsset).toBeVisible();
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  if (spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status !== 0)
    test.skip(true, "ffmpeg is not available");
  const videoPath = path.resolve(".test-data", "browser-two-color.mp4");
  spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=96x64:r=10:d=1",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=96x64:r=10:d=1",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]",
      "-map",
      "[v]",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-t",
      "2",
      videoPath,
    ],
    { stdio: "ignore" },
  );
  await page.locator("input[type=file]").setInputFiles(videoPath);
  await expect(page.locator(".asset-card")).toHaveCount(1);
  await page.locator(".asset-card").click();
  await expect(page.getByRole("dialog")).toContainText("two-color.mp4");
  await page.getByRole("button", { name: "提取首帧", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(2);
  await page.getByRole("button", { name: "提取尾帧", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(3);
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "尾帧.jpg",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: "test-results/video-frame-detail-mobile.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(3);
  await expect(
    page.locator(".asset-card").filter({ hasText: "首帧" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".asset-card").filter({ hasText: "尾帧" }),
  ).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/video-first-last-assets.png",
    fullPage: true,
    animations: "disabled",
  });
});
