import { useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Video,
  Image as ImageIcon,
  AudioLines,
  MessageSquare,
  Box,
  Globe2,
  Waves,
  SlidersHorizontal,
  ArrowRight,
  Search,
} from "lucide-react";
import {
  useData,
  useAction,
  post,
  patch,
  api,
  money,
  Table,
  PageHead,
  Modal,
  QueryState,
  Badge,
  EditForm,
  type Row,
  type Field,
} from "./lib";
import {
  MODEL_TYPES,
  MODEL_TYPE_LABELS,
  type ModelType,
} from "../shared/catalog";
import {
  BAILIAN_MODEL_PRESETS,
  PROTOCOLS,
  PROTOCOL_IDS,
  protocolFor,
  type ProtocolId,
} from "../shared/protocols";
import { MODEL_IDS, RESOLUTIONS, OFFICIAL_PRICES } from "../shared/wan";
import {
  IMAGE_MODEL_IDS,
  IMAGE_OFFICIAL_PRICES,
  IMAGE_SIZE_CATEGORIES,
  MODEL_CAPABILITIES,
} from "../shared/image";

export const TYPE_ICONS = {
  video: Video,
  image: ImageIcon,
  language: MessageSquare,
  speech: AudioLines,
  threed: Box,
  world: Globe2,
  realtime: Waves,
};
export const BILLING_LABELS: Record<string, string> = {
  million_tokens: "百万 token",
  million_characters: "百万字符",
  second: "秒",
  request: "次",
};
function initialTiers(type: string, adapter: string) {
  if (type === "video")
    return Object.entries(OFFICIAL_PRICES[adapter] || {}).map(
      ([tier, price]) => ({
        tier,
        official: price,
        sale: price,
        enabled: true,
      }),
    );
  if (type === "image")
    return Object.entries(IMAGE_OFFICIAL_PRICES[adapter] || {}).map(
      ([tier, price]) => ({
        tier,
        input_official: price.input,
        input_sale: price.input,
        output_official: price.output,
        output_sale: price.output,
        enabled: true,
      }),
    );
  return [];
}
function blankModel(): Row {
  return {
    model: "",
    display_name: "",
    type: "video",
    description: "",
    adapter: MODEL_IDS[0],
    protocol: "bailian-video",
    capabilities: {},
    channels: [],
    enabled: true,
    input_price: 0,
    output_price: 0,
    billing_unit: "million_tokens",
    sort: 0,
    tiers: initialTiers("video", MODEL_IDS[0]),
  };
}
export function ModelManagement() {
  const query = useData<Row[]>("/admin/models");
  const channelsQuery = useData<Row[]>("/admin/channels");
  const action = useAction();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Row | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [pricing, setPricing] = useState<string | null>(null);
  const [tierEdit, setTierEdit] = useState<Row | null>(null);
  const models = query.data || [];
  const selected = models.find((m) => m.model === pricing);
  const shown = models.filter(
    (m) =>
      (filter === "all" || m.type === filter) &&
      `${m.display_name} ${m.model}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const source =
    edit?.type === "video"
      ? "video"
      : edit?.type === "image"
        ? "image"
        : "language";
  const activeProtocol = edit
    ? PROTOCOLS[
        (edit.protocol ||
          protocolFor(edit.type, edit.adapter, edit.model)) as ProtocolId
      ]
    : undefined;
  const compatibleChannels = (channelsQuery.data || []).filter((c) =>
    c.source === "bailian"
      ? activeProtocol?.provider !== "openai"
      : c.source === source &&
        (source !== "image" ||
          (c.provider === "bailian" ? "qwen" : "openai") ===
            MODEL_CAPABILITIES[edit?.adapter]?.provider),
  );
  const saveModel = () =>
    action.run(
      async () => {
        if (!edit) return;
        const body = {
          ...edit,
          display_name: edit.display_name.trim() || edit.model.trim(),
          tiers: isNew ? edit.tiers : undefined,
        };
        if (isNew) await post("/admin/models", body);
        else
          await patch(`/admin/models/${encodeURIComponent(edit.model)}`, body);
        setEdit(null);
      },
      isNew ? "新模型已加入广场" : "模型配置已保存",
    );
  const setProtocol = (protocol: ProtocolId, type = edit?.type) => {
    if (!edit) return;
    const profile = PROTOCOLS[protocol];
    setEdit({
      ...edit,
      type,
      protocol,
      adapter: profile.adapter,
      channels: [],
      tiers: initialTiers(type, profile.adapter),
      billing_unit: profile.unit,
    });
  };
  const chooseType = (type: ModelType) => {
    const protocol = PROTOCOL_IDS.find((id) =>
      (PROTOCOLS[id].types as readonly string[]).includes(type),
    )!;
    setProtocol(protocol, type);
  };
  const tierFields: Field[] =
    selected?.type === "image"
      ? [
          {
            key: "input_official",
            label: "输入原价（元 / 张）",
            type: "number",
            min: 0,
            required: true,
          },
          {
            key: "input_sale",
            label: "输入售价（元 / 张）",
            type: "number",
            min: 0,
            required: true,
          },
          {
            key: "output_official",
            label: "输出原价（元 / 张）",
            type: "number",
            min: 0.000001,
            required: true,
          },
          {
            key: "output_sale",
            label: "输出售价（元 / 张）",
            type: "number",
            min: 0.000001,
            required: true,
          },
          { key: "enabled", label: "启用该档", type: "checkbox" },
        ]
      : [
          {
            key: "official",
            label: "官方原价（元 / 秒）",
            type: "number",
            min: 0.000001,
            required: true,
          },
          {
            key: "sale",
            label: "站内售价（元 / 秒）",
            type: "number",
            min: 0.000001,
            required: true,
          },
          { key: "enabled", label: "启用该档", type: "checkbox" },
        ];
  const missingTiers = selected
    ? (selected.type === "video"
        ? [...RESOLUTIONS]
        : IMAGE_SIZE_CATEGORIES.filter(
            (s, i) =>
              i <=
              IMAGE_SIZE_CATEGORIES.indexOf(
                MODEL_CAPABILITIES[selected.model]?.maxSize || "4K",
              ),
          )
      ).filter((tier) => !selected.prices.some((p: Row) => p.tier === tier))
    : [];
  return (
    <>
      <PageHead
        title="模型定价"
        subtitle="模型、渠道、价格，在此统一编排"
        actions={
          <div className="actions">
            <select
              aria-label="百炼模型预设"
              value=""
              onChange={(e) => {
                const preset = BAILIAN_MODEL_PRESETS.find(
                  (p) => p.model === e.target.value,
                );
                if (!preset) return;
                const profile = PROTOCOLS[preset.protocol];
                setIsNew(true);
                setEdit({
                  ...blankModel(),
                  model: preset.model,
                  display_name: preset.label,
                  type: preset.type,
                  protocol: preset.protocol,
                  adapter: profile.adapter,
                  billing_unit: profile.unit,
                  tiers: initialTiers(preset.type, profile.adapter),
                });
              }}
            >
              <option value="">百炼能力预设…</option>
              {BAILIAN_MODEL_PRESETS.map((p) => (
                <option value={p.model} key={p.model}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              className="primary"
              onClick={() => {
                setIsNew(true);
                setEdit(blankModel());
              }}
            >
              <Plus size={17} />
              添加模型
            </button>
          </div>
        }
      />
      <div className="catalog-admin-toolbar">
        <div
          className="segmented-tabs"
          role="tablist"
          aria-label="定价模型类型"
        >
          {["all", ...MODEL_TYPES].map((type) => (
            <button
              key={type}
              role="tab"
              aria-selected={filter === type}
              className={filter === type ? "active" : ""}
              onClick={() => setFilter(type)}
            >
              {type === "all"
                ? "全部模型"
                : MODEL_TYPE_LABELS[type as ModelType]}
              <span>
                {models.filter((m) => type === "all" || m.type === type).length}
              </span>
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索定价模型"
            placeholder="搜索模型名称或 ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <QueryState query={query}>
        <Table
          rows={shown}
          filename="模型目录与定价"
          columns={[
            {
              key: "display_name",
              title: "模型",
              render: (row: Row) => {
                const Icon = TYPE_ICONS[row.type as ModelType];
                return (
                  <div className="model-name-cell">
                    <span className={`type-tile ${row.type}`}>
                      <Icon size={19} />
                    </span>
                    <div>
                      <strong>{row.display_name}</strong>
                      <small>{row.model}</small>
                    </div>
                  </div>
                );
              },
            },
            {
              key: "type",
              title: "类型",
              render: (row: Row) => (
                <Badge>{MODEL_TYPE_LABELS[row.type as ModelType]}</Badge>
              ),
            },
            {
              key: "channels",
              title: "关联渠道",
              render: (row: Row) =>
                row.channels.length ? (
                  <span className="channel-model-list">
                    {row.channels.map((c: Row) => c.name).join("、")}
                  </span>
                ) : (
                  <span className="muted">待关联渠道</span>
                ),
            },
            {
              key: "prices",
              title: "计费",
              render: (row: Row) =>
                row.type === "video"
                  ? `${row.prices.length} 个分辨率 / 秒`
                  : row.type === "image"
                    ? `${row.prices.length} 个尺寸 / 张`
                    : `输入 ${money(row.input_price)} · 输出 ${money(row.output_price)} / ${BILLING_LABELS[row.billing_unit]}`,
            },
            {
              key: "enabled",
              title: "状态",
              render: (row: Row) => (
                <Badge tone={row.enabled ? "teal" : "neutral"}>
                  {row.enabled ? "已发布" : "停用"}
                </Badge>
              ),
            },
            {
              key: "actions",
              title: "管理",
              render: (row: Row) => (
                <div className="actions">
                  <button
                    onClick={() => {
                      setIsNew(false);
                      setEdit({
                        ...row,
                        protocol:
                          row.protocol ||
                          protocolFor(row.type, row.adapter, row.model),
                        channels: row.channels.map((c: Row) => ({
                          id: c.id,
                          source: c.source,
                          upstream_model: c.upstream_model || row.model,
                        })),
                      });
                    }}
                  >
                    <Pencil size={14} />
                    编辑模型
                  </button>
                  {["video", "image"].includes(row.type) && (
                    <button onClick={() => setPricing(row.model)}>
                      <SlidersHorizontal size={14} />
                      管理价格
                    </button>
                  )}
                  <button
                    disabled={action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除模型 ${row.display_name} 及其当前价格？历史任务将保留。`,
                        )
                      )
                        void action.run(
                          () =>
                            api(
                              `/admin/models/${encodeURIComponent(row.model)}`,
                              { method: "DELETE" },
                            ),
                          "模型已删除",
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
      <Modal
        title={isNew ? "添加模型" : "编辑模型"}
        open={!!edit}
        onClose={() => setEdit(null)}
        wide
      >
        {edit && (
          <form
            className="form-stack model-admin-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveModel();
            }}
          >
            <div className="model-type-choices">
              {MODEL_TYPES.map((type) => {
                const Icon = TYPE_ICONS[type];
                return (
                  <button
                    type="button"
                    key={type}
                    disabled={!isNew && edit.type !== type}
                    className={edit.type === type ? "selected" : ""}
                    aria-pressed={edit.type === type}
                    onClick={() => chooseType(type)}
                  >
                    <Icon size={21} />
                    {MODEL_TYPE_LABELS[type]}模型
                  </button>
                );
              })}
            </div>
            <div className="two-fields">
              <label className="field">
                模型 ID
                <input
                  aria-label="模型 ID"
                  required
                  disabled={!isNew}
                  value={edit.model}
                  placeholder={
                    edit.type === "language"
                      ? "例如 my-chat-model"
                      : "输入模型唯一标识"
                  }
                  pattern="[a-zA-Z0-9][a-zA-Z0-9._:/-]*"
                  maxLength={150}
                  onChange={(e) => setEdit({ ...edit, model: e.target.value })}
                />
              </label>
              <label className="field">
                显示名称
                <input
                  aria-label="模型显示名称"
                  value={edit.display_name}
                  placeholder="留空使用模型 ID"
                  maxLength={120}
                  onChange={(e) =>
                    setEdit({ ...edit, display_name: e.target.value })
                  }
                />
              </label>
            </div>
            <label className="field">
              兼容接入协议
              <select
                aria-label="兼容接入协议"
                disabled={!isNew}
                value={
                  edit.protocol ||
                  protocolFor(edit.type, edit.adapter, edit.model)
                }
                onChange={(e) => setProtocol(e.target.value as ProtocolId)}
              >
                {PROTOCOL_IDS.filter((id) =>
                  (PROTOCOLS[id].types as readonly string[]).includes(
                    edit.type,
                  ),
                ).map((id) => (
                  <option key={id} value={id}>
                    {PROTOCOLS[id].label}
                  </option>
                ))}
              </select>
              <small>
                同一家族共享请求协议，例如 GPT Image 各版本均选择 OpenAI
                图片。具体上游模型名称与能力由模型配置决定。
              </small>
            </label>
            {edit.type === "image" && (
              <details>
                <summary>模型能力（与协议独立，按具体模型文档配置）</summary>
                <div className="two-fields">
                  <label className="field">
                    最多参考图
                    <input
                      aria-label="模型最多参考图"
                      type="number"
                      min={0}
                      max={16}
                      value={
                        edit.capabilities?.maxImages ??
                        MODEL_CAPABILITIES[edit.adapter]?.maxImages ??
                        3
                      }
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          capabilities: {
                            ...edit.capabilities,
                            maxImages: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    单次最多生成张数
                    <input
                      aria-label="模型最多生成张数"
                      type="number"
                      min={1}
                      max={6}
                      value={
                        edit.capabilities?.maxN ??
                        MODEL_CAPABILITIES[edit.adapter]?.maxN ??
                        1
                      }
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          capabilities: {
                            ...edit.capabilities,
                            maxN: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                </div>
              </details>
            )}
            <label className="field">
              模型说明
              <textarea
                aria-label="模型说明"
                rows={2}
                maxLength={2000}
                value={edit.description}
                onChange={(e) =>
                  setEdit({ ...edit, description: e.target.value })
                }
              />
            </label>
            <fieldset className="channel-model-picker">
              <legend>关联渠道与上游映射</legend>
              {compatibleChannels.length ? (
                compatibleChannels.map((channel) => {
                  const link = edit.channels.find(
                    (c: Row) => c.id === channel.id,
                  );
                  return (
                    <div className="mapping-row" key={channel.id}>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={!!link}
                          onChange={(e) =>
                            setEdit({
                              ...edit,
                              channels: e.target.checked
                                ? [
                                    ...edit.channels,
                                    {
                                      id: channel.id,
                                      source: channel.source,
                                      upstream_model:
                                        channel.model_mapping?.[edit.model] ||
                                        edit.model,
                                    },
                                  ]
                                : edit.channels.filter(
                                    (c: Row) => c.id !== channel.id,
                                  ),
                            })
                          }
                        />
                        <span>
                          {channel.name}
                          {!channel.enabled ? "（已停用）" : ""}
                        </span>
                      </label>
                      <ArrowRight size={14} />
                      {link && (
                        <input
                          aria-label={`${channel.name} 上游模型 ID`}
                          required
                          value={link.upstream_model}
                          placeholder={edit.model || "实际请求的模型 ID"}
                          onChange={(e) =>
                            setEdit({
                              ...edit,
                              channels: edit.channels.map((c: Row) =>
                                c.id === channel.id
                                  ? { ...c, upstream_model: e.target.value }
                                  : c,
                              ),
                            })
                          }
                        />
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="muted">
                  尚无匹配的渠道，请先在渠道管理中添加。你也可以先保存模型，稍后关联。
                </p>
              )}
            </fieldset>
            {!["video", "image"].includes(edit.type) && (
              <>
                <div className="form-section-title">本站售价</div>
                {edit.type !== "language" && (
                  <label className="field">
                    计费单位
                    <select
                      aria-label="语音计费单位"
                      value={edit.billing_unit}
                      onChange={(e) =>
                        setEdit({ ...edit, billing_unit: e.target.value })
                      }
                    >
                      {Object.entries(BILLING_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="two-fields">
                  <label className="field">
                    输入价（元 / {BILLING_LABELS[edit.billing_unit]}）
                    <input
                      aria-label="模型输入价"
                      type="number"
                      min={0}
                      max={1000000}
                      step="any"
                      required
                      value={edit.input_price}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          input_price: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    输出价（元 / {BILLING_LABELS[edit.billing_unit]}）
                    <input
                      aria-label="模型输出价"
                      type="number"
                      min={0}
                      max={1000000}
                      step="any"
                      required
                      value={edit.output_price}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          output_price: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
              </>
            )}
            {isNew && edit.tiers?.length > 0 && (
              <fieldset className="initial-prices">
                <legend>
                  初始价格 · 元 / {edit.type === "video" ? "秒" : "张"}
                </legend>
                <div className="initial-prices-grid">
                  {edit.tiers.map((tier: Row, index: number) => (
                    <div className="initial-price-row" key={tier.tier}>
                      <strong>{tier.tier}</strong>
                      {(edit.type === "video"
                        ? [
                            ["official", "原价"],
                            ["sale", "售价"],
                          ]
                        : [
                            ["input_official", "输入原价"],
                            ["input_sale", "输入售价"],
                            ["output_official", "输出原价"],
                            ["output_sale", "输出售价"],
                          ]
                      ).map(([key, label]) => (
                        <label className="field" key={key}>
                          {label}
                          <input
                            type="number"
                            aria-label={`${tier.tier} ${label}`}
                            min={key.startsWith("input") ? 0 : 0.000001}
                            max={1000}
                            step="any"
                            required
                            value={tier[key]}
                            onChange={(e) =>
                              setEdit({
                                ...edit,
                                tiers: edit.tiers.map((t: Row, i: number) =>
                                  i === index
                                    ? { ...t, [key]: Number(e.target.value) }
                                    : t,
                                ),
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="two-fields">
              <label className="field">
                排序（数字越小越靠前）
                <input
                  aria-label="模型排序"
                  type="number"
                  min={-10000}
                  max={10000}
                  step={1}
                  value={edit.sort}
                  onChange={(e) =>
                    setEdit({ ...edit, sort: Number(e.target.value) })
                  }
                />
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={(e) =>
                    setEdit({ ...edit, enabled: e.target.checked })
                  }
                />
                <span>发布模型</span>
              </label>
            </div>
            <div className="modal-actions">
              <small className="muted">发布后将显示在用户模型广场</small>
              <button className="primary" disabled={action.busy}>
                {action.busy
                  ? "保存中…"
                  : isNew
                    ? "添加并发布模型"
                    : "保存模型"}
              </button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        title={`管理价格 · ${selected?.display_name || ""}`}
        open={!!selected}
        onClose={() => {
          setPricing(null);
          setTierEdit(null);
        }}
        wide
      >
        {selected && (
          <>
            <div className="actions">
              {missingTiers.length > 0 && (
                <button
                  className="primary"
                  onClick={() =>
                    setTierEdit({
                      tier: missingTiers[0],
                      model: selected.model,
                      official: 1,
                      sale: 1,
                      input_official: 0,
                      input_sale: 0,
                      output_official: 0.1,
                      output_sale: 0.1,
                      enabled: true,
                    })
                  }
                >
                  <Plus size={15} />
                  添加价格档位
                </button>
              )}
              <span className="muted">
                {selected.type === "video"
                  ? "按秒计费"
                  : "输入图和输出图分别按张计费"}
              </span>
            </div>
            <Table
              rows={selected.prices}
              columns={[
                {
                  key: "tier",
                  title: selected.type === "video" ? "分辨率" : "尺寸",
                },
                ...(selected.type === "video"
                  ? [
                      {
                        key: "official",
                        title: "官方原价 / 秒",
                        render: (r: Row) => money(r.official),
                      },
                      {
                        key: "sale",
                        title: "站内售价 / 秒",
                        render: (r: Row) => money(r.base_sale),
                      },
                    ]
                  : [
                      {
                        key: "input_sale",
                        title: "输入售价 / 张",
                        render: (r: Row) => money(r.base_input),
                      },
                      {
                        key: "output_sale",
                        title: "输出售价 / 张",
                        render: (r: Row) => money(r.base_output),
                      },
                    ]),
                {
                  key: "enabled",
                  title: "状态",
                  render: (r: Row) => (
                    <Badge>{r.enabled ? "启用" : "停用"}</Badge>
                  ),
                },
                {
                  key: "action",
                  title: "操作",
                  render: (r: Row) => (
                    <div className="actions">
                      <button
                        onClick={() =>
                          setTierEdit({
                            ...r,
                            model: selected.model,
                            input_sale: r.base_input,
                            output_sale: r.base_output,
                            sale: r.base_sale,
                          })
                        }
                      >
                        <Pencil size={14} />
                        修改
                      </button>
                      <button
                        onClick={() => {
                          if (
                            window.confirm(
                              `删除 ${selected.model} ${r.tier} 的定价？`,
                            )
                          )
                            void action.run(
                              () =>
                                api(
                                  `/admin/${selected.type === "video" ? "prices" : "image-prices"}/${r.id}`,
                                  { method: "DELETE" },
                                ),
                              "价格档位已删除",
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
            {tierEdit && (
              <div className="tier-edit-panel">
                <h3>
                  {tierEdit.id ? "修改" : "添加"} {tierEdit.tier} 档位
                </h3>
                <EditForm
                  key={tierEdit.id || "new"}
                  initial={tierEdit}
                  busy={action.busy}
                  fields={[
                    ...(!tierEdit.id
                      ? [
                          {
                            key: "tier",
                            label: "未配置模型档位",
                            options: missingTiers.map(
                              (t) => [t, t] as [string, string],
                            ),
                          },
                        ]
                      : []),
                    ...tierFields,
                  ]}
                  preview={(v) => (
                    <div className="notice" role="status">
                      {selected.type === "video"
                        ? `站内价 ${money(v.sale)} / 秒 · 5 秒 ${money(Number(v.sale) * 5)}`
                        : `输入 ${money(v.input_sale)} / 张 · 输出 10 张 ${money(Number(v.output_sale) * 10)}`}
                    </div>
                  )}
                  onSubmit={(value) =>
                    action.run(async () => {
                      const endpoint = `/admin/${selected.type === "video" ? "prices" : "image-prices"}`;
                      const body =
                        selected.type === "video"
                          ? {
                              official: value.official,
                              sale: value.sale,
                              enabled: value.enabled,
                              ...(!tierEdit.id
                                ? {
                                    model: selected.model,
                                    resolution: value.tier,
                                  }
                                : {}),
                            }
                          : {
                              input_official: value.input_official,
                              input_sale: value.input_sale,
                              output_official: value.output_official,
                              output_sale: value.output_sale,
                              enabled: value.enabled,
                              ...(!tierEdit.id
                                ? {
                                    model: selected.model,
                                    size_category: value.tier,
                                  }
                                : {}),
                            };
                      if (tierEdit.id)
                        await patch(`${endpoint}/${tierEdit.id}`, body);
                      else await post(endpoint, body);
                      setTierEdit(null);
                    }, "价格已保存")
                  }
                />
                <button onClick={() => setTierEdit(null)}>取消编辑</button>
              </div>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
