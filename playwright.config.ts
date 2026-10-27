import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4022",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
  webServer: {
    command: "node --import tsx server/main.ts",
    url: "http://127.0.0.1:4022/api/health",
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: "4022",
      HOST: "127.0.0.1",
      APP_ORIGIN: "http://127.0.0.1:4022",
      DATA_DIR: `./.test-data/e2e-${Date.now()}`,
      DISABLE_WORKER: "1",
      NODE_ENV: "development",
    },
  },
});
