import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { config } from "./config";
import { migrate, db } from "./db";
import {
  authenticate,
  adminOnly,
  originGuard,
  HttpError,
  rateLimit,
} from "./security";
import { authRouter } from "./auth";
import { adminRouter } from "./admin";
import { personalRouter, projectRouter } from "./personal";
import { generationRouter, quoteRouter } from "./generations";
import { imageGenerationRouter, imageQuoteRouter } from "./images";
import { assetRouter, mediaRouter } from "./assets";
import { workflowRouter } from "./workflows";
import { paymentRouter, paymentNotifyRouter } from "./payments";
import { capabilityRouter } from "./capabilities";
import { setupRealtimeProxy } from "./live-capabilities";
import { migrateProviderChannels, repairProviderMembers } from "./channels";
import { startWorker } from "./worker";
import { languageRouter, recoverLanguageRuns } from "./language";

class AppModule {}
Module({})(AppModule);
await migrate();
await migrateProviderChannels();
await repairProviderMembers();
export const app = await NestFactory.create(AppModule, {
  bodyParser: false,
  logger: ["error", "warn"],
});
const server = app.getHttpAdapter().getInstance() as express.Express;
server.disable("x-powered-by");
server.set("trust proxy", config.production ? 1 : false);
server.use((req, res, next) => {
  res.setHeader("X-Request-Id", randomUUID());
  next();
});
server.use(
  helmet({
    contentSecurityPolicy: config.production
      ? {
          directives: {
            defaultSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
            connectSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        }
      : false,
  }),
);
server.use(
  cookieParser(),
  express.json({ limit: "32mb" }),
  express.urlencoded({ extended: false, limit: "1mb" }),
);
server.use("/api/v1/payments/notify", paymentNotifyRouter);
server.use(originGuard);
server.get("/api/health", async (_req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ ok: true, region: "cn-beijing" });
  } catch {
    res.status(503).json({ ok: false });
  }
});
server.use("/api/v1/auth", authRouter);
server.use("/media", mediaRouter);
server.use("/api/v1/media", mediaRouter);
server.use("/api/v1", rateLimit("api", 600, 60), authenticate);
server.use("/api/v1/admin", adminOnly, adminRouter);
server.use("/api/v1/projects", projectRouter);
server.use("/api/v1/assets", assetRouter);
server.use("/api/v1/quotes", quoteRouter);
server.use("/api/v1/image-quotes", imageQuoteRouter);
server.use("/api/v1/generations", generationRouter);
server.use("/api/v1/image-generations", imageGenerationRouter);
server.use("/api/v1/workflows", workflowRouter);
server.use("/api/v1/payments", paymentRouter);
server.use("/api/v1/capabilities", capabilityRouter);
server.use("/api/v1/language", languageRouter);
server.use("/api/v1", personalRouter);
server.use("/api", (_req, res) =>
  res.status(404).json({ message: "接口不存在" }),
);
const dist = path.resolve("dist");
if (existsSync(dist)) {
  server.use(express.static(dist));
  server.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}
server.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error.code === "23505"
            ? 409
            : error.code === "LIMIT_FILE_SIZE"
              ? 413
              : 400;
    const message =
      error instanceof ZodError
        ? error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；")
        : error.code === "23505"
          ? "账号或记录已存在"
          : error.code === "LIMIT_FILE_SIZE"
            ? "文件超过 100MB"
            : error instanceof HttpError
              ? error.message
              : error instanceof Error && !("code" in error)
                ? error.message
                : "请求未完成，请稍后重试";
    if (error.code && status !== 409) console.error("Request:", error.code);
    if (res.headersSent) {
      if (!res.writableEnded && !res.destroyed) {
        if (String(res.getHeader("Content-Type")).includes("text/event-stream"))
          res.write(
            `event: error\ndata: ${JSON.stringify({ message: "结算暂未完成，请稍后查看余额与流水" })}\n\n`,
          );
        res.end();
      }
      return;
    }
    res.status(status).json({
      message,
      code: error.code || "REQUEST_ERROR",
      requestId: res.getHeader("X-Request-Id"),
    });
  },
);
await recoverLanguageRuns();
setupRealtimeProxy(app.getHttpServer());
await app.listen(config.port, config.host);
const languageRecoveryTimer = setInterval(() => {
  void recoverLanguageRuns().catch(() =>
    console.error("Language recovery failed; retrying next minute"),
  );
}, 60_000);
languageRecoveryTimer.unref();
app.getHttpServer().once("close", () => clearInterval(languageRecoveryTimer));
const stopWorker =
  process.env.DISABLE_WORKER === "1" ? async () => {} : startWorker();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await stopWorker();
    await app.close();
    process.exit(0);
  });
console.log(`Infinite Canvas API: http://${config.host}:${config.port}`);
