import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { config, defaults } from "./config";
import { OFFICIAL_PRICES } from "../shared/wan";
import { IMAGE_OFFICIAL_PRICES } from "../shared/image";
import { randomUUID } from "node:crypto";
import { protocolFor } from "../shared/protocols";
import { registerModelAdapters } from "../shared/catalog";

export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(text: string, params?: any[]): Promise<T[]>;
}
const pool = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl })
  : null;
const local = pool ? null : new PGlite(path.join(config.dataDir, "postgres"));
export const db: Queryable = {
  async query<T extends Row = Row>(
    text: string,
    params: any[] = [],
  ): Promise<T[]> {
    const result = pool
      ? await pool.query(text, params)
      : await local!.query<T>(text, params);
    return result.rows as T[];
  },
};
export async function transaction<T>(
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (local)
    return local.transaction(async (t) =>
      fn({
        query: async <R extends Row = Row>(s: string, p: any[] = []) =>
          (await t.query<R>(s, p)).rows,
      }),
    );
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: async <R extends Row = Row>(s: string, p: any[] = []) =>
        (await client.query(s, p)).rows as R[],
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate() {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  if (pool) await pool.query(sql);
  else await local!.exec(sql);
  await db.query(
    "INSERT INTO settings(id,value) VALUES(1,$1) ON CONFLICT DO NOTHING",
    [JSON.stringify(defaults)],
  );
  // Keep the legacy single subscription setting available as a real plan so
  // existing installations can immediately use the plan management API.
  const currentSettings =
    (await db.query("SELECT value FROM settings WHERE id=1"))[0]?.value ||
    defaults;
  const payment = { ...defaults.payment, ...(currentSettings.payment || {}) };
  await db.query(
    "INSERT INTO subscription_plans(id,name,description,price_micro,original_price_micro,duration,duration_unit,sort,features,enabled) SELECT $1,$2,'',$3,$3,$4,'day',0,'[]',true WHERE NOT EXISTS(SELECT 1 FROM subscription_plans)",
    [
      randomUUID(),
      payment.planName || defaults.payment.planName,
      Math.round(
        Math.max(1, Number(payment.planPrice || defaults.payment.planPrice)) *
          1_000_000,
      ),
      Math.max(1, Number(payment.planDays || defaults.payment.planDays)),
    ],
  );
  for (const [model, tiers] of Object.entries(OFFICIAL_PRICES))
    for (const [resolution, price] of Object.entries(tiers)) {
      await db.query(
        "INSERT INTO prices(id,model,resolution,official_micro,sale_micro,effective_at) SELECT $1,$2,$3,$4,$4,now() WHERE NOT EXISTS(SELECT 1 FROM prices WHERE model=$2 AND resolution=$3)",
        [randomUUID(), model, resolution, price * 1_000_000],
      );
    }

  // 图片价格初始化
  for (const [model, tiers] of Object.entries(IMAGE_OFFICIAL_PRICES))
    for (const [size_category, prices] of Object.entries(tiers)) {
      await db.query(
        "INSERT INTO image_prices(id,model,size_category,input_official_micro,input_sale_micro,output_official_micro,output_sale_micro) SELECT $1,$2,$3,$4,$4,$5,$5 WHERE NOT EXISTS(SELECT 1 FROM image_prices WHERE model=$2 AND size_category=$3)",
        [
          randomUUID(),
          model,
          size_category,
          prices.input * 1_000_000,
          prices.output * 1_000_000,
        ],
      );
    }
  for (const [model, type] of [
    ...Object.keys(OFFICIAL_PRICES).map((model) => [model, "video"]),
    ...Object.keys(IMAGE_OFFICIAL_PRICES).map((model) => [model, "image"]),
  ]) {
    // Preserve deleted models across restarts.
    await db.query(
      "INSERT INTO model_catalog(model,display_name,type,adapter) VALUES($1,$1,$2,$1) ON CONFLICT DO NOTHING",
      [model, type],
    );
  }
  const [catalogMigration] = await db.query(
    "SELECT version FROM schema_migrations WHERE version=2026102201",
  );
  if (!catalogMigration) {
    await db.query(`INSERT INTO model_channels(model,channel_id,source,upstream_model)
      SELECT m.model,c.id,'video',m.model FROM model_catalog m JOIN credentials c ON c.models ? m.model WHERE m.type='video'
      ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO model_channels(model,channel_id,source,upstream_model)
      SELECT m.model,c.id,'image',m.model FROM model_catalog m JOIN image_credentials c ON
        (c.metadata->'models' ? m.model OR COALESCE(c.metadata->'models','[]'::jsonb)='[]'::jsonb)
        AND ((c.provider='qwen' AND m.model LIKE 'qwen-%') OR (c.provider='openai' AND m.model LIKE 'gpt-%'))
      WHERE m.type='image' ON CONFLICT DO NOTHING`);
    await db.query(
      "INSERT INTO schema_migrations(version) VALUES(2026102201) ON CONFLICT DO NOTHING",
    );
  }
  const protocols = await db.query(
    "SELECT model,type,adapter FROM model_catalog WHERE protocol=''",
  );
  for (const row of protocols)
    await db.query("UPDATE model_catalog SET protocol=$2 WHERE model=$1", [
      row.model,
      protocolFor(row.type, row.adapter, row.model),
    ]);
  registerModelAdapters(
    await db.query("SELECT model,adapter,capabilities FROM model_catalog"),
  );
}
export async function settings() {
  return {
    ...defaults,
    ...(await db.query("SELECT value FROM settings WHERE id=1"))[0]?.value,
  };
}
export async function closeDb() {
  if (pool) await pool.end();
  else await local!.close();
}
