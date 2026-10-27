import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { db, type Queryable, type Row } from "./db";
import { ensure } from "./security";

export const micro = (amount: number | string) =>
  new Decimal(amount)
    .mul(1_000_000)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
export const yuan = (amount: number | string) =>
  new Decimal(amount).div(1_000_000).toNumber();
export const charge = (price: number | string, duration: number | string) =>
  new Decimal(price)
    .mul(duration)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
export async function currentPrices(tx: Queryable = db) {
  return tx.query(
    "SELECT * FROM prices WHERE deleted_at IS NULL AND effective_at<=now() ORDER BY model,resolution",
  );
}
export function publicPrice(p: Row) {
  return {
    id: p.id,
    version: p.version,
    model: p.model,
    resolution: p.resolution,
    official: yuan(p.official_micro),
    sale: yuan(p.sale_micro),
    enabled: p.enabled,
    effective_at: p.effective_at,
  };
}
export async function audit(
  actor: string | null,
  action: string,
  target: string | null,
  detail: object = {},
  tx: Queryable = db,
) {
  await tx.query(
    "INSERT INTO audit_logs(id,actor_id,action,target,detail) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, action, target, JSON.stringify(detail)],
  );
}
export async function walletEntry(
  tx: Queryable,
  userId: string,
  typeOrEntry: string | {
    type: string;
    amount: number;
    frozen?: number;
    key: string;
    reason: string;
    taskId?: string;
    imageTaskId?: string;
    actor?: string;
    relatedId?: string;
    requestHash?: string;
  },
  amount?: number,
  reason?: string,
  taskId?: string,
) {
  // 兼容新旧调用方式
  const entry = typeof typeOrEntry === 'string'
    ? { type: typeOrEntry, amount: amount!, reason: reason!, taskId, key: `${typeOrEntry}:${taskId || randomUUID()}` }
    : typeOrEntry;
  const [wallet] = await tx.query(
    "SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE",
    [userId],
  );
  const [existing] = await tx.query(
    "SELECT * FROM ledger WHERE business_key=$1",
    [entry.key],
  );
  if (existing) {
    ensure(
      existing.user_id === userId &&
        existing.type === entry.type &&
        Number(existing.amount) === entry.amount &&
        Number(existing.frozen_delta) === (entry.frozen || 0),
      "资金幂等键冲突",
      409,
    );
    return existing;
  }
  ensure(wallet, "用户钱包不存在");
  const available = Number(wallet.available) + entry.amount;
  const frozen = Number(wallet.frozen) + (entry.frozen || 0);
  ensure(
    Number.isSafeInteger(available) &&
      Number.isSafeInteger(frozen) &&
      available >= 0 &&
      frozen >= 0,
    "可用余额不足或冻结金额异常",
  );
  await tx.query("UPDATE wallets SET available=$2,frozen=$3 WHERE user_id=$1", [
    userId,
    available,
    frozen,
  ]);
  const [result] = await tx.query(
    "INSERT INTO ledger(id,user_id,type,amount,frozen_delta,available_after,frozen_after,task_id,image_task_id,actor_id,related_id,business_key,reason,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
    [
      randomUUID(),
      userId,
      entry.type,
      entry.amount,
      entry.frozen || 0,
      available,
      frozen,
      entry.taskId || null,
      entry.imageTaskId || null,
      entry.actor || null,
      entry.relatedId || null,
      entry.key,
      entry.reason,
      entry.requestHash || null,
    ],
  );
  return result;
}
function taskAllocations(task: Row) {
  const value = task.subscription_allocations;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}
export async function walletReserve(
  tx: Queryable,
  userId: string,
  amount: number,
) {
  if (amount <= 0) return;
  await walletEntry(tx, userId, {
    type: "reserve",
    amount: 0,
    frozen: amount,
    key: `reserve:${randomUUID()}`,
    reason: "预占余额",
  });
}

export function getWalletReserveAmount(task: Row) {
  const split =
    task.wallet_reserve_micro !== undefined &&
    (Number(task.wallet_reserve_micro) > 0 ||
      Number(task.subscription_reserve_micro || 0) > 0 ||
      taskAllocations(task).length > 0);
  return split ? Number(task.wallet_reserve_micro || 0) : Number(task.reserve_micro || 0);
}
/** Releases the subscription quota reservation and records the portion actually used. */
export async function settleSubscriptionQuota(
  tx: Queryable,
  task: Row,
  usedMicro: number,
) {
  let remaining = Math.max(0, Math.floor(usedMicro));
  for (const allocation of taskAllocations(task)) {
    const reserved = Math.max(0, Number(allocation.amount || 0));
    if (!reserved) continue;
    const used = Math.min(reserved, remaining);
    remaining -= used;
    await tx.query(
      "UPDATE subscription_usage SET reserved_micro=GREATEST(0,reserved_micro-$4),used_micro=used_micro+$5,updated_at=now() WHERE subscription_id=$1 AND period_type=$2 AND period_start=$3",
      [allocation.subscription_id, allocation.period_type, allocation.period_start, reserved, used],
    );
  }
}
export async function releaseTask(
  tx: Queryable,
  task: Row,
  status: string,
  error: string,
) {
  if (task.settlement === "reserved") {
    await settleSubscriptionQuota(tx, task, 0);
    const walletAmount = getWalletReserveAmount(task);
    if (walletAmount > 0)
      await walletEntry(tx, task.user_id, {
        type: "release",
        amount: walletAmount,
        frozen: -walletAmount,
        key: `release:${task.id}`,
        taskId: task.id,
        reason: error,
      });
  }
  await tx.query(
    "UPDATE tasks SET status=$2,error=$3,settlement=CASE WHEN settlement='reserved' THEN 'released' ELSE settlement END,completed_at=now(),updated_at=now() WHERE id=$1",
    [task.id, status, error],
  );
}
export const publicTask = (t: Row) => ({
  id: t.id,
  project_id: t.project_id,
  node_id: t.node_id,
  source: t.source,
  api_key_id: t.api_key_id,
  model: t.model,
  resolution: t.resolution,
  mode: t.mode,
  status: t.status,
  settlement: t.settlement,
  storage_status: t.storage_status,
  input: t.input,
  usage: t.usage,
  result_asset_id: t.result_asset_id,
  price: yuan(t.price_micro),
  reserved: yuan(t.reserve_micro),
  charged: yuan(t.charged_micro),
  refunded: yuan(t.refunded_micro),
  error: t.error,
  created_at: t.created_at,
  completed_at: t.completed_at,
  updated_at: t.updated_at,
});
