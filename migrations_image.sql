-- 图片价格表
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

-- 图片生成渠道
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

-- 图片生成任务表
CREATE TABLE IF NOT EXISTS image_tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('text', 'image')),
  prompt TEXT NOT NULL,
  parameters JSONB NOT NULL,
  input_images TEXT, -- JSON 数组
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
  api_key_id UUID REFERENCES api_keys(id),
  workflow_run_id UUID,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING','SUCCEEDED','FAILED','CANCELED','CANCELING','UNKNOWN','RECONCILE','DELIVERY_FAILED')),
  settlement TEXT DEFAULT 'reserved' CHECK (settlement IN ('reserved','charged','canceled','refunded')),
  upstream_task_id TEXT,
  response JSONB,
  result_assets TEXT, -- JSON 数组
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
ALTER TABLE image_tasks DROP CONSTRAINT IF EXISTS image_tasks_settlement_check;
ALTER TABLE image_tasks ADD CONSTRAINT image_tasks_settlement_check
  CHECK (settlement IN ('reserved','charged','canceled','refunded','released'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_image_tasks_idempotency ON image_tasks(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_image_tasks_user ON image_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_tasks_project ON image_tasks(project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status) WHERE status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING');
CREATE INDEX IF NOT EXISTS idx_image_tasks_poll ON image_tasks(next_poll_at) WHERE status IN ('PENDING','RUNNING');
CREATE INDEX IF NOT EXISTS idx_image_tasks_workflow ON image_tasks(workflow_run_id) WHERE workflow_run_id IS NOT NULL;

-- 图片任务事件
CREATE TABLE IF NOT EXISTS image_task_events (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES image_tasks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_task_events_task ON image_task_events(task_id, created_at);

-- 插入初始价格数据
INSERT INTO image_prices (model, size_category, input_official_micro, input_sale_micro, output_official_micro, output_sale_micro, enabled)
VALUES
  ('qwen-image-3.0-pro', '1K', 20000, 20000, 250000, 250000, true),
  ('qwen-image-3.0-pro', '2K', 20000, 20000, 500000, 500000, true),
  ('qwen-image-3.0', '1K', 20000, 20000, 180000, 180000, true),
  ('qwen-image-3.0', '2K', 20000, 20000, 180000, 180000, true),
  ('gpt-image-2', '1K', 0, 0, 80000, 80000, true),
  ('gpt-image-2', '2K', 0, 0, 100000, 100000, true),
  ('gpt-image-2', '4K', 0, 0, 150000, 150000, true),
  ('gpt-image-2.5-flare', '1K', 0, 0, 100000, 100000, true),
  ('gpt-image-2.5-flare', '2K', 0, 0, 140000, 140000, true),
  ('gpt-image-2.5-flare', '4K', 0, 0, 200000, 200000, true),
  ('gpt-image-2.5-sunburst', '1K', 0, 0, 100000, 100000, true),
  ('gpt-image-2.5-sunburst', '2K', 0, 0, 140000, 140000, true),
  ('gpt-image-2.5-sunburst', '4K', 0, 0, 200000, 200000, true)
ON CONFLICT DO NOTHING;
