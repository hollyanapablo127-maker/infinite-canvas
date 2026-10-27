import { Router } from "express";
import { z } from "zod";
import { randomUUID, randomInt } from "node:crypto";
import nodemailer from "nodemailer";
import { db, settings, transaction, type Queryable } from "./db";
import { config } from "./config";
import {
  asyncRoute,
  ensure,
  hash,
  token,
  passwordHash,
  verifyPassword,
  safeUser,
  rateLimit,
  authenticate,
} from "./security";
import { audit } from "./finance";

const setupIdentity = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9_.-]+$/, "账号可使用字母、数字、下划线"),
  password: z.string().min(8, "密码至少 8 位").max(128),
  display_name: z.string().trim().min(1).max(40),
  email: z.string().email().optional().or(z.literal("")),
  code: z.string().optional(),
});
const registrationIdentity = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "密码至少 8 位").max(128),
  code: z.string().optional(),
});
export const authRouter = Router();
authRouter.get(
  "/config",
  asyncRoute(async (_req, res) => {
    const s = await settings();
    const [{ count }] = await db.query(
      "SELECT count(*)::int AS count FROM users",
    );
    res.json({
      siteName: s.siteName,
      terms: s.terms,
      supportEmail: s.supportEmail,
      registrationOpen: s.registrationOpen,
      emailVerification: s.emailVerification,
      setupRequired: count === 0,
      setupTokenRequired: config.production,
      mailReady: !!config.smtp.host,
      maintenance: s.maintenance,
      apiDailyLimit: s.defaultApiDailyLimit,
      apiMonthlyLimit: s.defaultApiMonthlyLimit,
    });
  }),
);
async function createUser(body: z.infer<typeof setupIdentity>, role: string) {
  const id = randomUUID();
  const password = await passwordHash(body.password);
  const user = await transaction(async (tx) => {
    // The settings row serializes first-admin creation and registration policy changes.
    await tx.query("SELECT id FROM settings WHERE id=1 FOR UPDATE");
    const s = (await tx.query("SELECT value FROM settings WHERE id=1"))[0]
      .value;
    if (role === "admin")
      ensure(
        (await tx.query("SELECT id FROM users LIMIT 1")).length === 0,
        "初始化已完成",
        409,
      );
    else {
      ensure(s.registrationOpen, "当前未开放注册", 403);
      if (s.emailVerification) {
        ensure(body.email, "请填写邮箱");
        if (
          !(await checkCodeInTransaction(
            tx,
            body.email,
            "register",
            body.code || "",
          ))
        )
          return null;
      }
    }
    await tx.query(
      "INSERT INTO users(id,username,display_name,email,password_hash,role,email_verified) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        body.username.toLowerCase(),
        body.display_name,
        body.email?.toLowerCase() || null,
        password,
        role,
        role === "user" && !!s.emailVerification,
      ],
    );
    await tx.query("INSERT INTO wallets(user_id) VALUES($1)", [id]);
    await audit(
      id,
      role === "admin" ? "initialize_admin" : "register",
      id,
      {},
      tx,
    );
    return (await tx.query("SELECT * FROM users WHERE id=$1", [id]))[0];
  });
  ensure(user, "验证码错误或已过期");
  return user;
}
async function startSession(user: any, req: any, res: any) {
  const key = token();
  await db.query(
    "INSERT INTO sessions(id,user_id,expires_at,user_agent) VALUES($1,$2,now()+interval '7 days',$3)",
    [hash(key), user.id, String(req.headers["user-agent"] || "").slice(0, 300)],
  );
  res.cookie("canvas_session", key, {
    httpOnly: true,
    secure: config.production,
    sameSite: "lax",
    maxAge: 7 * 86400000,
    path: "/",
  });
  res.json({ user: safeUser(user) });
}
authRouter.post(
  "/setup",
  rateLimit("setup", 5, 60),
  asyncRoute(async (req, res) => {
    if (config.production)
      ensure(
        process.env.SETUP_TOKEN &&
          req.body.setupToken === process.env.SETUP_TOKEN,
        "初始化令牌无效",
        403,
      );
    const body = setupIdentity.parse(req.body);
    const user = await createUser(body, "admin");
    await startSession(user, req, res);
  }),
);
authRouter.post(
  "/register",
  rateLimit("register", 6, 300),
  asyncRoute(async (req, res) => {
    ensure((await settings()).registrationOpen, "当前未开放注册", 403);
    const body = registrationIdentity.parse(req.body);
    const user = await createUser(
      {
        username: body.email,
        display_name: body.email.split("@")[0].slice(0, 40),
        email: body.email,
        password: body.password,
        code: body.code,
      },
      "user",
    );
    await startSession(user, req, res);
  }),
);
authRouter.post(
  "/login",
  rateLimit("login", 15, 300),
  asyncRoute(async (req, res) => {
    const body = z
      .object({
        username: z.string().trim().min(1).max(254),
        password: z.string().min(1).max(128),
      })
      .parse(req.body);
    const [user] = await db.query(
      "SELECT * FROM users WHERE username=$1 OR email=$1",
      [body.username.toLowerCase()],
    );
    ensure(
      user &&
        !user.disabled &&
        (await verifyPassword(body.password, user.password_hash)),
      "账号或密码错误",
      401,
    );
    await startSession(user, req, res);
  }),
);
async function checkCodeInTransaction(
  tx: Queryable,
  email: string,
  purpose: string,
  code: string,
) {
  const [item] = await tx.query(
    "SELECT * FROM email_codes WHERE email=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    [email.toLowerCase(), purpose],
  );
  if (
    !item ||
    item.consumed ||
    new Date(item.expires_at).getTime() <= Date.now() ||
    item.attempts >= 5
  )
    return false;
  const accepted = hash(code) === item.code_hash;
  await tx.query(
    "UPDATE email_codes SET attempts=attempts+1,consumed=$2 WHERE id=$1",
    [item.id, accepted],
  );
  return accepted;
}
export async function consumeCode(
  email: string,
  purpose: string,
  code: string,
) {
  const accepted = await transaction((tx) =>
    checkCodeInTransaction(tx, email, purpose, code),
  );
  ensure(accepted, "验证码错误或已过期");
}
authRouter.post(
  "/email-code",
  rateLimit("email-code", 10, 3600),
  asyncRoute(async (req, res) => {
    const { email, purpose } = z
      .object({
        email: z.string().email(),
        purpose: z.enum(["register", "reset"]),
      })
      .parse(req.body);
    ensure(config.smtp.host, "邮件服务尚未配置，请联系管理员", 503);
    if (purpose === "register")
      ensure((await settings()).registrationOpen, "当前未开放注册", 403);
    const [recent] = await db.query(
      "SELECT id FROM email_codes WHERE email=$1 AND created_at>now()-interval '60 seconds'",
      [email.toLowerCase()],
    );
    ensure(!recent, "请等待 60 秒后再发送");
    if (
      purpose === "reset" &&
      !(
        await db.query("SELECT id FROM users WHERE email=$1 AND NOT disabled", [
          email.toLowerCase(),
        ])
      ).length
    )
      return res.json({ message: "如邮箱可用，将收到重置验证码" });
    const code = String(randomInt(100000, 1000000));
    const id = randomUUID();
    await db.query(
      "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [id, email.toLowerCase(), purpose, hash(code)],
    );
    try {
      await nodemailer.createTransport(config.smtp).sendMail({
        from: process.env.SMTP_FROM || config.smtp.auth.user,
        to: email,
        subject: "无限画布 · 邮箱验证码",
        text: `您的验证码是 ${code}，10 分钟内有效。请勿将验证码告知他人。`,
      });
    } catch {
      await db.query("DELETE FROM email_codes WHERE id=$1", [id]);
      throw new Error("验证码发送失败，请稍后重试");
    }
    res.json({ message: "如邮箱可用，将收到验证码" });
  }),
);
authRouter.post(
  "/reset-password",
  rateLimit("reset", 5, 600),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        email: z.string().email(),
        code: z.string().length(6),
        password: z.string().min(8).max(128),
      })
      .parse(req.body);
    const pwd = await passwordHash(b.password);
    await consumeCode(b.email, "reset", b.code);
    await transaction(async (tx) => {
      const [u] = await tx.query(
        "UPDATE users SET password_hash=$2,email_verified=true WHERE email=$1 AND NOT disabled RETURNING id",
        [b.email.toLowerCase(), pwd],
      );
      ensure(u, "无法重置该账号");
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
    });
    res.json({ ok: true });
  }),
);
authRouter.use(authenticate);
authRouter.use((req, _res, next) => {
  if ((req as any).apiKey && req.path !== "/me")
    return next(new Error("此操作需网页登录"));
  next();
});
authRouter.post(
  "/reauth",
  rateLimit("reauth", 5, 300),
  asyncRoute(async (req, res) => {
    ensure(
      await verifyPassword(
        z.string().max(128).parse(req.body.password),
        req.user.password_hash,
      ),
      "密码错误",
      401,
    );
    await db.query("UPDATE sessions SET verified_at=now() WHERE id=$1", [
      req.sessionId,
    ]);
    res.json({ ok: true });
  }),
);
authRouter.get(
  "/me",
  asyncRoute(async (req, res) => {
    res.json({
      user: safeUser(req.user),
      wallet: (
        await db.query("SELECT * FROM wallets WHERE user_id=$1", [req.user.id])
      )[0],
    });
  }),
);
authRouter.post(
  "/logout",
  asyncRoute(async (req, res) => {
    if (req.sessionId)
      await db.query("DELETE FROM sessions WHERE id=$1", [req.sessionId]);
    res.clearCookie("canvas_session", { path: "/" });
    res.json({ ok: true });
  }),
);
authRouter.patch(
  "/profile",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "请使用网页登录", 403);
    const b = z
      .object({
        display_name: z.string().trim().min(1).max(40),
        preferences: z
          .object({
            theme: z.enum(["light", "dark", "system"]).optional(),
            emailNotifications: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    await db.query(
      "UPDATE users SET display_name=$2,preferences=preferences || $3::jsonb WHERE id=$1",
      [req.user.id, b.display_name, JSON.stringify(b.preferences || {})],
    );
    res.json({ ok: true });
  }),
);
authRouter.post(
  "/password",
  asyncRoute(async (req, res) => {
    ensure(!req.apiKey, "请使用网页登录", 403);
    const b = z
      .object({
        current: z.string().max(128),
        password: z.string().min(8).max(128),
      })
      .parse(req.body);
    ensure(
      await verifyPassword(b.current, req.user.password_hash),
      "当前密码错误",
    );
    await transaction(async (tx) => {
      await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
        req.user.id,
        await passwordHash(b.password),
      ]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [req.user.id]);
    });
    res.clearCookie("canvas_session", { path: "/" });
    res.json({ ok: true });
  }),
);
authRouter.get(
  "/sessions",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT id,created_at,expires_at,user_agent FROM sessions WHERE user_id=$1 ORDER BY created_at DESC",
        [req.user.id],
      ),
    );
  }),
);
authRouter.delete(
  "/sessions/:id",
  asyncRoute(async (req, res) => {
    await db.query("DELETE FROM sessions WHERE id=$1 AND user_id=$2", [
      req.params.id,
      req.user.id,
    ]);
    res.json({ ok: true });
  }),
);
