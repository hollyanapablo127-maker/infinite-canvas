CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings(id integer PRIMARY KEY, value jsonb NOT NULL, version integer NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL, email text UNIQUE,
  email_verified boolean NOT NULL DEFAULT false, password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','user')),
  disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), last_active timestamptz, preferences jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions(id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, user_agent text);
CREATE TABLE IF NOT EXISTS email_codes(id uuid PRIMARY KEY, email text NOT NULL, purpose text NOT NULL, code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), consumed boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS wallets(user_id uuid PRIMARY KEY REFERENCES users(id), available bigint NOT NULL DEFAULT 0 CHECK(available>=0), frozen bigint NOT NULL DEFAULT 0 CHECK(frozen>=0));
CREATE TABLE IF NOT EXISTS payment_orders(
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  order_no text UNIQUE NOT NULL,
  kind text NOT NULL CHECK(kind IN ('recharge','subscription')),
  plan_id text,
  plan_days integer,
  plan_daily_quota_micro bigint NOT NULL DEFAULT 0,
  plan_weekly_quota_micro bigint NOT NULL DEFAULT 0,
  plan_monthly_quota_micro bigint NOT NULL DEFAULT 0,
  amount_micro bigint NOT NULL CHECK(amount_micro>0),
  credit_micro bigint,
  subject text NOT NULL,
  gateway text NOT NULL DEFAULT 'epay',
  gateway_trade_no text,
  payment_url text,
  qr_content text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','failed','canceled')),
  notify_payload jsonb NOT NULL DEFAULT '{}',
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_orders_owner ON payment_orders(user_id,created_at DESC);
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_days integer;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_daily_quota_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_weekly_quota_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS plan_monthly_quota_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS credit_micro bigint;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS payment_url text;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS qr_content text;
DO $$
BEGIN
  ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
  ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check CHECK(status IN ('pending','paid','expired','failed','canceled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS subscription_plans(
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_micro bigint NOT NULL CHECK(price_micro>0),
  original_price_micro bigint NOT NULL CHECK(original_price_micro>0),
  daily_quota numeric(18,6) NOT NULL DEFAULT 0 CHECK(daily_quota>=0),
  weekly_quota numeric(18,6) NOT NULL DEFAULT 0 CHECK(weekly_quota>=0),
  monthly_quota numeric(18,6) NOT NULL DEFAULT 0 CHECK(monthly_quota>=0),
  duration integer NOT NULL DEFAULT 30 CHECK(duration>0),
  duration_unit text NOT NULL DEFAULT 'day' CHECK(duration_unit IN ('day','week','month','year')),
  sort integer NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '[]',
  enabled boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_plans_public ON subscription_plans(enabled,sort,created_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS daily_quota numeric(18,6) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS weekly_quota numeric(18,6) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS monthly_quota numeric(18,6) NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS duration integer NOT NULL DEFAULT 30;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS duration_unit text NOT NULL DEFAULT 'day';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 0;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '[]';
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS subscriptions(
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  payment_order_id uuid UNIQUE NOT NULL REFERENCES payment_orders(id),
  plan_id text NOT NULL,
  name text NOT NULL,
  amount_micro bigint NOT NULL,
  daily_quota_micro bigint NOT NULL DEFAULT 0,
  weekly_quota_micro bigint NOT NULL DEFAULT 0,
  monthly_quota_micro bigint NOT NULL DEFAULT 0,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','canceled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_owner ON subscriptions(user_id,ends_at DESC);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS daily_quota_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS weekly_quota_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS monthly_quota_micro bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS subscription_usage(
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  period_type text NOT NULL CHECK(period_type IN ('day','week','month')),
  period_start date NOT NULL,
  reserved_micro bigint NOT NULL DEFAULT 0 CHECK(reserved_micro>=0),
  used_micro bigint NOT NULL DEFAULT 0 CHECK(used_micro>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(subscription_id,period_type,period_start)
);
CREATE TABLE IF NOT EXISTS api_keys(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, key_hash text UNIQUE NOT NULL, prefix text NOT NULL, disabled boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false, expires_at timestamptz, daily_limit bigint NOT NULL, monthly_limit bigint NOT NULL, models jsonb NOT NULL DEFAULT '["*"]', created_at timestamptz NOT NULL DEFAULT now(), last_used timestamptz);
CREATE TABLE IF NOT EXISTS credentials(id uuid PRIMARY KEY, name text NOT NULL, account_group text NOT NULL, workspace text NOT NULL, secret text NOT NULL, version integer NOT NULL DEFAULT 1, enabled boolean NOT NULL DEFAULT true, models jsonb NOT NULL DEFAULT '["wan3.0-video","wan3.0-video-prime"]', multiplier numeric(12,6) NOT NULL DEFAULT 1, priority integer NOT NULL DEFAULT 0, concurrency integer NOT NULL DEFAULT 5, rps integer NOT NULL DEFAULT 5, budget_micro bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS credential_versions(credential_id uuid NOT NULL REFERENCES credentials(id), version integer NOT NULL, secret text NOT NULL, workspace text NOT NULL, PRIMARY KEY(credential_id,version));
CREATE TABLE IF NOT EXISTS prices(id uuid PRIMARY KEY, model text NOT NULL, resolution text NOT NULL, official_micro bigint NOT NULL CHECK(official_micro>0), sale_micro bigint NOT NULL CHECK(sale_micro>0), enabled boolean NOT NULL DEFAULT true, effective_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS prices_lookup ON prices(model,resolution,effective_at DESC);
ALTER TABLE prices ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE prices ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY model,resolution
    ORDER BY (effective_at<=now()) DESC,
      CASE WHEN effective_at<=now() THEN effective_at END DESC,
      CASE WHEN effective_at>now() THEN effective_at END ASC,
      created_at DESC,id DESC
  ) AS position
  FROM prices WHERE deleted_at IS NULL
)
UPDATE prices AS p SET deleted_at=now()
FROM ranked WHERE p.id=ranked.id AND ranked.position>1;
CREATE UNIQUE INDEX IF NOT EXISTS prices_current_tier ON prices(model,resolution) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS projects(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, description text NOT NULL DEFAULT '', content jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}', version integer NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS project_revisions(id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), version integer NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,version));
CREATE TABLE IF NOT EXISTS assets(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, kind text NOT NULL, object_key text, storage text NOT NULL, source_url text, metadata jsonb NOT NULL DEFAULT '{}', size bigint NOT NULL DEFAULT 0, tags jsonb NOT NULL DEFAULT '[]', parent_id uuid REFERENCES assets(id), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, deleted_at timestamptz, purged_at timestamptz);
CREATE INDEX IF NOT EXISTS assets_owner ON assets(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS tasks(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL, source text NOT NULL, project_id uuid REFERENCES projects(id), node_id text, input jsonb NOT NULL, prepared_media jsonb NOT NULL DEFAULT '[]', model text NOT NULL, resolution text NOT NULL, mode text NOT NULL, status text NOT NULL DEFAULT 'QUEUED', settlement text NOT NULL DEFAULT 'reserved', storage_status text NOT NULL DEFAULT 'pending', price_id uuid NOT NULL REFERENCES prices(id), price_micro bigint NOT NULL, official_micro bigint NOT NULL, reserve_micro bigint NOT NULL, wallet_reserve_micro bigint NOT NULL DEFAULT 0, subscription_reserve_micro bigint NOT NULL DEFAULT 0, subscription_allocations jsonb NOT NULL DEFAULT '[]', charged_micro bigint NOT NULL DEFAULT 0, refunded_micro bigint NOT NULL DEFAULT 0, cost_micro bigint NOT NULL DEFAULT 0, actual_cost_micro bigint, multiplier numeric(12,6), credential_id uuid REFERENCES credentials(id), credential_version integer, account_group text, upstream_id text, request_id text, usage jsonb, provider_response jsonb, result_asset_id uuid REFERENCES assets(id), result_url text, error text, internal_error text, idempotency_key text NOT NULL, request_hash text NOT NULL, lease_until timestamptz, next_poll timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE(user_id,idempotency_key));
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(status,next_poll);
CREATE INDEX IF NOT EXISTS tasks_upstream ON tasks(upstream_id);
CREATE TABLE IF NOT EXISTS ledger(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), type text NOT NULL, amount bigint NOT NULL, frozen_delta bigint NOT NULL DEFAULT 0, available_after bigint NOT NULL, frozen_after bigint NOT NULL, task_id uuid REFERENCES tasks(id), related_id uuid REFERENCES ledger(id), reason text NOT NULL, actor_id uuid REFERENCES users(id), business_key text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS task_events(id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), status text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs(id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, target text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS announcements(id uuid PRIMARY KEY, title text NOT NULL, body text NOT NULL, level text NOT NULL DEFAULT 'normal', audience text NOT NULL DEFAULT 'all', published boolean NOT NULL DEFAULT false, pinned boolean NOT NULL DEFAULT false, starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS announcement_reads(user_id uuid NOT NULL REFERENCES users(id), announcement_id uuid NOT NULL REFERENCES announcements(id), version integer NOT NULL, read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,announcement_id));
CREATE TABLE IF NOT EXISTS notifications(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), title text NOT NULL, body text NOT NULL, resource_id text, unique_key text UNIQUE NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS export_jobs(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), asset_ids jsonb NOT NULL, status text NOT NULL DEFAULT 'QUEUED', object_key text, error text, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workflow_runs(id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), project_id uuid NOT NULL REFERENCES projects(id), steps jsonb NOT NULL, status text NOT NULL DEFAULT 'RUNNING', error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS worker_locks(name text PRIMARY KEY, owner text NOT NULL, expires_at timestamptz NOT NULL);
INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS verified_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_received_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS wallet_reserve_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subscription_reserve_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subscription_allocations jsonb NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX IF NOT EXISTS workflow_idempotency ON workflow_runs(user_id,request_key) WHERE request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS upstream_unique ON tasks(account_group,upstream_id) WHERE upstream_id IS NOT NULL;

-- 图片生成相关表
CREATE TABLE IF NOT EXISTS image_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model TEXT NOT NULL,
  size_category TEXT NOT NULL CHECK (size_category IN ('1K', '2K', '4K')),
  input_official_micro BIGINT NOT NULL,
  input_sale_micro BIGINT NOT NULL,
  output_official_micro BIGINT NOT NULL,
  output_sale_micro BIGINT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  version INTEGER DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_image_prices_model ON image_prices(model, size_category) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS image_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('qwen', 'openai')),
  name TEXT NOT NULL,
  workspace TEXT,
  base_url TEXT,
  encrypted_key TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  enabled BOOLEAN DEFAULT true,
  deleted BOOLEAN DEFAULT false,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE image_credentials ADD COLUMN IF NOT EXISTS workspace TEXT;
ALTER TABLE image_credentials ADD COLUMN IF NOT EXISTS base_url TEXT;
CREATE TABLE IF NOT EXISTS image_credential_versions (
  credential_id UUID NOT NULL REFERENCES image_credentials(id),
  version INTEGER NOT NULL,
  encrypted_key TEXT NOT NULL,
  workspace TEXT,
  base_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, version)
);
INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace,base_url)
SELECT id,key_version,encrypted_key,workspace,base_url FROM image_credentials
ON CONFLICT (credential_id,version) DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_image_credentials_provider ON image_credentials(provider) WHERE enabled AND NOT deleted;

CREATE TABLE IF NOT EXISTS image_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('text', 'image')),
  prompt TEXT NOT NULL,
  parameters JSONB NOT NULL,
  input_images TEXT,
  credential_id UUID REFERENCES image_credentials(id),
  credential_version INTEGER NOT NULL DEFAULT 1,
  price_id UUID REFERENCES image_prices(id),
  price_version INTEGER NOT NULL,
  input_count INTEGER DEFAULT 0,
  output_count INTEGER NOT NULL,
  actual_output_count INTEGER,
  size_category TEXT NOT NULL,
  input_unit_micro BIGINT NOT NULL,
  output_unit_micro BIGINT NOT NULL,
  price_snapshot JSONB NOT NULL DEFAULT '{}',
  reserved_micro BIGINT NOT NULL,
  charged_micro BIGINT,
  project_id UUID REFERENCES projects(id),
  node_id TEXT,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  workflow_run_id UUID,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING','SUCCEEDED','FAILED','CANCELED','CANCELING','UNKNOWN','RECONCILE','DELIVERY_FAILED')),
  settlement TEXT DEFAULT 'reserved' CHECK (settlement IN ('reserved','charged','canceled','refunded','released')),
  upstream_task_id TEXT,
  response JSONB,
  result_assets TEXT,
  usage JSONB,
  error TEXT,
  lease_until TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS image_task_id UUID REFERENCES image_tasks(id);
CREATE INDEX IF NOT EXISTS ledger_image_task ON ledger(image_task_id) WHERE image_task_id IS NOT NULL;
ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS price_snapshot JSONB NOT NULL DEFAULT '{}';
ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS next_poll_at TIMESTAMPTZ;
ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS credential_version INTEGER NOT NULL DEFAULT 1;
UPDATE image_tasks t SET credential_version=c.key_version
FROM image_credentials c WHERE t.credential_id=c.id AND t.credential_version=1 AND c.key_version<>1;
ALTER TABLE image_tasks DROP CONSTRAINT IF EXISTS image_tasks_settlement_check;
ALTER TABLE image_tasks ADD CONSTRAINT image_tasks_settlement_check
  CHECK (settlement IN ('reserved','charged','canceled','refunded','released'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_tasks_idempotency ON image_tasks(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_image_tasks_user ON image_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_tasks_project ON image_tasks(project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status) WHERE status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING');
CREATE INDEX IF NOT EXISTS idx_image_tasks_poll ON image_tasks(next_poll_at) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX IF NOT EXISTS idx_image_tasks_workflow ON image_tasks(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS image_task_events (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES image_tasks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_task_events_task ON image_task_events(task_id, created_at);

-- Extensible model directory and OpenAI-compatible language channels.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_multiplier numeric(10,6) NOT NULL DEFAULT 1 CHECK(discount_multiplier>=0 AND discount_multiplier<=1);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_price_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS base_reserve_micro bigint NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS discount_multiplier numeric(10,6) NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS upstream_model text;
ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS discount_multiplier numeric(10,6) NOT NULL DEFAULT 1;
ALTER TABLE image_tasks ADD COLUMN IF NOT EXISTS upstream_model text;
CREATE TABLE IF NOT EXISTS model_catalog (
  model text PRIMARY KEY, display_name text NOT NULL, type text NOT NULL CHECK(type IN ('video','image','language','speech')),
  description text NOT NULL DEFAULT '', adapter text NOT NULL DEFAULT '', enabled boolean NOT NULL DEFAULT true,
  input_price_micro bigint NOT NULL DEFAULT 0 CHECK(input_price_micro>=0), output_price_micro bigint NOT NULL DEFAULT 0 CHECK(output_price_micro>=0),
  version integer NOT NULL DEFAULT 1, sort integer NOT NULL DEFAULT 0,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS language_channels (
  id uuid PRIMARY KEY, name text NOT NULL, base_url text NOT NULL, encrypted_key text NOT NULL,
  models jsonb NOT NULL DEFAULT '[]', model_mapping jsonb NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS model_channels (
  model text NOT NULL REFERENCES model_catalog(model), channel_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('video','image','language')), upstream_model text NOT NULL,
  PRIMARY KEY(model, channel_id)
);
CREATE INDEX IF NOT EXISTS model_channels_channel ON model_channels(channel_id);
CREATE TABLE IF NOT EXISTS language_runs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), model text NOT NULL,
  channel_id uuid NOT NULL REFERENCES language_channels(id), upstream_model text NOT NULL,
  input_price_micro bigint NOT NULL, output_price_micro bigint NOT NULL, discount_multiplier numeric(10,6) NOT NULL,
  reserved_micro bigint NOT NULL DEFAULT 0, charged_micro bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'streaming', input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  usage_estimated boolean NOT NULL DEFAULT false, error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS language_runs_user ON language_runs(user_id,created_at DESC);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS language_run_id uuid REFERENCES language_runs(id);

ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS billing_unit text NOT NULL DEFAULT 'million_tokens' CHECK(billing_unit IN ('million_tokens','million_characters','second','request'));

ALTER TABLE language_runs ADD COLUMN IF NOT EXISTS request_key text;
ALTER TABLE language_runs ADD COLUMN IF NOT EXISTS request_hash text NOT NULL DEFAULT '';
ALTER TABLE language_runs ADD COLUMN IF NOT EXISTS model_version integer NOT NULL DEFAULT 1;
ALTER TABLE language_runs ADD COLUMN IF NOT EXISTS result_text text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS language_run_idempotency ON language_runs(user_id,request_key) WHERE request_key IS NOT NULL;

-- Keep historical references while enforcing one current image tier under concurrent writes.
WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY model,size_category ORDER BY updated_at DESC,created_at DESC,id DESC) AS position
  FROM image_prices WHERE deleted_at IS NULL
)
UPDATE image_prices AS p SET deleted_at=now() FROM ranked WHERE p.id=ranked.id AND ranked.position>1;
CREATE UNIQUE INDEX IF NOT EXISTS image_prices_current_tier ON image_prices(model,size_category) WHERE deleted_at IS NULL;

ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS routing_configured boolean NOT NULL DEFAULT false;

-- A channel is one administrator-managed connection. Member credentials are internal snapshots.
ALTER TABLE credentials ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE credential_versions ADD COLUMN IF NOT EXISTS base_url text;
CREATE TABLE IF NOT EXISTS provider_channels (
 id uuid PRIMARY KEY, provider text NOT NULL CHECK(provider IN ('bailian','openai','language')),
 name text NOT NULL, region text NOT NULL DEFAULT 'cn-beijing',workspace text NOT NULL DEFAULT '',base_url text NOT NULL,
 encrypted_key text NOT NULL,models jsonb NOT NULL DEFAULT '[]',model_mapping jsonb NOT NULL DEFAULT '{}',
 priority integer NOT NULL DEFAULT 0,enabled boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,
 video_id uuid REFERENCES credentials(id),image_id uuid REFERENCES image_credentials(id),language_id uuid REFERENCES language_channels(id),
 multiplier numeric(12,6) NOT NULL DEFAULT 1, budget_micro bigint NOT NULL DEFAULT 0,concurrency integer NOT NULL DEFAULT 5,
 deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_channel_versions (
 channel_id uuid NOT NULL REFERENCES provider_channels(id),version integer NOT NULL,base_url text NOT NULL,encrypted_key text NOT NULL,region text NOT NULL,
 PRIMARY KEY(channel_id,version)
);
ALTER TABLE model_channels DROP CONSTRAINT IF EXISTS model_channels_source_check;
ALTER TABLE model_channels ADD CONSTRAINT model_channels_source_check CHECK(source IN ('video','image','language','bailian'));
ALTER TABLE model_catalog DROP CONSTRAINT IF EXISTS model_catalog_type_check;
ALTER TABLE model_catalog ADD CONSTRAINT model_catalog_type_check CHECK(type IN ('video','image','language','speech','threed','world','realtime'));
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT '';
ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '{}';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS display_mode text NOT NULL DEFAULT 'banner' CHECK(display_mode IN ('banner','silent'));
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 0;

ALTER TABLE provider_channels ADD COLUMN IF NOT EXISTS creation_key text UNIQUE;

CREATE TABLE IF NOT EXISTS capability_jobs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),model text NOT NULL,protocol text NOT NULL,
 channel_id uuid NOT NULL REFERENCES provider_channels(id),channel_version integer NOT NULL,upstream_model text NOT NULL,
 project_id uuid REFERENCES projects(id),node_id text,request_key text NOT NULL,request_hash text NOT NULL,
 input jsonb NOT NULL,parameters jsonb NOT NULL DEFAULT '{}',price_snapshot jsonb NOT NULL,discount_multiplier numeric(10,6) NOT NULL,
 reserved_micro bigint NOT NULL,charged_micro bigint NOT NULL DEFAULT 0,settlement text NOT NULL DEFAULT 'reserved',
 status text NOT NULL DEFAULT 'QUEUED',upstream_id text,output jsonb NOT NULL DEFAULT '{}',usage jsonb NOT NULL DEFAULT '{}',error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),next_poll_at timestamptz,lease_until timestamptz,
 started_at timestamptz,completed_at timestamptz,socket_token_hash text,socket_token_expires timestamptz,
 UNIQUE(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS capability_jobs_worker ON capability_jobs(status,next_poll_at);
CREATE TABLE IF NOT EXISTS capability_files (
 id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES capability_jobs(id),user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL,kind text NOT NULL,mime text NOT NULL,object_key text NOT NULL,storage text NOT NULL,size bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days'
);
ALTER TABLE ledger ADD COLUMN IF NOT EXISTS capability_job_id uuid REFERENCES capability_jobs(id);

ALTER TABLE api_keys ALTER COLUMN models SET DEFAULT '["*"]'::jsonb;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_api_key_id_fkey;
ALTER TABLE tasks ADD CONSTRAINT tasks_api_key_id_fkey FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE image_tasks DROP CONSTRAINT IF EXISTS image_tasks_api_key_id_fkey;
ALTER TABLE image_tasks ADD CONSTRAINT image_tasks_api_key_id_fkey FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL;

-- Remove the credential while preserving historical task and billing records.
DELETE FROM api_keys WHERE revoked;
