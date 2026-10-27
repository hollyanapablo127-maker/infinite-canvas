import { useState, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Search,
  ArrowUpRight,
  ArrowRight,
  Sparkles,
  SlidersHorizontal,
  X,
  Check,
  Layers,
  ChevronRight,
} from "lucide-react";
import {
  useData,
  useAction,
  post,
  money,
  uid,
  QueryState,
  Modal,
  Badge,
  Empty,
  type Row,
} from "./lib";
import {
  MODEL_TYPES,
  MODEL_TYPE_LABELS,
  type ModelType,
} from "../shared/catalog";
import { DEFAULT_PARAMETERS } from "../shared/wan";
import {
  DEFAULT_IMAGE_PARAMETERS,
  getSizeCategory,
  SIZE_PRESETS,
} from "../shared/image";
import { TYPE_ICONS, BILLING_LABELS } from "./model-admin";
import { newGenerationPair } from "./pages";
import { WORKBENCH_ENABLED } from "./capability-workbench";

export function ModelMarket() {
  const query = useData<Row>("/models");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const action = useAction();
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 12;
  const models: Row[] = query.data?.catalog || [];
  const multiplier = Number(query.data?.multiplier ?? 1);
  const type = params.get("type") || "all",
    channel = params.get("channel") || "all",
    search = params.get("q") || "",
    selected = params.get("model");
  const change = (key: string, value: string) => {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        if (value && value !== "all") next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: key === "q" },
    );
    setPage(1);
  };
  const channels: Row[] = useMemo(
    () =>
      Array.from(
        new Map<string, Row>(
          models.flatMap((model) =>
            model.channels.map((c: Row) => [c.id, c] as [string, Row]),
          ),
        ).values(),
      ),
    [models],
  );
  const filtered = models.filter(
    (model) =>
      (type === "all" || model.type === type) &&
      (channel === "all" ||
        (channel === "unassigned"
          ? model.channels.length === 0
          : model.channels.some((c: Row) => c.id === channel))) &&
      `${model.display_name} ${model.model} ${model.description}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const model = models.find((model) => model.model === selected);
  const filterPanel = (
    <>
      <div className="filter-title">
        <SlidersHorizontal size={16} />
        <span>探索模型</span>
        <small>{models.length}</small>
      </div>
      <div className="filter-group">
        <p>模型类型</p>
        <button
          className={type === "all" ? "selected" : ""}
          onClick={() => change("type", "all")}
        >
          <Layers size={17} />
          <span>全部模型</span>
          <small>{models.length}</small>
        </button>
        {MODEL_TYPES.map((kind) => {
          const Icon = TYPE_ICONS[kind];
          return (
            <button
              className={type === kind ? "selected" : ""}
              key={kind}
              onClick={() => change("type", kind)}
            >
              <Icon size={17} />
              <span>{MODEL_TYPE_LABELS[kind]}模型</span>
              <small>{models.filter((m) => m.type === kind).length}</small>
            </button>
          );
        })}
      </div>
      <div className="filter-group">
        <p>提供渠道</p>
        <button
          className={channel === "all" ? "selected" : ""}
          onClick={() => change("channel", "all")}
        >
          <span className="channel-dot all" />
          <span>所有渠道</span>
          <small>{models.length}</small>
        </button>
        {channels.map((c) => (
          <button
            className={channel === c.id ? "selected" : ""}
            key={c.id}
            onClick={() => change("channel", c.id)}
          >
            <span className="channel-dot" />
            <span>{c.name}</span>
            <small>
              {
                models.filter((m) => m.channels.some((x: Row) => x.id === c.id))
                  .length
              }
            </small>
          </button>
        ))}
        {models.some((m) => !m.channels.length) && (
          <button
            className={channel === "unassigned" ? "selected" : ""}
            onClick={() => change("channel", "unassigned")}
          >
            <span className="channel-dot unassigned" />
            <span>未分配渠道</span>
            <small>{models.filter((m) => !m.channels.length).length}</small>
          </button>
        )}
      </div>
      {(type !== "all" || channel !== "all" || search) && (
        <button
          className="text-button reset-filter"
          onClick={() => {
            setParams({});
            setPage(1);
          }}
        >
          <X size={14} />
          清除筛选
        </button>
      )}
      <div className="filter-footnote">
        <Sparkles size={18} />
        <p>
          选一个模型，
          <br />
          让灵感开始流动。
        </p>
      </div>
    </>
  );
  return (
    <div className="model-market">
      <header className="market-heading">
        <div>
          <span className="eyebrow">
            <span className="live-dot" />
            MODEL LIBRARY
          </span>
          <h1>
            模型广场<span>为灵感，找到可能。</span>
          </h1>
          <p>图片、视频、语言与语音。探索你的下一件作品。</p>
        </div>
        <div className="market-summary">
          <strong>{models.length.toString().padStart(2, "0")}</strong>
          <span>创作模型 / 无限可能</span>
        </div>
      </header>
      <QueryState query={query}>
        <div className="market-layout">
          <aside className="market-filters">{filterPanel}</aside>
          <section className="market-results">
            <div className="market-toolbar">
              <label className="market-search">
                <Search size={18} />
                <input
                  aria-label="搜索模型"
                  placeholder="寻找模型、能力，或新的灵感…"
                  value={search}
                  onChange={(e) => change("q", e.target.value)}
                />
                {search && (
                  <button aria-label="清除搜索" onClick={() => change("q", "")}>
                    <X size={15} />
                  </button>
                )}
              </label>
              <button
                className="mobile-filter-button"
                onClick={() => setFilterOpen(true)}
              >
                <SlidersHorizontal size={17} />
                筛选
              </button>
              <span className="result-count">{filtered.length} 个模型</span>
            </div>
            <div className="active-filters">
              {type !== "all" && (
                <button onClick={() => change("type", "all")}>
                  {MODEL_TYPE_LABELS[type as ModelType] || type}
                  <X size={12} />
                </button>
              )}
              {channel !== "all" && (
                <button onClick={() => change("channel", "all")}>
                  {channel === "unassigned"
                    ? "未分配渠道"
                    : channels.find((c) => c.id === channel)?.name || "渠道"}
                  <X size={12} />
                </button>
              )}
              {multiplier < 1 && (
                <span className="personal-rate">
                  <Sparkles size={12} />
                  {(multiplier * 10).toFixed(1)} 折专属价格已生效
                </span>
              )}
            </div>
            {filtered.length ? (
              <div className="model-directory">
                {filtered
                  .slice((page - 1) * pageSize, page * pageSize)
                  .map((m, index) => {
                    const Icon = TYPE_ICONS[m.type as ModelType];
                    return (
                      <article
                        className={`model-card directory-card ${m.type}`}
                        key={m.model}
                        style={
                          {
                            "--entry-delay": `${Math.min(index, 7) * 35}ms`,
                          } as React.CSSProperties
                        }
                      >
                        <button
                          className="model-entry"
                          onClick={() => change("model", m.model)}
                          aria-label={`查看 ${m.display_name} 价格详情`}
                        >
                          <div className={`type-tile ${m.type}`}>
                            <Icon size={23} />
                          </div>
                          <div className="model-entry-content">
                            <div className="model-entry-title">
                              <h2>{m.display_name}</h2>
                              <Badge>
                                {MODEL_TYPE_LABELS[m.type as ModelType]}
                              </Badge>
                            </div>
                            <code>{m.model}</code>
                            <p>
                              {m.description ||
                                (
                                  {
                                    video: "把想象，转化为流动的故事。",
                                    image: "让画面，回应你的每一个想法。",
                                    language: "更清晰的表达，更有力的灵感。",
                                    speech: "为创作赋予声音与温度。",
                                  } as Row
                                )[m.type]}
                            </p>
                            <div className="model-entry-channels">
                              <span
                                className={`availability-dot ${m.enabled ? "on" : ""}`}
                              />
                              {m.enabled ? "已发布" : "暂时停用"}
                              <i />
                              {m.channels.length
                                ? m.channels.map((c: Row) => c.name).join(" / ")
                                : "渠道待配置"}
                            </div>
                          </div>
                          <span className="entry-arrow">
                            <ArrowUpRight size={19} />
                          </span>
                        </button>
                      </article>
                    );
                  })}
              </div>
            ) : (
              <Empty text="没有找到匹配的模型">
                <button onClick={() => setParams({})}>重新探索全部模型</button>
              </Empty>
            )}
            {filtered.length > pageSize && (
              <nav className="model-pagination" aria-label="模型目录分页">
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                  上一页
                </button>
                <span>
                  {page} / {Math.ceil(filtered.length / pageSize)}
                </span>
                <button
                  disabled={page >= Math.ceil(filtered.length / pageSize)}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                  <ArrowRight size={15} />
                </button>
              </nav>
            )}
            <p className="market-bottom-note">
              点击模型，查看完整价格与专属优惠 <ChevronRight size={13} />
            </p>
          </section>
        </div>
      </QueryState>
      <Modal
        title="筛选模型"
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
      >
        <div className="mobile-market-filters">
          {filterPanel}
          <button className="primary full" onClick={() => setFilterOpen(false)}>
            查看 {filtered.length} 个模型
            <ArrowRight size={16} />
          </button>
        </div>
      </Modal>
      {model && (
        <ModelDetail
          key={model.model}
          model={model}
          multiplier={multiplier}
          busy={action.busy}
          onClose={() => change("model", "")}
          onUse={async (tier: string) => {
            await action.run(async () => {
              let content: Row;
              if (model.type === "image") {
                const preferred: Row = {
                  "1K": "1024x1024",
                  "2K": "2048x2048",
                  "4K": "4096x2160",
                };
                let size = preferred[tier] || DEFAULT_IMAGE_PARAMETERS.size;
                if (getSizeCategory(size, model.model) !== tier)
                  size =
                    (SIZE_PRESETS as Row)[tier]?.find(
                      (s: string) => getSizeCategory(s, model.model) === tier,
                    ) || size;
                content = {
                  nodes: [
                    {
                      id: uid(),
                      type: "image",
                      position: { x: 120, y: 120 },
                      data: {
                        prompt: "",
                        model: model.model,
                        mode: "text",
                        images: [],
                        parameters: { ...DEFAULT_IMAGE_PARAMETERS, size },
                        status: "DRAFT",
                      },
                    },
                  ],
                  edges: [],
                };
              } else if (model.type === "language")
                content = {
                  nodes: [
                    {
                      id: uid(),
                      type: "text",
                      position: { x: 120, y: 120 },
                      data: {
                        text: "",
                        optimizeEnabled: true,
                        optimizeModel: model.model,
                        optimizeReasoning: "auto",
                      },
                    },
                  ],
                  edges: [],
                };
              else if (
                ["speech", "threed", "world", "realtime"].includes(
                  model.type,
                ) ||
                (model.type === "video" && !model.model.startsWith("wan3.0"))
              ) {
                content = {
                  nodes: [
                    {
                      id: uid(),
                      type: "capability",
                      position: { x: 120, y: 120 },
                      data: {
                        model: model.model,
                        prompt: "",
                        parameters: {
                          max_seconds: 60,
                          duration: 5,
                          resolution:
                            model.type === "video" ? tier || "1080P" : "480p",
                        },
                      },
                    },
                  ],
                  edges: [],
                };
              } else {
                const pair = newGenerationPair("text", undefined, {
                  model: model.model,
                  parameters: { ...DEFAULT_PARAMETERS, resolution: tier },
                });
                content = { nodes: pair.nodes, edges: pair.edges };
              }
              const project = await post("/projects", {
                name: `${model.display_name} 创作`,
                content,
              });
              navigate(`/canvas/${project.id}`);
            });
          }}
        />
      )}
    </div>
  );
}
function ModelDetail({
  model,
  multiplier,
  busy,
  onClose,
  onUse,
}: {
  model: Row;
  multiplier: number;
  busy: boolean;
  onClose: () => void;
  onUse: (tier: string) => Promise<void>;
}) {
  const Icon = TYPE_ICONS[model.type as ModelType];
  const active = model.prices.filter((p: Row) => p.enabled);
  const [tier, setTier] = useState(active[0]?.tier || "");
  const [quantity, setQuantity] = useState(model.type === "video" ? 5 : 1);
  const price = active.find((p: Row) => p.tier === tier) || active[0];
  const unit =
    model.type === "video"
      ? "秒"
      : model.type === "image"
        ? "张"
        : BILLING_LABELS[model.billing_unit];
  const usable =
    model.enabled &&
    active.length > 0 &&
    (model.type !== "language" || model.channels.some((c: Row) => c.enabled));
  return (
    <Modal title="模型详情" open onClose={onClose} wide>
      <div className="model-detail">
        <header className="model-detail-head">
          <span className={`type-tile large ${model.type}`}>
            <Icon size={32} />
          </span>
          <div>
            <span className="eyebrow">
              {MODEL_TYPE_LABELS[model.type as ModelType]}模型
            </span>
            <h2>{model.display_name}</h2>
            <code>{model.model}</code>
          </div>
        </header>
        <p className="model-detail-description">
          {model.description || "选择合适的规格，让你的创意成为现实。"}
        </p>
        <div className="tag-list">
          {model.channels.map((c: Row) => (
            <span key={c.id}>
              {c.name}
              {!c.enabled ? " · 停用" : ""}
            </span>
          ))}
        </div>
        {multiplier < 1 && (
          <div className="personal-price-banner">
            <Sparkles size={18} />
            <div>
              <strong>这是专属于你的价格</strong>
              <p>
                本站售价 × {multiplier} = 你的实付单价，已享{" "}
                {(multiplier * 10).toFixed(1)} 折优惠。
              </p>
            </div>
            <Check size={19} />
          </div>
        )}
        <h3 className="detail-section-title">
          价格详情 <span>人民币 / {unit}</span>
        </h3>
        <div className="table-wrap">
          <table className="price-table detail-price-table">
            <thead>
              <tr>
                <th>
                  {model.type === "video"
                    ? "分辨率"
                    : model.type === "image"
                      ? "尺寸"
                      : "计费方向"}
                </th>
                <th>本站售价</th>
                <th>你的价格</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {model.type === "video"
                ? model.prices.map((p: Row) => (
                    <tr key={p.id}>
                      <td>{p.tier}</td>
                      <td>{money(p.base_sale)}</td>
                      <td>
                        <strong>{money(p.sale)}</strong>
                      </td>
                      <td>
                        <Badge>{p.enabled ? "可用" : "停用"}</Badge>
                      </td>
                    </tr>
                  ))
                : model.type === "image"
                  ? model.prices.flatMap((p: Row) => [
                      <tr key={`${p.id}-input`}>
                        <td>{p.tier} · 输入图</td>
                        <td>{money(p.base_input)}</td>
                        <td>
                          <strong>{money(p.input_sale)}</strong>
                        </td>
                        <td rowSpan={2}>
                          <Badge>{p.enabled ? "可用" : "停用"}</Badge>
                        </td>
                      </tr>,
                      <tr key={`${p.id}-output`}>
                        <td>{p.tier} · 输出图</td>
                        <td>{money(p.base_output)}</td>
                        <td>
                          <strong>{money(p.output_sale)}</strong>
                        </td>
                      </tr>,
                    ])
                  : ["input", "output"].map((direction) => (
                      <tr key={direction}>
                        <td>
                          {direction === "input" ? "输入" : "输出"} / {unit}
                        </td>
                        <td>{money(model.prices[0]?.[`base_${direction}`])}</td>
                        <td>
                          <strong>
                            {money(model.prices[0]?.[`${direction}_sale`])}
                          </strong>
                        </td>
                        <td>
                          <Badge>{model.enabled ? "可用" : "停用"}</Badge>
                        </td>
                      </tr>
                    ))}
            </tbody>
          </table>
        </div>
        {["video", "image"].includes(model.type) && price && (
          <div className="detail-estimator">
            <label className="field">
              使用档位
              <select
                aria-label="使用价格档位"
                value={tier}
                onChange={(e) => setTier(e.target.value)}
              >
                {active.map((p: Row) => (
                  <option key={p.tier} value={p.tier}>
                    {p.tier}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {model.type === "video" ? "纯生成时长（秒）" : "输出数量（张）"}
              <input
                type="number"
                min={1}
                max={model.type === "video" ? 30 : model.capability?.maxN || 6}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </label>
            <div>
              <small>预计费用</small>
              <strong>
                {money(
                  quantity *
                    (model.type === "video" ? price.sale : price.output_sale),
                )}
              </strong>
            </div>
          </div>
        )}
        <p className="muted detail-billing-note">
          {model.type === "image"
            ? "文生图仅计算输出费用；使用参考图时，另按输入图片数量计费。"
            : model.type === "video"
              ? "视频按输入视频与完整输出视频的总时长计费，最终以实际用量结算。"
              : model.type === "language"
                ? "提示词优化使用此模型的输入与输出 token 价格。上游不返回用量时按文本估算，并在结果中标记。"
                : "按管理员配置的计费单位预占预算，生成与实时会话按实际用量结算。"}
        </p>
        <button
          className="primary detail-use"
          disabled={!usable || busy}
          onClick={() => void onUse(tier)}
        >
          <Icon size={18} />
          {busy
            ? "正在准备创作空间…"
            : !usable
              ? "模型或渠道暂不可用"
              : model.type === "language"
                ? "在文本节点中使用"
                : "在画布中使用"}
          <ArrowUpRight size={18} />
        </button>
        {WORKBENCH_ENABLED &&
          model.type !== "image" &&
          model.channels.some((c: Row) => c.source === "bailian") && (
            <a
              className="button full"
              style={{ marginTop: 10 }}
              href={`/studio?model=${encodeURIComponent(model.model)}`}
            >
              <Sparkles size={16} />
              在多模态工作台中使用
            </a>
          )}
      </div>
    </Modal>
  );
}
