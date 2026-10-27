import {
  randomBytes,
  createHash,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";
import type { Request, Response, NextFunction } from "express";
import { db, type Row } from "./db";

const scrypt = promisify(scryptCb);
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(":");
  const computed = (await scrypt(password, salt, 64)) as Buffer;
  const original = Buffer.from(digest, "hex");
  return (
    original.length === computed.length && timingSafeEqual(original, computed)
  );
}
const cipherKey = createHash("sha256").update(config.secret).digest();
export function encrypt(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}
export function decrypt(text: string) {
  const [iv, tag, data] = text.split(":");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    cipherKey,
    Buffer.from(iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export const sign = (text: string) =>
  createHmac("sha256", config.secret).update(text).digest("hex");
export function pagination(req: Request, maximum = 1000): [number, number] {
  const limit = Number(req.query.limit ?? maximum),
    offset = Number(req.query.offset ?? 0);
  ensure(
    Number.isSafeInteger(limit) &&
      limit > 0 &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset <= 1e9,
    "分页参数无效",
  );
  return [Math.min(limit, maximum), offset];
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_ERROR",
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export type AuthRequest = Request & {
  user: Row;
  apiKey?: Row;
  sessionId?: string;
};
export function asyncRoute(
  fn: (req: AuthRequest, res: Response) => Promise<any>,
) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req as AuthRequest, res)).catch(next);
}
export const safeUser = (u: Row) => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  email: u.email,
  email_verified: u.email_verified,
  role: u.role,
  disabled: u.disabled,
  created_at: u.created_at,
  preferences: u.preferences,
  discount_multiplier: Number(u.discount_multiplier ?? 1),
});
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const r = req as AuthRequest;
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      const [key] = await db.query(
        "SELECT * FROM api_keys WHERE key_hash=$1 AND NOT disabled AND NOT revoked AND (expires_at IS NULL OR expires_at>now())",
        [hash(bearer)],
      );
      ensure(key, "API Key 无效或已停用", 401);
      r.apiKey = key;
      const [user] = await db.query(
        "SELECT * FROM users WHERE id=$1 AND NOT disabled",
        [key.user_id],
      );
      ensure(user, "账号不可用", 401);
      r.user = user;
      await db.query("UPDATE api_keys SET last_used=now() WHERE id=$1", [
        key.id,
      ]);
    } else {
      const session = req.cookies?.canvas_session;
      ensure(session, "请先登录", 401);
      const [user] = await db.query(
        "SELECT u.*,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND NOT u.disabled",
        [hash(session)],
      );
      ensure(user, "登录已过期，请重新登录", 401);
      r.user = user;
      r.sessionId = user.session_id;
    }
    await db.query("UPDATE users SET last_active=now() WHERE id=$1", [
      r.user.id,
    ]);
    next();
  } catch (error) {
    next(error);
  }
}
export const adminOnly = (req: Request, _res: Response, next: NextFunction) => {
  const r = req as AuthRequest;
  if (r.user.role !== "admin" || r.apiKey)
    return next(new HttpError(403, "需要管理员登录权限"));
  next();
};
const buckets = new Map<string, { count: number; until: number }>();
export function rateLimit(name: string, max: number, seconds: number) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    if (buckets.size > 10000)
      for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
    const item = buckets.get(key);
    if (!item || item.until <= now)
      buckets.set(key, { count: 1, until: now + seconds * 1000 });
    else if (++item.count > max)
      return next(new HttpError(429, "操作过于频繁，请稍后再试"));
    next();
  };
}
export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (
    ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    req.headers.authorization?.startsWith("Bearer ")
  )
    return next();
  const origin = req.headers.origin;
  const allowed = new Set([
    config.origin,
    config.publicBase,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`,
  ]);
  if (!config.production) {
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:5173");
    allowed.add("http://localhost:5174");
    allowed.add("http://127.0.0.1:5174");
  }
  if (!origin || !allowed.has(origin))
    return next(new HttpError(403, "请求来源校验失败"));
  next();
}

export function apiKeyAllowsModel(key: Row | undefined, model: string) {
  return (
    !key ||
    (Array.isArray(key.models) &&
      (key.models.includes("*") || key.models.includes(model)))
  );
}
