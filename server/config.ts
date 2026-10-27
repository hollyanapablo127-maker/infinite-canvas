import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const dataDir = path.resolve(process.env.DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true });
const production = process.env.NODE_ENV === "production";
if (
  production &&
  (!process.env.DATABASE_URL ||
    !process.env.APP_SECRET ||
    process.env.APP_SECRET.length < 32)
) {
  throw new Error(
    "Production requires DATABASE_URL and APP_SECRET (32+ characters)",
  );
}
const secretPath = path.join(dataDir, ".secret");
if (!process.env.APP_SECRET && !existsSync(secretPath))
  writeFileSync(secretPath, randomBytes(48).toString("hex"), { mode: 0o600 });
export const config = {
  production,
  dataDir,
  port: Number(process.env.PORT || 4010),
  host: process.env.HOST || "127.0.0.1",
  secret: process.env.APP_SECRET || readFileSync(secretPath, "utf8").trim(),
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  publicBase: process.env.PUBLIC_BASE_URL || "",
  databaseUrl: process.env.DATABASE_URL,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  },
};
export const defaults = {
  siteName: "无限画布",
  registrationOpen: false,
  terms: "",
  supportEmail: "",
  emailVerification: false,
  maintenance: false,
  concurrentPerUser: 2,
  storageLimitGB: 5,
  retentionDays: 30,
  defaultApiDailyLimit: 500,
  defaultApiMonthlyLimit: 5000,
  unknownAlertHours: 1,
  payment: {
    enabled: false,
    gatewayUrl: "",
    pid: "",
    key: "",
    paymentType: "alipay",
    notifyUrl: "",
    returnUrl: "",
    minRecharge: 1,
    maxRecharge: 100000,
    dailyLimit: 0,
    balanceRate: 1,
    subscriptionRate: 1,
    renewalFeeRate: 1,
    orderTimeoutMinutes: 30,
    maxPendingOrders: 5,
    qrEnabled: true,
    productPrefix: "IC",
    productSuffix: "",
    provider: "epay",
    alipayAppId: "",
    alipayPrivateKey: "",
    alipayPublicKey: "",
    planName: "万相月订阅",
    planPrice: 39,
    planDays: 30,
  },
};
