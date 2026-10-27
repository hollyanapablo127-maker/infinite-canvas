import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e-live",
  timeout: 90000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4062",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx server/main.ts",
    url: "http://127.0.0.1:4062/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "4062",
      HOST: "127.0.0.1",
      APP_ORIGIN: "http://127.0.0.1:4062",
      DATA_DIR: `./.test-data/multimodal-e2e-${Date.now()}`,
      DISABLE_WORKER: "0",
      NODE_ENV: "development",
    },
  },
});
