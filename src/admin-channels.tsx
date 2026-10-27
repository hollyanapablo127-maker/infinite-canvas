import { useState, useRef, useEffect } from "react";
import {
  Image as ImageIcon,
  Server,
  MessageSquare,
  Plus,
  Pencil,
  Trash2,
  Radio,
  RefreshCw,
  Search,
  Check,
  ChevronRight,
} from "lucide-react";
import {
  api,
  post,
  patch,
  useData,
  useAction,
  Table,
  PageHead,
  Badge,
  Modal,
  QueryState,
  type Row,
  streamPost,
} from "./lib";
import { LanguageChannelDialog } from "./language-channel";
import {
  BAILIAN_MODEL_PRESETS,
  BAILIAN_REGIONS,
  bailianHost,
  chatBase,
} from "../shared/protocols";
import { MODEL_TYPE_LABELS, type ModelType } from "../shared/catalog";
import { MODEL_IDS } from "../shared/wan";
import { IMAGE_MODEL_IDS } from "../shared/image";
const defaults = (provider = "bailian"): Row => ({
  provider,
  name: "",
  workspace: "",
  region: "cn-beijing",
  baseUrl: "",
  key: "",
  models:
    provider === "bailian"
      ? [
          ...MODEL_IDS,
          ...IMAGE_MODEL_IDS.filter((id) => id.startsWith("qwen-")),
          "qwen-plus",
        ]
      : IMAGE_MODEL_IDS.filter((id) => id.startsWith("gpt-")),
  model_mapping: {},
  priority: 0,
  enabled: true,
  multiplier: 1,
  budget: 0,
  concurrency: 5,
  request_key: crypto.randomUUID(),
});
export function ChannelManagement() {
  const query = useData<Row[]>("/admin/channels"),
    action = useAction();
  const [picker, setPicker] = useState(false),
    [edit, setEdit] = useState<Row | null>(null),
    [language, setLanguage] = useState<Row | null>(null);
  const [search, setSearch] = useState("");
  return (
    <>
      <PageHead
        title="渠道管理"
        subtitle="一个连接，多种能力。统一管理上游、模型与映射。"
        actions={
          <button className="primary" onClick={() => setPicker(true)}>
            <Plus size={16} />
            添加渠道
          </button>
        }
      />
      <div className="channel-page-summary">
        <Server size={18} />
        <span>
          百炼渠道统一连接文本、图像、视频、音频、3D、世界与实时能力；密钥保存在服务端，历史任务使用提交时的凭据快照。
        </span>
      </div>
      <label className="search-field">
        <Search size={16} />
        <input
          aria-label="搜索渠道"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索渠道名称、模型"
        />
      </label>
      <QueryState query={query}>
        <Table
          rows={(query.data || []).filter((c) =>
            `${c.name} ${c.models?.join(" ")}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )}
          filename="渠道管理"
          columns={[
            {
              key: "name",
              title: "渠道",
              render: (c: Row) => (
                <div className="model-name-cell">
                  <span
                    className={`type-tile ${c.source === "language" ? "language" : "video"}`}
                  >
                    {c.source === "language" ? (
                      <MessageSquare size={18} />
                    ) : c.provider === "bailian" ? (
                      <Server size={18} />
                    ) : (
                      <ImageIcon size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <small>
                      {c.provider === "bailian"
                        ? "阿里云百炼"
                        : c.source === "language"
                          ? "OpenAI 语言"
                          : "OpenAI 图片"}{" "}
                      {c.region ? `· ${c.region}` : ""}
                    </small>
                  </div>
                </div>
              ),
            },
            {
              key: "models",
              title: "支持模型",
              render: (c: Row) => (
                <span
                  className="channel-model-list"
                  title={c.models?.join("、")}
                >
                  {c.models?.length
                    ? `${c.models.slice(0, 4).join("、")}${c.models.length > 4 ? ` 等 ${c.models.length} 个` : ""}`
                    : "由模型定价关联"}
                </span>
              ),
            },
            {
              key: "endpoint",
              title: "API 地址",
              render: (c: Row) => (
                <code className="channel-endpoint">
                  {c.base_url || c.workspace}
                </code>
              ),
            },
            { key: "priority", title: "优先级" },
            {
              key: "enabled",
              title: "状态",
              render: (c: Row) => (
                <Badge tone={c.enabled ? "teal" : "red"}>
                  {c.enabled ? "启用" : "停用"}
                </Badge>
              ),
            },
            {
              key: "action",
              title: "操作",
              render: (c: Row) => (
                <div className="actions">
                  <button
                    onClick={() =>
                      c.source === "language"
                        ? setLanguage(c)
                        : setEdit({
                            ...defaults(c.provider),
                            ...c,
                            baseUrl: c.base_url,
                            key: "",
                            budget: Number(c.budget_micro || 0) / 1e6,
                            multiplier: Number(c.multiplier ?? 1),
                          })
                    }
                  >
                    <Pencil size={14} />
                    编辑
                  </button>
                  {c.source === "language" && (
                    <button onClick={() => setLanguage(c)}>
                      <Radio size={14} />
                      测试连接
                    </button>
                  )}
                  <button
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除渠道「${c.name}」？尚未提交的排队任务将取消并退回预算，已提交任务继续查询，历史记录保留。`,
                        )
                      )
                        void action.run(
                          () =>
                            api(
                              c.source === "language"
                                ? `/admin/language-channels/${c.id}`
                                : `/admin/channels/${c.id}`,
                              { method: "DELETE" },
                            ),
                          "渠道已删除",
                        );
                    }}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
              ),
            },
          ]}
        />
      </QueryState>
      <Modal title="添加渠道" open={picker} onClose={() => setPicker(false)}>
        <div className="channel-provider-grid">
          <button
            className="channel-provider-choice"
            onClick={() => {
              setPicker(false);
              setEdit(defaults());
            }}
          >
            <Server size={22} />
            <strong>百炼 API</strong>
            <span>文本 · 图像 · 视频 · 音频 · 3D · 世界 · 实时</span>
          </button>
          <button
            className="channel-provider-choice"
            onClick={() => {
              setPicker(false);
              setEdit(defaults("openai"));
            }}
          >
            <ImageIcon size={22} />
            <strong>OpenAI</strong>
            <span>GPT Image 家族图片生成与编辑</span>
          </button>
          <button
            className="channel-provider-choice"
            onClick={() => {
              setPicker(false);
              setLanguage({});
            }}
          >
            <MessageSquare size={22} />
            <strong>语言</strong>
            <span>OpenAI 兼容流式语言模型</span>
          </button>
        </div>
      </Modal>
      {edit && <ChannelEditor initial={edit} onClose={() => setEdit(null)} />}
      {language && (
        <LanguageChannelDialog
          initial={language}
          onClose={() => setLanguage(null)}
        />
      )}
    </>
  );
}
function ChannelEditor({
  initial,
  onClose,
}: {
  initial: Row;
  onClose: () => void;
}) {
  const [form, setForm] = useState(initial),
    [custom, setCustom] = useState("");
  const [error, setError] = useState(""),
    [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const action = useAction(),
    saving = useRef(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const [testModel, setTestModel] = useState("qwen-plus"),
    [testOutput, setTestOutput] = useState(""),
    [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState("Hi");
  const isBailian = form.provider === "bailian";
  const effectiveBase =
    form.baseUrl || (isBailian ? bailianHost(form.workspace, form.region) : "");
  const models = Array.from(
    new Set([
      ...(isBailian
        ? [
            ...MODEL_IDS,
            ...IMAGE_MODEL_IDS.filter((m) => m.startsWith("qwen-")),
            ...BAILIAN_MODEL_PRESETS.map((m) => m.model),
          ]
        : IMAGE_MODEL_IDS.filter((m) => m.startsWith("gpt-"))),
      ...form.models,
      ...discovered,
    ]),
  );
  const update = (value: Row) => setForm({ ...form, ...value });
  const discover = async () => {
    setError("");
    setDiscovering(true);
    try {
      const result = await post("/admin/language-channels/discover", {
        baseUrl: isBailian ? chatBase(effectiveBase) : effectiveBase,
        key: form.key || undefined,
        provider_channel_id: form.id,
      });
      setDiscovered(result.models);
      update({
        models: Array.from(new Set([...form.models, ...result.models])),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取模型失败");
    } finally {
      setDiscovering(false);
    }
  };
  const test = async () => {
    const active = new AbortController();
    controller.current = active;
    setTesting(true);
    setError("");
    setTestOutput("");
    try {
      await streamPost(
        "/admin/language-channels/test",
        {
          baseUrl: chatBase(effectiveBase),
          key: form.key || undefined,
          provider_channel_id: form.id,
          model: testModel,
          upstream_model: form.model_mapping[testModel] || testModel,
          prompt: testMessage,
          reasoning: "auto",
        },
        (type, data) => {
          if (type === "delta") setTestOutput((t) => t + data.text);
        },
        active.signal,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };
  return (
    <Modal
      title={form.id ? "编辑渠道" : "添加渠道"}
      open
      onClose={onClose}
      wide
    >
      <form
        className="form-stack language-channel-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (saving.current) return;
          saving.current = true;
          void action
            .run(async () => {
              if (form.id)
                await patch(`/admin/channels/${form.id}`, {
                  ...form,
                  key: form.key || undefined,
                });
              else await post("/admin/channels", form);
              onClose();
            }, "渠道已保存")
            .finally(() => {
              saving.current = false;
            });
        }}
      >
        <div className="form-section-title">
          <Server size={17} />
          <span>
            {isBailian ? "百炼 API · 一个连接覆盖所有能力" : "OpenAI 图片接口"}
          </span>
          <Badge>{form.models.length} 个模型</Badge>
        </div>
        <label className="field">
          渠道名称
          <input
            aria-label="渠道名称"
            required
            maxLength={100}
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </label>
        {isBailian && (
          <div className="two-fields">
            <label className="field">
              地域
              <select
                aria-label="百炼地域"
                value={form.region}
                onChange={(e) =>
                  update({ region: e.target.value, baseUrl: "" })
                }
              >
                {BAILIAN_REGIONS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Workspace ID
              <input
                aria-label="Workspace ID"
                placeholder="推荐填写，启用业务空间专属域名"
                value={form.workspace}
                onChange={(e) =>
                  update({ workspace: e.target.value, baseUrl: "" })
                }
              />
            </label>
          </div>
        )}
        <div className="two-fields">
          <label className="field">
            API Base URL
            <input
              aria-label="API Base URL"
              type="url"
              required={!isBailian}
              placeholder={effectiveBase || "https://api.example.com/v1"}
              value={form.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
            {isBailian && (
              <small>{effectiveBase} · API Key 必须与地域一致</small>
            )}
          </label>
          <label className="field">
            {isBailian ? "百炼 API Key" : "API Key"}
            {form.id ? "（留空保留）" : ""}
            <input
              aria-label={isBailian ? "百炼 API Key" : "API Key"}
              type="password"
              autoComplete="new-password"
              required={!form.id}
              value={form.key}
              onChange={(e) => update({ key: e.target.value })}
            />
          </label>
        </div>
        <div className="form-section-title">
          <span>支持模型与映射</span>
          <button
            type="button"
            disabled={discovering || (!form.key && !form.id)}
            onClick={() => void discover()}
          >
            <RefreshCw size={15} className={discovering ? "spin" : ""} />
            {discovering ? "获取中…" : "自动获取模型"}
          </button>
        </div>
        <div className="inline-add">
          <input
            aria-label="自定义渠道模型"
            placeholder="输入模型 ID，自定义支持的模型"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            disabled={!custom.trim()}
            onClick={() => {
              update({
                models: Array.from(new Set([...form.models, custom.trim()])),
              });
              setCustom("");
            }}
          >
            <Plus size={15} />
            添加模型
          </button>
        </div>
        <div className="mapping-list">
          {models.map((model) => {
            const preset = BAILIAN_MODEL_PRESETS.find((m) => m.model === model);
            return (
              <div key={model} className="mapping-row">
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={form.models.includes(model)}
                    onChange={(e) =>
                      update({
                        models: e.target.checked
                          ? [...form.models, model]
                          : form.models.filter((m: string) => m !== model),
                      })
                    }
                  />
                  <span title={model}>
                    {model}
                    {preset
                      ? ` · ${MODEL_TYPE_LABELS[preset.type as ModelType]}`
                      : ""}
                  </span>
                </label>
                <ChevronRight size={13} />
                <input
                  aria-label={`${model} 上游映射`}
                  placeholder="上游模型 ID（默认相同）"
                  value={form.model_mapping[model] || ""}
                  onChange={(e) => {
                    const map = { ...form.model_mapping };
                    if (e.target.value.trim())
                      map[model] = e.target.value.trim();
                    else delete map[model];
                    update({ model_mapping: map });
                  }}
                />
              </div>
            );
          })}
        </div>
        <small className="muted">
          模型需在“模型定价”中发布并选择相应协议。选中支持模型不会自动添加付费价格。
        </small>
        <div className="two-fields">
          <label className="field">
            调度优先级
            <input
              type="number"
              aria-label="调度优先级"
              min={-100}
              max={100}
              value={form.priority}
              onChange={(e) => update({ priority: Number(e.target.value) })}
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            启用渠道
          </label>
        </div>
        {isBailian && (
          <details>
            <summary>成本与并发设置</summary>
            <div className="two-fields">
              <label className="field">
                成本倍率
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={form.multiplier}
                  onChange={(e) =>
                    update({ multiplier: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                累计预算（元，0 不限）
                <input
                  type="number"
                  min={0}
                  value={form.budget}
                  onChange={(e) => update({ budget: Number(e.target.value) })}
                />
              </label>
            </div>
          </details>
        )}
        {isBailian && (
          <details className="channel-test">
            <summary>真实文本流式连接测试</summary>
            <div className="two-fields">
              <label className="field">
                测试模型
                <input
                  aria-label="百炼测试模型"
                  value={testModel}
                  onChange={(e) => setTestModel(e.target.value)}
                />
              </label>
              <label className="field">
                测试消息
                <input
                  aria-label="百炼测试消息"
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                />
              </label>
            </div>
            <button
              type="button"
              disabled={testing || !testModel || (!form.id && !form.key)}
              onClick={() => void test()}
            >
              <Radio size={15} />
              {testing ? "接收中…" : "测试连接"}
            </button>
            {testing && (
              <button type="button" onClick={() => controller.current?.abort()}>
                停止测试
              </button>
            )}
            <small>
              真实请求可能产生上游费用。各能力可在工作台中分别验证。
            </small>
            {testOutput && <pre className="pre-wrap">{testOutput}</pre>}
          </details>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="muted">
            {isBailian ? "一个百炼连接只显示一条渠道记录" : "API Key 加密保存"}
          </span>
          <button
            className="primary"
            disabled={action.busy || !form.models.length || testing}
          >
            <Check size={16} />
            {action.busy ? "保存中…" : form.id ? "保存渠道" : "添加渠道"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
