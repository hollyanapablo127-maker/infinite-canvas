import { Router } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { db, settings, transaction, type Row } from "./db";
import { asyncRoute, ensure, pagination, rateLimit } from "./security";
import { micro, walletEntry, yuan } from "./finance";

const paymentType = z.enum(["alipay", "wxpay", "qqpay"]);
const orderKind = z.enum(["recharge", "subscription"]);
export const PAYMENT_KEY_MASK = "********";

/** Public representation of a subscription plan. Never expose internal
 * micro-unit columns so the same shape can be used by admin and user pages. */
export function publicPlan(plan: Row) {
  const features = Array.isArray(plan.features)
    ? plan.features
    : typeof plan.features === "string"
      ? (() => {
          try {
            const value = JSON.parse(plan.features);
            return Array.isArray(value) ? value : [];
          } catch {
            return [];
          }
        })()
      : [];
  const price = yuan(plan.price_micro);
  const originalPrice = yuan(plan.original_price_micro);
  const quotaDay = Number(plan.daily_quota || 0);
  const quotaWeek = Number(plan.weekly_quota || 0);
  const quotaMonth = Number(plan.monthly_quota || 0);
  const validDays = Number(plan.duration || plan.plan_days || 30);
  const validUnit = plan.duration_unit || "day";
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || "",
    price,
    original_price: originalPrice,
    quota_day: quotaDay,
    quota_week: quotaWeek,
    quota_month: quotaMonth,
    valid_days: validDays,
    valid_unit: validUnit,
    days: Number(plan.plan_days || durationDays(validDays, validUnit)),
    // Camel case aliases keep older clients working while the admin API uses
    // the snake case names used by the plan editor.
    originalPrice,
    dailyQuota: quotaDay,
    weeklyQuota: quotaWeek,
    monthlyQuota: quotaMonth,
    quotaDay,
    quotaWeek,
    quotaMonth,
    duration: validDays,
    durationUnit: validUnit,
    sort: Number(plan.sort || 0),
    features,
    enabled: Boolean(plan.enabled),
    deleted_at: plan.deleted_at,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
}

function durationDays(duration: number, unit: string) {
  if (unit === "week") return duration * 7;
  if (unit === "month") return duration * 30;
  if (unit === "year") return duration * 365;
  return duration;
}

async function activePlans() {
  return db.query(
    "SELECT * FROM subscription_plans WHERE deleted_at IS NULL AND enabled=true ORDER BY sort ASC,created_at DESC",
  );
}

function paymentSettings(value: any) {
  return {
    enabled: false,
    gatewayUrl: "",
    pid: "",
    key: "",
    paymentType: "alipay" as const,
    notifyUrl: "",
    returnUrl: "",
    minRecharge: 1,
    maxRecharge: 100000,
    dailyLimit: 0,
    balanceRate: 1,
    renewalRate: 1,
    subscriptionRate: 1,
    renewalFeeRate: 1,
    orderTimeout: 30,
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
    ...(value || {}),
  };
}

function submitUrl(value: string) {
  const base = value.trim().replace(/\/+$/, "");
  return /\/submit\.php$/i.test(base) ? base : `${base}/submit.php`;
}

function queryUrl(value: string) {
  const base = value.trim().replace(/\/+$/, "");
  return /\/api\.php$/i.test(base) ? base : `${base}/api.php`;
}

function signParams(params: Record<string, string>, key: string) {
  const text = Object.keys(params)
    .filter(
      (name) =>
        name !== "sign" &&
        name !== "sign_type" &&
        params[name] !== "" &&
        params[name] !== undefined &&
        params[name] !== null,
    )
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash("md5").update(`${text}${key}`).digest("hex");
}

function sameSignature(expected: string, actual: string) {
  const a = Buffer.from(String(expected || "").toLowerCase());
  const b = Buffer.from(String(actual || "").toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicOrder(order: Row, checkoutUrl?: string) {
  const paymentUrl = checkoutUrl || order.payment_url || undefined;
  return {
    id: order.id,
    order_no: order.order_no,
    kind: order.kind,
    plan_id: order.plan_id,
    subject: order.subject,
    amount: yuan(order.amount_micro),
    credit_amount: yuan(order.credit_micro ?? order.amount_micro),
    status: order.status,
    gateway_trade_no: order.gateway_trade_no,
    checkout_url: paymentUrl,
    // `payment_url` is the signed URL accepted by 易支付. The client can
    // encode `qr_content` into a QR code without navigating away from the
    // current page. A provider supplied image URL can be added later without
    // changing the order contract.
    payment_url: paymentUrl,
    qr_content: order.qr_content || paymentUrl || null,
    qr_url: order.qr_url || null,
    paid_at: order.paid_at,
    expires_at: order.expires_at,
    created_at: order.created_at,
  };
}

function callbackUrl(value: string, fallback: string) {
  return value.trim() || fallback;
}

function orderNo() {
  return `IC${Date.now()}${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function amountText(amountMicro: number) {
  return (amountMicro / 1_000_000).toFixed(2);
}

function checkoutUrl(order: Row, payment: ReturnType<typeof paymentSettings>, origin: string) {
  const params: Record<string, string> = {
    pid: payment.pid,
    type: payment.paymentType,
    out_trade_no: order.order_no,
    notify_url: callbackUrl(payment.notifyUrl, `${origin}/api/v1/payments/notify`),
    return_url: callbackUrl(payment.returnUrl, `${origin}/wallet`),
    name: order.subject,
    money: amountText(Number(order.amount_micro)),
    sign_type: "MD5",
  };
  params.sign = signParams(params, payment.key);
  return `${submitUrl(payment.gatewayUrl)}?${new URLSearchParams(params).toString()}`;
}

function gatewayParams(
  order: Row,
  payment: ReturnType<typeof paymentSettings>,
  origin: string,
  clientIp = "127.0.0.1",
) {
  const params: Record<string, string> = {
    pid: payment.pid,
    type: payment.paymentType,
    out_trade_no: order.order_no,
    notify_url: callbackUrl(payment.notifyUrl, `${origin}/api/v1/payments/notify`),
    return_url: callbackUrl(payment.returnUrl, `${origin}/wallet`),
    name: order.subject,
    money: amountText(Number(order.amount_micro)),
    clientip: clientIp || "127.0.0.1",
    sign_type: "MD5",
  };
  params.sign = signParams(params, payment.key);
  return params;
}

/**
 * 易支付的 mapi.php endpoint returns a JSON object containing qrcode/payurl
 * for QR based channels. Some compatible gateways only expose submit.php, so
 * failure to call mapi.php falls back to the signed URL and never prevents an
 * order from being created.
 */
async function createGatewayPayment(
  order: Row,
  payment: ReturnType<typeof paymentSettings>,
  origin: string,
  clientIp?: string,
) {
  const fallback = checkoutUrl(order, payment, origin);
  if (payment.qrEnabled === false) return { paymentUrl: fallback, qrContent: null };
  const base = payment.gatewayUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:submit|mapi)\.php$/i, "");
  const params = gatewayParams(order, payment, origin, clientIp);
  try {
    const response = await fetch(`${base}/mapi.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    let payload: Record<string, any> = {};
    try {
      payload = JSON.parse(text);
    } catch {
      // HTML gateways still work through the signed submit URL.
    }
    if (payload.data && typeof payload.data === "object")
      payload = { ...payload, ...payload.data };
    if (
      Number(payload.code) === 1 ||
      payload.qrcode ||
      payload.qr_code ||
      payload.img ||
      payload.payurl ||
      payload.payurl2
    ) {
      const qrContent = String(
        payload.qrcode ||
          payload.qr_code ||
          payload.payurl2 ||
          payload.payurl ||
          payload.img ||
          payload.url ||
          fallback,
      );
      const paymentUrl = String(payload.payurl || payload.payurl2 || fallback);
      return { paymentUrl, qrContent };
    }
  } catch {
    // Keep the order usable if a provider's QR endpoint is unavailable.
  }
  return { paymentUrl: fallback, qrContent: null };
}

function isPaidPayload(payload: Record<string, any>) {
  return (
    String(payload.trade_status || payload.status || "").toUpperCase() ===
      "TRADE_SUCCESS" ||
    String(payload.trade_status || payload.status || "") === "1" ||
    String(payload.code || "") === "1"
  );
}

function payloadAmount(payload: Record<string, any>) {
  const value = payload.money ?? payload.amount ?? payload.price;
  return value === undefined || value === "" ? null : micro(String(value));
}

async function settlePaidOrder(
  orderNumber: string,
  payload: Record<string, any>,
) {
  return transaction(async (tx) => {
    const [order] = await tx.query(
      "SELECT * FROM payment_orders WHERE order_no=$1 FOR UPDATE",
      [orderNumber],
    );
    ensure(order, "支付订单不存在", 404);
    if (order.status === "paid") return order;
    // Cancellation/expiry only closes the local UI. A later, fully signed
    // provider success callback/query must still be able to credit the order
    // exactly once.
    ensure(
      order.status === "pending" || order.status === "canceled" || order.status === "expired",
      "支付订单已结束",
      409,
    );
    if (order.status === "pending")
      ensure(new Date(order.expires_at).getTime() > Date.now(), "支付订单已过期");
    const amount = payloadAmount(payload);
    ensure(amount !== null, "支付金额缺失");
    ensure(amount === Number(order.amount_micro), "支付金额不匹配");
    ensure(isPaidPayload(payload), "支付尚未完成");
    if (order.kind === "recharge") {
      await walletEntry(tx, order.user_id, {
        type: "recharge",
        amount: Number(order.credit_micro ?? order.amount_micro),
        key: `payment:${order.order_no}`,
        reason: `在线充值 · ${order.subject}`,
      });
    } else {
      const [active] = await tx.query(
        "SELECT ends_at FROM subscriptions WHERE user_id=$1 AND status='active' AND ends_at>now() ORDER BY ends_at DESC LIMIT 1 FOR UPDATE",
        [order.user_id],
      );
      // Prefer quotas snapshotted on the order. Older orders may not have
      // those columns populated, so retain a lookup fallback for them.
      let planQuota =
        order.plan_daily_quota_micro !== undefined &&
        order.plan_daily_quota_micro !== null
          ? {
              daily: Number(order.plan_daily_quota_micro || 0),
              weekly: Number(order.plan_weekly_quota_micro || 0),
              monthly: Number(order.plan_monthly_quota_micro || 0),
            }
          : null;
      if (!planQuota && order.plan_id && order.plan_id !== "monthly") {
        const [plan] = await tx.query(
          "SELECT daily_quota,weekly_quota,monthly_quota FROM subscription_plans WHERE id=$1",
          [order.plan_id],
        );
        if (plan)
          planQuota = {
            daily: micro(String(plan.daily_quota || 0)),
            weekly: micro(String(plan.weekly_quota || 0)),
            monthly: micro(String(plan.monthly_quota || 0)),
          };
      }
      const startMs = Math.max(Date.now(), active ? new Date(active.ends_at).getTime() : 0);
      const end = new Date(startMs + Number(order.plan_days || 30) * 86400000);
      await tx.query(
        "INSERT INTO subscriptions(id,user_id,payment_order_id,plan_id,name,amount_micro,daily_quota_micro,weekly_quota_micro,monthly_quota_micro,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          randomUUID(),
          order.user_id,
          order.id,
          order.plan_id || "monthly",
          order.subject,
          order.amount_micro,
          planQuota?.daily || 0,
          planQuota?.weekly || 0,
          planQuota?.monthly || 0,
          new Date(startMs).toISOString(),
          end.toISOString(),
        ],
      );
    }
    return (
      await tx.query(
        "UPDATE payment_orders SET status='paid',gateway_trade_no=$2,notify_payload=$3,paid_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [
          order.id,
          String(payload.trade_no || payload.transaction_id || ""),
          JSON.stringify(payload),
        ],
      )
    )[0];
  });
}

async function loadOrder(id: string, userId: string) {
  const [order] = await db.query(
    "SELECT * FROM payment_orders WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  ensure(order, "支付订单不存在", 404);
  return order;
}

export const paymentNotifyRouter = Router();
const handlePaymentNotify = asyncRoute(async (req, res) => {
    const payload = Object.fromEntries(
      Object.entries({ ...(req.query || {}), ...(req.body || {}) }).map(
        ([key, value]) => [key, String(value)],
      ),
    );
    const orderNumber = payload.out_trade_no;
    ensure(orderNumber && payload.sign, "支付通知参数不完整");
    const [order] = await db.query(
      "SELECT * FROM payment_orders WHERE order_no=$1",
      [orderNumber],
    );
    ensure(order, "支付订单不存在", 404);
    const payment = paymentSettings((await settings()).payment);
    ensure(payment.key, "支付网关未配置", 503);
    ensure(sameSignature(signParams(payload, payment.key), payload.sign), "支付签名无效", 400);
    await settlePaidOrder(orderNumber, payload);
    res.type("text/plain").send("success");
  });
paymentNotifyRouter.post("/", rateLimit("payment-notify", 120, 60), handlePaymentNotify);
paymentNotifyRouter.get("/", rateLimit("payment-notify", 120, 60), handlePaymentNotify);

export const paymentRouter = Router();
paymentRouter.get(
  "/config",
  asyncRoute(async (_req, res) => {
    const payment = paymentSettings((await settings()).payment);
    const plans = await activePlans();
    const publicPlans = plans.map(publicPlan);
    const [definedPlanCount] = await db.query(
      "SELECT count(*)::int AS count FROM subscription_plans",
    );
    const legacyPlan = {
      id: "monthly",
      name: payment.planName,
      price: payment.planPrice,
      days: payment.planDays,
      valid_days: payment.planDays,
      valid_unit: "day",
      original_price: payment.planPrice,
      quota_day: 0,
      quota_week: 0,
      quota_month: 0,
      sort: 0,
      features: [],
      enabled: true,
    };
    res.json({
      enabled: Boolean(payment.enabled && payment.gatewayUrl && payment.pid && payment.key),
      gateway: "易支付",
      paymentType: payment.paymentType,
      qrEnabled: payment.qrEnabled !== false,
      minRecharge: payment.minRecharge,
      maxRecharge: payment.maxRecharge,
      dailyLimit: payment.dailyLimit,
      balanceRate: payment.balanceRate,
      subscriptionRate: payment.subscriptionRate,
      renewalFeeRate: payment.renewalFeeRate,
      orderTimeout: payment.orderTimeout,
      orderTimeoutMinutes: payment.orderTimeoutMinutes,
      maxPendingOrders: payment.maxPendingOrders,
      plans: publicPlans.length
        ? publicPlans
        : Number(definedPlanCount?.count || 0) > 0
          ? []
          : [legacyPlan],
      // Keep the old single-plan property for clients deployed before the
      // plan manager was introduced.
      plan: publicPlans[0] || (Number(definedPlanCount?.count || 0) > 0 ? null : legacyPlan),
    });
  }),
);

paymentRouter.get(
  "/plans",
  asyncRoute(async (_req, res) => {
    const rows = await activePlans();
    res.json(rows.map(publicPlan));
  }),
);

paymentRouter.get(
  "/orders",
  asyncRoute(async (req, res) => {
    await db.query(
      "UPDATE payment_orders SET status='expired',updated_at=now() WHERE user_id=$1 AND status='pending' AND expires_at<=now()",
      [req.user.id],
    );
    const [limit, offset] = pagination(req, 100);
    const payment = paymentSettings((await settings()).payment);
    const origin = config.publicBase || `${req.protocol}://${req.get("host")}`;
    const rows = await db.query(
      "SELECT * FROM payment_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [req.user.id, limit, offset],
    );
    res.json(
      rows.map((row) =>
        publicOrder(
          row,
          row.status === "pending" && row.payment_url
            ? row.payment_url
            : row.status === "pending" && payment.enabled && payment.gatewayUrl && payment.pid && payment.key
            ? checkoutUrl(row, payment, origin)
            : undefined,
        ),
      ),
    );
  }),
);

paymentRouter.get(
  "/subscription",
  asyncRoute(async (req, res) => {
    const [subscription] = await db.query(
      "SELECT * FROM subscriptions WHERE user_id=$1 AND status='active' ORDER BY ends_at DESC LIMIT 1",
      [req.user.id],
    );
    if (!subscription) return res.json(null);
    res.json({
      ...subscription,
      amount: yuan(subscription.amount_micro),
      quota_day: yuan(subscription.daily_quota_micro || 0),
      quota_week: yuan(subscription.weekly_quota_micro || 0),
      quota_month: yuan(subscription.monthly_quota_micro || 0),
    });
  }),
);

paymentRouter.get(
  "/orders/:id",
  asyncRoute(async (req, res) => {
    const order = await loadOrder(req.params.id, req.user.id);
    res.json(publicOrder(order));
  }),
);

paymentRouter.post(
  "/orders",
  rateLimit("payment-order", 12, 60),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        kind: orderKind,
        amount: z.number().positive().max(1000000).optional(),
        planId: z.string().trim().min(1).max(40).optional(),
        plan_id: z.string().trim().min(1).max(40).optional(),
      })
      .parse(req.body);
    const payment = paymentSettings((await settings()).payment);
    ensure(payment.enabled, "在线支付暂未开启", 403);
    ensure(payment.gatewayUrl && payment.pid && payment.key, "支付网关尚未配置", 503);
    const pending = await db.query(
      "SELECT count(*)::int AS count FROM payment_orders WHERE user_id=$1 AND status='pending' AND expires_at>now()",
      [req.user.id],
    );
    ensure(
      Number(pending[0]?.count || 0) < Math.max(1, Number(payment.maxPendingOrders || 5)),
      "待支付订单过多，请先完成或取消已有订单",
      429,
    );
    let amountMicro: number;
    let creditMicro: number | null = null;
    let subject: string;
    let planId: string | null = null;
    let planDays: number | null = null;
    let planDailyQuotaMicro = 0;
    let planWeeklyQuotaMicro = 0;
    let planMonthlyQuotaMicro = 0;
    if (b.kind === "subscription") {
      const requestedPlanId = b.planId || b.plan_id;
      let plan: Row | undefined;
      if (requestedPlanId && requestedPlanId !== "monthly") {
        [plan] = await db.query(
          "SELECT * FROM subscription_plans WHERE id=$1 AND deleted_at IS NULL AND enabled=true",
          [requestedPlanId],
        );
        ensure(plan, "订阅套餐不存在", 404);
      } else if (requestedPlanId === "monthly") {
        [plan] = await db.query(
          "SELECT * FROM subscription_plans WHERE deleted_at IS NULL AND enabled=true ORDER BY sort ASC,created_at DESC LIMIT 1",
        );
        if (!plan) {
          const [defined] = await db.query(
            "SELECT id FROM subscription_plans LIMIT 1",
          );
          ensure(!defined, "当前没有可购买的订阅套餐", 404);
        }
      }
      amountMicro = plan
        ? Number(plan.price_micro)
        : micro(payment.planPrice);
      subject = plan?.name || payment.planName;
      planId = plan?.id || "monthly";
      planDays = plan
        ? durationDays(Number(plan.duration || 30), plan.duration_unit || "day")
        : payment.planDays;
      planDailyQuotaMicro = plan ? micro(Number(plan.daily_quota || 0)) : 0;
      planWeeklyQuotaMicro = plan ? micro(Number(plan.weekly_quota || 0)) : 0;
      planMonthlyQuotaMicro = plan ? micro(Number(plan.monthly_quota || 0)) : 0;
    } else {
      ensure(b.amount !== undefined, "请输入充值金额");
      ensure(b.amount >= payment.minRecharge, `充值金额不能低于 ${payment.minRecharge} 元`);
      ensure(
        b.amount <= Number(payment.maxRecharge || 100000),
        `充值金额不能高于 ${payment.maxRecharge || 100000} 元`,
      );
      if (Number(payment.dailyLimit || 0) > 0) {
        const [today] = await db.query(
          "SELECT COALESCE(sum(amount_micro),0) AS amount FROM payment_orders WHERE user_id=$1 AND kind='recharge' AND created_at>=date_trunc('day',now()) AND status IN ('pending','paid')",
          [req.user.id],
        );
        ensure(
          Number(today?.amount || 0) + micro(b.amount) <= micro(Number(payment.dailyLimit)),
          `今日充值金额不能超过 ${payment.dailyLimit} 元`,
        );
      }
      amountMicro = micro(b.amount);
      creditMicro = micro(b.amount * Number(payment.balanceRate || 1));
      subject = `${payment.productPrefix || ""}余额充值${payment.productSuffix || ""}`;
    }
    const number = orderNo();
    const id = randomUUID();
    const timeoutMinutes = Math.min(
      24 * 60,
      Math.max(1, Number(payment.orderTimeoutMinutes || payment.orderTimeout || 30)),
    );
    const expires = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();
    const [order] = await db.query(
      "INSERT INTO payment_orders(id,user_id,order_no,kind,plan_id,plan_days,plan_daily_quota_micro,plan_weekly_quota_micro,plan_monthly_quota_micro,amount_micro,credit_micro,subject,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *",
      [id, req.user.id, number, b.kind, planId, planDays, planDailyQuotaMicro, planWeeklyQuotaMicro, planMonthlyQuotaMicro, amountMicro, creditMicro, subject, expires],
    );
    const origin = config.publicBase || `${req.protocol}://${req.get("host")}`;
    const gateway = await createGatewayPayment(order, payment, origin, req.ip);
    const [saved] = await db.query(
      "UPDATE payment_orders SET payment_url=$2,qr_content=$3,updated_at=now() WHERE id=$1 RETURNING *",
      [order.id, gateway.paymentUrl, gateway.qrContent],
    );
    res.status(201).json(publicOrder(saved || order, gateway.paymentUrl));
  }),
);

paymentRouter.post(
  "/orders/:id/check",
  rateLimit("payment-check", 30, 60),
  asyncRoute(async (req, res) => {
    const order = await loadOrder(req.params.id, req.user.id);
    if (order.status === "pending" && new Date(order.expires_at).getTime() <= Date.now()) {
      await db.query(
        "UPDATE payment_orders SET status='expired',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending'",
        [order.id, req.user.id],
      );
    }
    if (order.status === "pending" || order.status === "expired") {
      const payment = paymentSettings((await settings()).payment);
      ensure(payment.gatewayUrl && payment.pid && payment.key, "支付网关尚未配置", 503);
      const params = new URLSearchParams({
        act: "order",
        pid: payment.pid,
        key: payment.key,
        out_trade_no: order.order_no,
      });
      const response = await fetch(`${queryUrl(payment.gatewayUrl)}?${params}`, {
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.text();
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = {};
      }
      const result =
        payload.data && typeof payload.data === "object" ? payload.data : payload;
      const returnedOrder = String(result.out_trade_no || result.order_no || "");
      const returnedPid = result.pid === undefined ? payment.pid : String(result.pid);
      if (
        Number(payload.code ?? result.code) === 1 &&
        Number(result.status) === 1 &&
        returnedOrder === order.order_no &&
        returnedPid === String(payment.pid)
      ) {
        const expected = payload.sign || result.sign;
        const signatureSource = payload.sign ? payload : result;
        ensure(
          !expected || sameSignature(signParams(signatureSource, payment.key), expected),
          "支付查询签名无效",
        );
        ensure(result.money !== undefined && result.money !== "", "支付金额缺失");
        await settlePaidOrder(order.order_no, {
          ...result,
          out_trade_no: order.order_no,
          trade_status: "TRADE_SUCCESS",
          money: result.money ?? amountText(Number(order.amount_micro)),
        });
      }
    }
    const current = await loadOrder(order.id, req.user.id);
    res.json(publicOrder(current));
  }),
);

paymentRouter.post(
  "/orders/:id/cancel",
  rateLimit("payment-cancel", 30, 60),
  asyncRoute(async (req, res) => {
    const [order] = await db.query(
      "UPDATE payment_orders SET status='canceled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *",
      [req.params.id, req.user.id],
    );
    ensure(order, "订单不存在或已结束", 409);
    res.json(publicOrder(order));
  }),
);

// DELETE is kept as a REST-friendly alias for clients that model cancellation
// as removing a local pending order.
paymentRouter.delete(
  "/orders/:id",
  rateLimit("payment-cancel", 30, 60),
  asyncRoute(async (req, res) => {
    const [order] = await db.query(
      "UPDATE payment_orders SET status='canceled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *",
      [req.params.id, req.user.id],
    );
    ensure(order, "订单不存在或已结束", 409);
    res.json(publicOrder(order));
  }),
);
