import { useState, useRef, useContext, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import QRCode from "qrcode";
import {
  Plus,
  Copy,
  Archive,
  Trash2,
  RotateCcw,
  Video,
  Image as ImageIcon,
  File,
  Upload,
  Link2,
  Download,
  Scissors,
  Eye,
  Play,
  ArrowUpRight,
  KeyRound,
  Check,
  Film,
  X,
  Search,
  Wallet,
  CircleDollarSign,
  QrCode,
  RefreshCw,
  Clock3,
  CreditCard,
  CheckCircle2,
  XCircle,
  Sparkles,
  LoaderCircle,
} from "lucide-react";
import { MODEL_TYPE_LABELS, type ModelType } from "../shared/catalog";
import {
  api,
  post,
  patch,
  useData,
  usePagedData,
  MoreRecords,
  useAction,
  money,
  date,
  bytes,
  uid,
  Table,
  PageHead,
  Modal,
  EditForm,
  QueryState,
  Empty,
  Badge,
  IconButton,
  NotifyContext,
  Markdown,
  type Row,
  type Field,
} from "./lib";
import {
  MODEL_IDS,
  RESOLUTIONS,
  DEFAULT_PARAMETERS,
  MODES,
  STATUS_LABELS,
} from "../shared/wan";
import {
  DEFAULT_IMAGE_PARAMETERS,
  getSizeCategory,
  IMAGE_MODEL_IDS,
  IMAGE_SIZE_CATEGORIES,
  IMAGE_STATUS_LABELS,
  MODEL_CAPABILITIES,
  SIZE_PRESETS,
} from "../shared/image";

export function newGeneration(
  mode = "text",
  position = { x: 120, y: 120 },
  extra: Row = {},
) {
  return {
    id: uid(),
    type: "generation",
    position,
    data: {
      label: MODES.find((m) => m[0] === mode)?.[1] || "视频生成",
      model: "wan3.0-video",
      mode,
      prompt: "",
      media: [],
      parameters: { ...DEFAULT_PARAMETERS },
      ...extra,
    },
  };
}
export function newGenerationPair(
  mode = "text",
  position = { x: 120, y: 120 },
  extra: Row = {},
) {
  const generation = newGeneration(mode, position, extra);
  const preview = {
    id: uid(),
    type: "preview",
    position: { x: position.x + 350, y: position.y + 16 },
    data: {},
  };
  const edge = {
    id: uid(),
    source: generation.id,
    sourceHandle: "video",
    target: preview.id,
    targetHandle: "preview",
  };
  return { nodes: [generation, preview], edges: [edge] };
}
export function Projects() {
  const q = useData<Row[]>("/projects");
  const action = useAction();
  const navigate = useNavigate();
  const [tab, setTab] = useState("active"),
    [search, setSearch] = useState(""),
    [create, setCreate] = useState(false),
    [rename, setRename] = useState<Row | null>(null);
  const createProject = (v: Row) =>
    action.run(async () => {
      const mode = v.template || "blank";
      const p = await post("/projects", {
        name: v.name,
        content: {
          ...(mode === "blank"
            ? { nodes: [], edges: [] }
            : newGenerationPair(mode)),
        },
      });
      navigate(`/canvas/${p.id}`);
    });
  const rows = (q.data || []).filter(
    (p) =>
      (tab === "deleted"
        ? p.deleted_at
        : !p.deleted_at && (tab === "archived" ? p.archived : !p.archived)) &&
      p.name.includes(search),
  );
  return (
    <>
      <PageHead
        title="我的画布"
        subtitle="创意工作空间"
        actions={
          <button className="primary" onClick={() => setCreate(true)}>
            <Plus size={17} />
            新建画布
          </button>
        }
      />
      <div className="table-tools">
        <div className="tabs">
          {[
            ["active", "全部画布"],
            ["archived", "已归档"],
            ["deleted", "回收站"],
          ].map(([k, v]) => (
            <button
              className={tab === k ? "active" : ""}
              key={k}
              onClick={() => setTab(k)}
            >
              {v}
            </button>
          ))}
        </div>
        <span className="grow" />
        <label className="search">
          <Search size={17} />
          <input
            placeholder="搜索画布"
            aria-label="搜索画布"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <QueryState query={q}>
        {!rows.length ? (
          <Empty text={tab === "active" ? "还没有画布" : "暂无画布"}>
            {tab === "active" && (
              <button onClick={() => setCreate(true)}>
                <Plus size={16} />
                创建画布
              </button>
            )}
          </Empty>
        ) : (
          <div className="project-grid">
            {rows.map((p) => (
              <article className="project-card" key={p.id}>
                <button
                  className="project-preview"
                  onClick={() => navigate(`/canvas/${p.id}`)}
                >
                  <div className="preview-nodes">
                    <span>
                      <ImageIcon size={22} />
                    </span>
                    <i />
                    <span>
                      <Video size={28} />
                    </span>
                    <i />
                    <span>
                      <Film size={22} />
                    </span>
                  </div>
                  <span className="preview-caption">{p.node_count} 个节点</span>
                </button>
                <div className="project-info">
                  <button
                    className="project-title text-button"
                    onClick={() => navigate(`/canvas/${p.id}`)}
                  >
                    {p.name}
                  </button>
                  <small>{date(p.updated_at)}</small>
                  <div className="project-actions">
                    <button
                      className="text-button"
                      onClick={() => setRename(p)}
                    >
                      重命名
                    </button>
                    <span className="grow" />
                    <IconButton
                      title="复制"
                      onClick={() =>
                        action.run(async () => {
                          const copy = await post(
                            `/projects/${p.id}/duplicate`,
                          );
                          navigate(`/canvas/${copy.id}`);
                        })
                      }
                    >
                      <Copy size={16} />
                    </IconButton>
                    {!p.deleted_at && (
                      <IconButton
                        title={p.archived ? "取消归档" : "归档"}
                        onClick={() =>
                          action.run(() =>
                            patch(`/projects/${p.id}`, {
                              version: p.version,
                              archived: !p.archived,
                            }),
                          )
                        }
                      >
                        <Archive size={16} />
                      </IconButton>
                    )}
                    <IconButton
                      title={p.deleted_at ? "恢复画布" : "移入回收站"}
                      onClick={() =>
                        action.run(() =>
                          patch(`/projects/${p.id}`, {
                            version: p.version,
                            deleted: !p.deleted_at,
                          }),
                        )
                      }
                    >
                      {p.deleted_at ? (
                        <RotateCcw size={16} />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </IconButton>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </QueryState>
      <Modal title="新建画布" open={create} onClose={() => setCreate(false)}>
        <EditForm
          fields={[
            { key: "name", label: "画布名称", required: true },
            {
              key: "template",
              label: "起始模板",
              options: [
                ["blank", "空白画布"],
                ...MODES.map(([k, v]) => [k, v] as [string, string]),
              ],
            },
          ]}
          initial={{ name: "未命名画布", template: "blank" }}
          busy={action.busy}
          submit="创建"
          onSubmit={createProject}
        />
      </Modal>
      <Modal title="重命名" open={!!rename} onClose={() => setRename(null)}>
        {rename && (
          <EditForm
            fields={[{ key: "name", label: "画布名称", required: true }]}
            initial={rename}
            busy={action.busy}
            onSubmit={(v) =>
              action.run(async () => {
                await patch(`/projects/${rename.id}`, {
                  name: v.name,
                  version: rename.version,
                });
                setRename(null);
              })
            }
          />
        )}
      </Modal>
    </>
  );
}
export { ModelMarket as Models } from "./model-market";
export function MediaPreview({
  asset,
  controls = true,
}: {
  asset: Row;
  controls?: boolean;
}) {
  if (!controls && asset.url && ["image", "video"].includes(asset.kind))
    return (
      <img
        src={`/api/v1/assets/${asset.id}/thumbnail`}
        alt={asset.name}
        loading="lazy"
      />
    );
  if (!asset.url)
    return (
      <div className="media-placeholder">
        <File size={28} />
        <span>
          {asset.expired
            ? "已到期"
            : asset.kind === "link"
              ? "网页"
              : asset.name}
        </span>
      </div>
    );
  if (asset.kind === "image")
    return <img src={asset.url} alt={asset.name} loading="lazy" />;
  if (asset.kind === "video")
    return <video src={asset.url} preload="metadata" controls={controls} />;
  if (asset.kind === "audio")
    return (
      <div className="audio-preview">
        <audio src={asset.url} controls preload="none" />
      </div>
    );
  return (
    <div className="media-placeholder">
      <File size={28} />
      <span>{asset.metadata?.extension?.toUpperCase()}</span>
    </div>
  );
}
export function Assets({
  onSelect,
  onDeleted,
}: {
  onSelect?: (asset: Row) => void;
  onDeleted?: (assetId: string) => void | Promise<void>;
}) {
  const q = usePagedData("/assets", 15000);
  const exports = useData<Row[]>("/assets/exports/list", 5000);
  const action = useAction();
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [detail, setDetail] = useState<Row | null>(null),
    [importing, setImporting] = useState(false),
    [derive, setDerive] = useState(false),
    [trash, setTrash] = useState(false);
  const [purge, setPurge] = useState<Row | null>(null);
  const [remove, setRemove] = useState<Row | null>(null);
  const [extractingFrame, setExtractingFrame] = useState<
    "frame_first" | "frame_last" | null
  >(null);
  const [extractedFrame, setExtractedFrame] = useState<Row | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const extractFrame = async (operation: "frame_first" | "frame_last") => {
    if (!detail || action.busy || extractingFrame) return;
    setExtractingFrame(operation);
    try {
      await action.run(
        async () => {
          const result = await post(`/assets/${detail.id}/derive`, {
            operation,
          });
          setExtractedFrame(result);
        },
        operation === "frame_first"
          ? "首帧已保存到资产库"
          : "尾帧已保存到资产库",
      );
    } finally {
      setExtractingFrame(null);
    }
  };
  const list = (q.data || []).filter(
    (a) =>
      (trash ? !!a.deleted_at : !a.deleted_at) &&
      (kind === "all" || a.kind === kind) &&
      `${a.name} ${a.tags?.join(" ")}`.includes(search),
  );
  return (
    <>
      <PageHead
        title={onSelect ? "选择素材" : "资产库"}
        subtitle={
          onSelect
            ? undefined
            : `临时存储 30 天 · 当前 ${bytes((q.data || []).filter((a) => !a.expired).reduce((n, a) => n + a.size, 0))}`
        }
        actions={
          <>
            <button onClick={() => setImporting(true)}>
              <Link2 size={16} />
              导入链接
            </button>
            <button
              className="primary"
              disabled={action.busy}
              onClick={() => file.current?.click()}
            >
              <Upload size={16} />
              上传素材
            </button>
            <input
              ref={file}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                action.run(async () => {
                  for (const f of files) {
                    const body = new FormData();
                    body.append("file", f);
                    await api("/assets/upload", { method: "POST", body });
                  }
                }, "上传完成");
                e.target.value = "";
              }}
            />
          </>
        }
      />
      <div className="table-tools">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="搜索资产"
            placeholder="名称或标签"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="素材类型"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          {[
            ["all", "全部类型"],
            ["image", "图片"],
            ["video", "视频"],
            ["audio", "音频"],
            ["file", "文档"],
            ["link", "网页"],
          ].map(([k, v]) => (
            <option value={k} key={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          className={trash ? "active" : ""}
          onClick={() => setTrash(!trash)}
        >
          <Trash2 size={15} />
          回收站
        </button>
        <span className="grow" />
        {selected.length > 0 && (
          <button
            disabled={action.busy}
            onClick={() =>
              action.run(
                () => post("/assets/exports", { asset_ids: selected }),
                "下载包已加入队列",
              )
            }
          >
            <Download size={16} />
            打包下载 ({selected.length})
          </button>
        )}
      </div>
      <QueryState query={q}>
        {!list.length ? (
          <Empty text="暂无素材" />
        ) : (
          <div className="asset-grid">
            {list.map((a) => (
              <article className="asset-card" key={a.id}>
                <div
                  className="asset-preview"
                  onClick={() =>
                    onSelect && !a.expired && !a.deleted_at
                      ? onSelect(a)
                      : setDetail(a)
                  }
                >
                  <MediaPreview asset={a} controls={false} />
                  {!onSelect && a.url && (
                    <input
                      aria-label={`选择 ${a.name}`}
                      type="checkbox"
                      checked={selected.includes(a.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, a.id]
                            : selected.filter((id) => id !== a.id),
                        )
                      }
                    />
                  )}
                </div>
                <div className="asset-info">
                  <strong title={a.name}>{a.name}</strong>
                  <small>
                    {bytes(a.size)} ·{" "}
                    {a.metadata?.duration
                      ? `${a.metadata.duration.toFixed(1)} 秒`
                      : a.metadata?.width
                        ? `${a.metadata.width} × ${a.metadata.height}`
                        : a.kind}
                  </small>
                  <span
                    className={
                      new Date(a.expires_at).getTime() - Date.now() <
                      7 * 86400000
                        ? "expiry-warning"
                        : "muted"
                    }
                  >
                    {a.expired
                      ? "已到期"
                      : `${new Date(a.expires_at).toLocaleDateString("zh-CN")} 到期`}
                  </span>
                  <div className="tag-list">
                    {a.tags?.map((t: string) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </QueryState>
      {!onSelect && !!exports.data?.length && (
        <section className="section-band">
          <h2>下载包</h2>
          {exports.data.map((j) => (
            <div className="list-row" key={j.id}>
              <span>{date(j.created_at)}</span>
              <Badge>{STATUS_LABELS[j.status] || j.status}</Badge>
              <span className="muted">{j.error}</span>
              {j.status === "SUCCEEDED" &&
                new Date(j.expires_at) > new Date() && (
                  <a
                    className="button"
                    href={`/api/v1/assets/exports/${j.id}/download`}
                  >
                    <Download size={15} />
                    下载 ZIP
                  </a>
                )}
            </div>
          ))}
        </section>
      )}
      <MoreRecords query={q} />
      <Modal
        title="导入素材"
        open={importing}
        onClose={() => setImporting(false)}
      >
        <EditForm
          fields={[
            {
              key: "kind",
              label: "类型",
              options: [
                ["media", "图片 / 视频 / 音频 / 文件 URL 或图片 Base64"],
                ["link", "网页 URL"],
              ],
            },
            { key: "url", label: "地址", type: "textarea", required: true },
          ]}
          initial={{ kind: "media" }}
          busy={action.busy}
          onSubmit={(v) =>
            action.run(async () => {
              await post("/assets/import", v);
              setImporting(false);
            }, "导入完成")
          }
        />
      </Modal>
      <Modal
        title={detail?.name || "素材详情"}
        open={!!detail}
        onClose={() => {
          setDetail(null);
          setDerive(false);
        }}
        wide
      >
        {detail && (
          <>
            <div className="detail-media">
              <MediaPreview asset={detail} />
            </div>
            <div className="actions">
              <a
                className="button"
                href={`${detail.url}?download=1`}
                hidden={!detail.url}
              >
                <Download size={16} />
                下载
              </a>
              {!detail.expired &&
                !detail.deleted_at &&
                ["image", "video", "audio"].includes(detail.kind) && (
                  <button onClick={() => setDerive(!derive)}>
                    <Scissors size={16} />
                    处理素材
                  </button>
                )}
              {!detail.expired &&
                !detail.deleted_at &&
                detail.kind === "video" && (
                  <div className="asset-derived-actions">
                    <button
                      disabled={action.busy}
                      aria-busy={extractingFrame === "frame_first"}
                      onClick={() => void extractFrame("frame_first")}
                    >
                      {extractingFrame === "frame_first" ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <ImageIcon size={15} />
                      )}
                      {extractingFrame === "frame_first"
                        ? "提取首帧中"
                        : "提取首帧"}
                    </button>
                    <button
                      disabled={action.busy}
                      aria-busy={extractingFrame === "frame_last"}
                      onClick={() => void extractFrame("frame_last")}
                    >
                      {extractingFrame === "frame_last" ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <ImageIcon size={15} />
                      )}
                      {extractingFrame === "frame_last"
                        ? "提取尾帧中"
                        : "提取尾帧"}
                    </button>
                  </div>
                )}
              <button
                onClick={() =>
                  detail.deleted_at
                    ? action.run(async () => {
                        await patch(`/assets/${detail.id}`, { deleted: false });
                        setDetail(null);
                      })
                    : setRemove(detail)
                }
              >
                {detail.deleted_at ? (
                  <RotateCcw size={16} />
                ) : (
                  <Trash2 size={16} />
                )}{" "}
                {detail.deleted_at ? "恢复" : "移入回收站"}
              </button>
              {detail.deleted_at && (
                <button className="danger" onClick={() => setPurge(detail)}>
                  永久删除
                </button>
              )}
            </div>
            {extractedFrame && extractedFrame.parent_id === detail.id && (
              <div className="asset-frame-result" role="status">
                <img src={extractedFrame.url} alt={extractedFrame.name} />
                <div>
                  <strong>{extractedFrame.name}</strong>
                  <small>已保存到资产库</small>
                </div>
                <button
                  onClick={() => {
                    setDetail(extractedFrame);
                    setDerive(false);
                  }}
                >
                  <Eye size={15} />
                  查看图片
                </button>
              </div>
            )}
            {derive ? (
              <EditForm
                initial={{
                  operation: detail.kind === "image" ? "flatten" : "trim",
                  start: 0,
                  duration: 5,
                  background: "#ffffff",
                }}
                fields={[
                  {
                    key: "operation",
                    label: "操作",
                    options:
                      detail.kind === "image"
                        ? [["flatten", "消除透明通道"]]
                        : detail.kind === "video"
                          ? [
                              ["trim", "截取片段"],
                              ["frame", "指定时间截帧"],
                              ["frame_first", "提取首帧"],
                              ["frame_last", "提取尾帧"],
                            ]
                          : [["trim", "截取片段"]],
                  },
                  { key: "start", label: "起始秒", type: "number", min: 0 },
                  {
                    key: "duration",
                    label: "截取秒数",
                    type: "number",
                    min: 1,
                    max: 15,
                  },
                  { key: "background", label: "背景颜色", type: "color" },
                ]}
                busy={action.busy}
                submit="生成派生素材"
                onSubmit={(v) =>
                  action.run(async () => {
                    await post(`/assets/${detail.id}/derive`, v);
                    setDetail(null);
                  }, "已保存派生素材")
                }
              />
            ) : (
              <EditForm
                fields={[
                  { key: "name", label: "名称", required: true },
                  { key: "tagText", label: "标签（逗号分隔）" },
                ]}
                initial={{ ...detail, tagText: detail.tags?.join(",") }}
                busy={action.busy}
                onSubmit={(v) =>
                  action.run(async () => {
                    await patch(`/assets/${detail.id}`, {
                      name: v.name,
                      tags: String(v.tagText || "")
                        .split(/[,，]/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    });
                    setDetail(null);
                  }, "已保存")
                }
              />
            )}
            <p className="muted">
              到期时间：{date(detail.expires_at)}
              {detail.parent_id ? " · 派生文件沿用原素材到期时间" : ""}
            </p>
          </>
        )}
      </Modal>
      <Modal title="移入回收站" open={!!remove} onClose={() => setRemove(null)}>
        <p>
          确认删除“{remove?.name}
          ”？引用该素材的画布节点、连接和直接素材引用会一并移除，素材仍可在回收站中恢复。
        </p>
        <button
          className="danger"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const assetId = remove!.id;
              await patch(`/assets/${assetId}`, { deleted: true });
              await onDeleted?.(assetId);
              setRemove(null);
              setDetail(null);
            }, "素材已移入回收站")
          }
        >
          确认删除
        </button>
      </Modal>
      <Modal title="永久删除素材" open={!!purge} onClose={() => setPurge(null)}>
        <p>
          此操作会立即删除文件并释放存储空间。画布引用将变为不可用，无法恢复。
        </p>
        <button
          className="danger"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const assetId = purge!.id;
              await api(`/assets/${assetId}`, { method: "DELETE" });
              await onDeleted?.(assetId);
              setPurge(null);
              setDetail(null);
            }, "素材已永久删除")
          }
        >
          确认永久删除
        </button>
      </Modal>
    </>
  );
}
export function TaskDetail({
  task,
  onClose,
}: {
  task: Row | null;
  onClose: () => void;
}) {
  const isImage = !!task?.image;
  const q = useData(
    `${isImage ? "/image-generations" : "/generations"}/${task?.id || "none"}`,
    task ? 5000 : undefined,
  );
  const t = q.data || task;
  const action = useAction();
  return (
    <Modal title="调用详情" open={!!task} onClose={onClose} wide>
      {t && (
        <>
          <div className="detail-grid">
            <span>任务</span>
            <code>{t.id}</code>
            <span>状态</span>
            <Badge tone={t.status === "SUCCEEDED" ? "teal" : "neutral"}>
              {(isImage ? IMAGE_STATUS_LABELS : STATUS_LABELS)[t.status] ||
                t.status}
            </Badge>
            <span>模型</span>
            <span>
              {t.model} · {isImage ? t.parameters?.size : t.resolution}
            </span>
            <span>冻结 / 消费 / 退款</span>
            <span>
              {money(t.reserved)} / {money(t.charged)} / {money(t.refunded)}
            </span>
            <span>实际用量</span>
            <span>
              {t.usage
                ? isImage
                  ? `${t.usage.input_image_count ?? t.input_count} 张输入 · ${t.usage.output_image_count ?? t.actual_output_count ?? 0} 张输出`
                  : `${t.usage.input_video_duration} + ${t.usage.output_video_duration} = ${t.usage.duration} 秒`
                : "待生成"}
            </span>
          </div>
          {t.error && <div className="notice warning">{t.error}</div>}
          {isImage && (t.result_assets || []).length > 0 && (
            <div className="image-result-grid image-detail-results">
              {t.result_assets.map((assetId: string, index: number) => (
                <a
                  key={assetId}
                  href={`/api/v1/assets/${assetId}/content?download=1`}
                >
                  <img
                    src={`/api/v1/assets/${assetId}/content`}
                    alt={`生成结果 ${index + 1}`}
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          )}
          {!isImage && t.result_asset_id && (
            <video
              className="result-video"
              controls
              src={`/api/v1/assets/${t.result_asset_id}/content`}
            />
          )}
          <h3>提示词</h3>
          <p className="pre-wrap">
            {isImage ? t.prompt : t.input?.input?.prompt || "无提示词"}
          </p>
          <details>
            <summary>调用参数</summary>
            <pre>
              {JSON.stringify(
                isImage
                  ? {
                      prompt: t.prompt,
                      parameters: t.parameters,
                      usage: t.usage,
                    }
                  : t.input,
                null,
                2,
              )}
            </pre>
          </details>
          <div className="actions">
            {t.project_id && (
              <Link className="button" to={`/canvas/${t.project_id}`}>
                <ArrowUpRight size={16} />
                返回画布
              </Link>
            )}
            {(isImage
              ? t.status === "QUEUED"
              : ["QUEUED", "PENDING"].includes(t.status)) && (
              <button
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () =>
                      post(
                        `${isImage ? "/image-generations" : "/generations"}/${t.id}/cancel`,
                      ),
                    "已请求取消",
                  )
                }
              >
                取消任务
              </button>
            )}
            {!isImage && t.result_asset_id && (
              <a
                className="button"
                href={`/api/v1/assets/${t.result_asset_id}/content?download=1`}
              >
                <Download size={16} />
                下载结果
              </a>
            )}
          </div>
          {t.events?.map((e: Row, i: number) => (
            <div className="timeline" key={i}>
              <small>{date(e.created_at)}</small>
              <span>{e.message || e.detail || e.event}</span>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
export function Usage() {
  const q = usePagedData("/generations", 10000);
  const imageQuery = useData<{ tasks: Row[] }>(
    "/image-generations?limit=100",
    10000,
  );
  const [detail, setDetail] = useState<Row | null>(null);
  const imageRows: Row[] = (imageQuery.data?.tasks || []).map((task): Row => ({
    ...task,
    image: true,
    source: "图片生成",
  }));
  const rows: Row[] = [...(q.data || []), ...imageRows].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return (
    <>
      <PageHead title="使用记录" subtitle="生成任务与费用明细" />
      <QueryState query={q}>
        <Table
          rows={rows}
          filename="调用记录"
          partial={q.hasNextPage}
          columns={[
            {
              key: "created_at",
              title: "时间",
              render: (r) => date(r.created_at),
            },
            { key: "model", title: "模型" },
            {
              key: "resolution",
              title: "规格",
              render: (r) => (r.image ? r.parameters?.size : r.resolution),
            },
            {
              key: "mode",
              title: "模式",
              render: (r) =>
                r.image
                  ? r.mode === "image"
                    ? "图生图"
                    : "文生图"
                  : MODES.find((m) => m[0] === r.mode)?.[1],
            },
            {
              key: "status",
              title: "状态",
              render: (r) => (
                <Badge
                  tone={
                    r.status === "SUCCEEDED"
                      ? "teal"
                      : r.status === "FAILED"
                        ? "red"
                        : "neutral"
                  }
                >
                  {(r.image ? IMAGE_STATUS_LABELS : STATUS_LABELS)[r.status] ||
                    r.status}
                </Badge>
              ),
            },
            { key: "charged", title: "消费", render: (r) => money(r.charged) },
            { key: "source", title: "来源" },
            {
              key: "detail",
              title: "",
              render: (r) => (
                <button onClick={() => setDetail(r)}>
                  <Eye size={16} />
                  详情
                </button>
              ),
            },
          ]}
        />
        <MoreRecords query={q} />
      </QueryState>
      {detail && <TaskDetail task={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
const keyFields: Field[] = [
  { key: "name", label: "密钥名称", required: true },
  {
    key: "dailyLimit",
    label: "每日消费限额（元）",
    type: "number",
    min: 0.01,
    required: true,
  },
  {
    key: "monthlyLimit",
    label: "每月消费限额（元）",
    type: "number",
    min: 0.01,
    required: true,
  },
];
export function Keys() {
  const config = useData("/auth/config");
  const modelDirectory = useData<Row>("/models");
  const availableModels: Row[] = modelDirectory.data?.catalog || [];
  const q = useData<Row[]>("/api-keys");
  const action = useAction();
  const [edit, setEdit] = useState<Row | null>(null),
    [secret, setSecret] = useState(""),
    [confirm, setConfirm] = useState<Row | null>(null);
  const notify = useContext(NotifyContext);
  return (
    <>
      <PageHead
        title="API 密钥"
        subtitle="独立站内密钥 · 仅首次创建或轮换时显示完整密钥"
        actions={
          <button
            className="primary"
            onClick={() =>
              setEdit({
                name: "",
                dailyLimit: config.data?.apiDailyLimit || 500,
                monthlyLimit: config.data?.apiMonthlyLimit || 5000,
                models: ["*"],
              })
            }
          >
            <Plus size={16} />
            创建密钥
          </button>
        }
      />
      <QueryState query={q}>
        <Table
          rows={q.data || []}
          columns={[
            { key: "name", title: "名称" },
            { key: "prefix", title: "密钥" },
            {
              key: "models",
              title: "允许模型",
              render: (r) => (
                <span className="key-model-scope">
                  {r.models?.includes("*")
                    ? "不限模型"
                    : (r.models || []).join("、")}
                </span>
              ),
            },
            {
              key: "status",
              title: "状态",
              render: (r) => (
                <Badge>
                  {r.revoked ? "已撤销" : r.disabled ? "已停用" : "可用"}
                </Badge>
              ),
            },
            {
              key: "daily_limit",
              title: "日 / 月限额",
              render: (r) =>
                `${money(r.daily_limit / 1e6)} / ${money(r.monthly_limit / 1e6)}`,
            },
            {
              key: "spent",
              title: "累计消费",
              render: (r) => money(r.spent / 1e6),
            },
            {
              key: "last_used",
              title: "最后使用",
              render: (r) => date(r.last_used),
            },
            {
              key: "action",
              title: "操作",
              render: (r) =>
                r.revoked ? (
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => api(`/api-keys/${r.id}`, { method: "DELETE" }),
                        "已删除撤销记录",
                      )
                    }
                  >
                    <Trash2 size={14} />
                    删除记录
                  </button>
                ) : (
                  <div className="actions">
                    <button
                      onClick={() =>
                        setEdit({
                          ...r,
                          dailyLimit: r.daily_limit / 1e6,
                          monthlyLimit: r.monthly_limit / 1e6,
                        })
                      }
                    >
                      编辑
                    </button>
                    <button
                      onClick={() =>
                        action.run(() =>
                          patch(`/api-keys/${r.id}`, { disabled: !r.disabled }),
                        )
                      }
                    >
                      {r.disabled ? "启用" : "停用"}
                    </button>
                    <button
                      onClick={() => setConfirm({ ...r, operation: "rotate" })}
                    >
                      轮换
                    </button>
                    <IconButton
                      title="撤销密钥"
                      onClick={() => setConfirm({ ...r, operation: "revoke" })}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                ),
            },
          ]}
        />
      </QueryState>
      <section className="section-band">
        <h2>接口调用</h2>
        <pre>{`POST ${location.origin}/api/v1/quotes\nAuthorization: Bearer <站内 API Key>\nContent-Type: application/json\n\n{"model":"wan3.0-video","mode":"text","input":{"prompt":"海面上的日出","media":[]},"parameters":{"resolution":"720P","duration":5}}\n\nPOST /api/v1/generations\nIdempotency-Key: <每次生成唯一的编号>\n{"input":<报价返回的 input>,"quoteToken":<报价返回的 token>}\n\nGET /api/v1/generations/<任务 ID>`}</pre>
      </section>
      <Modal
        title={edit?.id ? "编辑密钥" : "创建密钥"}
        open={!!edit}
        onClose={() => setEdit(null)}
      >
        {edit && (
          <EditForm
            initial={edit}
            fields={[
              ...keyFields,
              {
                key: "models",
                label: "允许调用的模型",
                type: "multiselect",
                required: true,
                allowCustom: true,
                options: availableModels.map(
                  (m: Row) =>
                    [
                      m.model,
                      `${m.display_name} · ${MODEL_TYPE_LABELS[m.type as ModelType] || m.type}`,
                    ] as [string, string],
                ),
                hint: "默认不限模型，包含以后新增的模型。可取消勾选后限制模型范围。",
              },
              ...(!edit.id
                ? [
                    {
                      key: "expiresAt",
                      label: "到期时间（可留空）",
                      type: "datetime-local",
                    } as Field,
                  ]
                : []),
            ]}
            busy={action.busy}
            onSubmit={(v) =>
              action.run(async () => {
                if (edit.id) await patch(`/api-keys/${edit.id}`, v);
                else {
                  const r = await post("/api-keys", {
                    ...v,
                    expiresAt: v.expiresAt
                      ? new Date(v.expiresAt).toISOString()
                      : null,
                  });
                  setSecret(r.key);
                }
                setEdit(null);
              })
            }
          />
        )}
      </Modal>
      <Modal
        title="保存 API 密钥"
        open={!!secret}
        onClose={() => setSecret("")}
      >
        <code className="secret">{secret}</code>
        <button
          onClick={() =>
            navigator.clipboard
              .writeText(secret)
              .then(() => notify("已复制密钥"))
          }
        >
          <Copy size={16} />
          复制密钥
        </button>
      </Modal>
      <Modal
        title={confirm?.operation === "rotate" ? "轮换密钥" : "撤销并删除密钥"}
        open={!!confirm}
        onClose={() => setConfirm(null)}
      >
        <p>
          {confirm?.operation === "revoke"
            ? "该密钥将立即从系统中删除并失效；历史任务与账单仍会保留。"
            : "轮换后原密钥会立即失效，新密钥只显示一次。"}
        </p>
        <button
          className="danger"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              if (confirm?.operation === "rotate") {
                const r = await post(`/api-keys/${confirm.id}/rotate`);
                setSecret(r.key);
              } else
                await api(`/api-keys/${confirm?.id}`, { method: "DELETE" });
              setConfirm(null);
            })
          }
        >
          确认
        </button>
      </Modal>
    </>
  );
}
const ledgerNames: Row = {
  reserve: "冻结",
  settle: "结算",
  release: "解冻",
  recharge: "充值",
  subscription: "订阅",
  deduction: "扣减",
  refund: "退款",
  withdrawal: "余额退款",
  reversal: "冲正",
};
export function WalletPage() {
  const q = useData("/wallet", 10000);
  const ledger = usePagedData("/ledger");
  const payment = useData<Row>("/payments/config");
  // Newer servers expose plans separately. Keep the config fallback for older deployments.
  const plansQuery = useData<Row[]>("/payments/plans", 30000);
  const orders = usePagedData("/payments/orders", 10000);
  const subscription = useData<Row | null>("/payments/subscription", 10000);
  const action = useAction();
  const [tab, setTab] = useState<"recharge" | "subscription">("recharge");
  const [amount, setAmount] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [created, setCreated] = useState<Row | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const enabled = !!payment.data?.enabled;
  const configuredPlans = Array.isArray(payment.data?.plans)
    ? payment.data.plans
    : Array.isArray(payment.data?.subscriptionPlans)
      ? payment.data.subscriptionPlans
      : [];
  const fallbackPlan = payment.data?.plan
    ? [{ id: "monthly", ...payment.data.plan }]
    : [];
  const plans: Row[] = (
    plansQuery.data?.length
      ? plansQuery.data
      : configuredPlans.length
        ? configuredPlans
        : fallbackPlan
  ).filter((plan: Row) => plan.enabled !== false && plan.active !== false);
  const selected = plans.find((plan) => plan.id === selectedPlan) || plans[0];
  const paymentType = payment.data?.paymentType || "alipay";
  const qrEnabled = payment.data?.qrEnabled !== false;
  const paymentTypeLabel: Row = {
    alipay: "支付宝",
    wxpay: "微信支付",
    qqpay: "QQ 钱包",
  };

  useEffect(() => {
    if (!created || created.status !== "pending") {
      setRemaining(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      const expires = created.expires_at
        ? new Date(created.expires_at).getTime()
        : 0;
      const seconds = expires
        ? Math.max(0, Math.ceil((expires - Date.now()) / 1000))
        : 0;
      if (alive) setRemaining(seconds);
      if (!alive || !created.id || seconds <= 0) return;
      try {
        const current = await post(`/payments/orders/${created.id}/check`);
        if (alive && current?.id === created.id) setCreated(current);
      } catch {
        // A transient query failure should not close the payment panel.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [created?.id, created?.status, created?.expires_at]);

  useEffect(() => {
    let alive = true;
    const source =
      qrEnabled && created
        ? created.qr_url ||
          created.qrcode_url ||
          created.qrCode ||
          created.qrcode ||
          created.qr_content ||
          created.pay_url ||
          created.payment_url ||
          created.checkout_url ||
          ""
        : "";
    if (!source || created?.status !== "pending") {
      setQrDataUrl("");
      return () => {
        alive = false;
      };
    }
    if (/^(data:image|blob:)/i.test(source)) {
      setQrDataUrl(source);
      return () => {
        alive = false;
      };
    }
    void QRCode.toDataURL(source, {
      width: 260,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#081517", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {
        if (alive) setQrDataUrl("");
      });
    return () => {
      alive = false;
    };
  }, [
    qrEnabled,
    created?.id,
    created?.status,
    created?.qr_url,
    created?.qrcode_url,
    created?.qrCode,
    created?.qrcode,
    created?.qr_content,
    created?.pay_url,
    created?.payment_url,
    created?.checkout_url,
  ]);

  const createOrder = (kind: "recharge" | "subscription", plan?: Row) =>
    action.run(async () => {
      const order = await post("/payments/orders", {
        kind,
        ...(kind === "recharge"
          ? { amount: Number(amount) }
          : { planId: plan?.id || selected?.id || "monthly" }),
      });
      setCreated(order);
      if (kind === "recharge") setAmount("");
      return order;
    }, "订单已创建");
  const checkOrder = (order: Row) =>
    action.run(async () => {
      const current = await post(`/payments/orders/${order.id}/check`);
      if (created?.id === order.id) setCreated(current);
    }, "订单状态已刷新");
  const cancelOrder = (order: Row) =>
    action.run(async () => {
      await post(`/payments/orders/${order.id}/cancel`);
      setCreated(null);
    }, "订单已取消");
  const quickAmounts = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const qrSource = created
    ? created.qr_url ||
      created.qrcode_url ||
      created.qrCode ||
      created.qrcode ||
      created.qr_content ||
      created.pay_url ||
      created.payment_url ||
      ""
    : "";
  const isQrImage =
    typeof qrSource === "string" && /^(data:image|blob:)/i.test(qrSource);
  const formatRemaining = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };
  return (
    <>
      <PageHead title="充值和订阅" subtitle="在线充值余额或开通订阅服务" />
      <QueryState query={q}>
        <div className="stats wallet-stats">
          <div>
            <span>可用余额</span>
            <strong>{money(q.data?.available)}</strong>
          </div>
          <div>
            <span>任务冻结</span>
            <strong>{money(q.data?.frozen)}</strong>
          </div>
        </div>
        <div className="wallet-tabs" role="tablist" aria-label="充值和订阅">
          <button
            role="tab"
            aria-selected={tab === "recharge"}
            className={tab === "recharge" ? "active" : ""}
            onClick={() => setTab("recharge")}
          >
            <Wallet size={16} />
            充值
          </button>
          <button
            role="tab"
            aria-selected={tab === "subscription"}
            className={tab === "subscription" ? "active" : ""}
            onClick={() => setTab("subscription")}
          >
            <Sparkles size={16} />
            订阅
          </button>
        </div>

        {!enabled && (
          <section className="wallet-notice" role="status">
            <CreditCard size={18} />
            <span>
              {payment.isPending
                ? "正在读取支付配置"
                : "在线支付暂未开启，请联系管理员"}
            </span>
          </section>
        )}

        {enabled && tab === "recharge" && (
          <div className="wallet-flow">
            <section className="wallet-card wallet-balance-card">
              <div>
                <span className="wallet-eyebrow">充值账户</span>
                <strong>当前余额 {money(q.data?.available)}</strong>
              </div>
              {subscription.data && (
                <Badge tone="teal">
                  订阅有效至 {date(subscription.data.ends_at)}
                </Badge>
              )}
            </section>
            <section className="wallet-card">
              <div className="wallet-card-heading">
                <div>
                  <h2>快捷金额</h2>
                  <p className="muted">选择常用金额，也可以输入自定义金额</p>
                </div>
                <Badge>{paymentTypeLabel[paymentType] || "在线支付"}</Badge>
              </div>
              <div className="wallet-quick-grid">
                {quickAmounts.map((value) => (
                  <button
                    type="button"
                    className={amount === String(value) ? "selected" : ""}
                    key={value}
                    onClick={() => setAmount(String(value))}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <label className="wallet-field">
                <span>自定义金额</span>
                <span className="wallet-input-prefix">
                  <span>¥</span>
                  <input
                    aria-label="充值金额（元）"
                    type="number"
                    min={payment.data?.minRecharge || 0.01}
                    max={payment.data?.maxRecharge || undefined}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={`最低 ${payment.data?.minRecharge ?? 1} 元`}
                  />
                </span>
              </label>
              <button
                className="primary wallet-submit"
                disabled={action.busy || !amount || Number(amount) <= 0}
                onClick={() => void createOrder("recharge")}
              >
                <CreditCard size={16} />
                确认支付 {amount && Number(amount) > 0 ? money(amount) : ""}
              </button>
            </section>
          </div>
        )}

        {enabled && tab === "subscription" && (
          <div className="wallet-flow">
            <section className="wallet-card wallet-balance-card">
              <div>
                <span className="wallet-eyebrow">当前账户</span>
                <strong>余额 {money(q.data?.available)}</strong>
              </div>
              <div className="wallet-active-subscription">
                {subscription.data ? (
                  <Badge tone="teal">
                    当前订阅有效至 {date(subscription.data.ends_at)}
                  </Badge>
                ) : (
                  <span className="muted">当前没有有效订阅</span>
                )}
              </div>
            </section>
            {!plans.length ? (
              <Empty text="暂无可用订阅套餐" />
            ) : (
              <div className="wallet-plan-grid">
                {plans.map((plan: Row) => {
                  const price = Number(plan.price ?? plan.sale_price ?? 0);
                  const original = Number(
                    plan.original_price ?? plan.originalPrice ?? 0,
                  );
                  const days = Number(
                    plan.valid_days ?? plan.validDays ?? plan.days ?? 30,
                  );
                  const quota =
                    plan.quota_month ?? plan.quota_week ?? plan.quota_day;
                  const features = Array.isArray(plan.features)
                    ? plan.features
                    : String(plan.features || "")
                        .split(/\r?\n/)
                        .filter(Boolean);
                  return (
                    <article
                      className="wallet-plan-card"
                      key={plan.id || plan.name}
                    >
                      <div className="wallet-plan-topline" />
                      <div className="wallet-plan-header">
                        <div>
                          <h2>{plan.name || "订阅套餐"}</h2>
                          <p>{plan.description || `${days} 天有效期`}</p>
                        </div>
                        <div className="wallet-plan-price">
                          <strong>{money(price)}</strong>
                          {original > price && <del>{money(original)}</del>}
                          <small>/ {days} 天</small>
                        </div>
                      </div>
                      {quota !== undefined && quota !== null && (
                        <div className="wallet-plan-quota">
                          <span>
                            {plan.quota_month !== undefined
                              ? "月额度"
                              : plan.quota_week !== undefined
                                ? "周额度"
                                : "日额度"}
                          </span>
                          <strong>{quota}</strong>
                        </div>
                      )}
                      <ul className="wallet-plan-features">
                        {(features.length
                          ? features
                          : [
                              "到期自动停止，不影响已有任务",
                              "续费不重置额度，按有效期延长",
                            ]
                        ).map((feature: string) => (
                          <li key={feature}>
                            <Check size={15} />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      <button
                        className="primary wallet-submit"
                        disabled={action.busy}
                        onClick={() => {
                          setSelectedPlan(plan.id || null);
                          void createOrder("subscription", plan);
                        }}
                      >
                        <CircleDollarSign size={16} />
                        立即开通
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {created && (
          <section
            className={`wallet-payment-state ${created.status}`}
            aria-live="polite"
          >
            <div className="wallet-payment-header">
              <div>
                <span className="wallet-eyebrow">
                  {created.kind === "subscription" ? "订阅订单" : "充值订单"}
                </span>
                <h2>{created.subject || "在线支付"}</h2>
                <p className="muted">
                  订单号 {created.order_no} · {money(created.amount)}
                </p>
              </div>
              {created.status === "pending" && (
                <Badge>
                  <Clock3 size={14} /> 待支付
                </Badge>
              )}
              {created.status === "paid" && (
                <Badge tone="teal">
                  <CheckCircle2 size={14} /> 已支付
                </Badge>
              )}
              {created.status === "expired" && (
                <Badge>
                  <XCircle size={14} /> 已过期
                </Badge>
              )}
              {(created.status === "cancelled" ||
                created.status === "canceled") && (
                <Badge>
                  <XCircle size={14} /> 已取消
                </Badge>
              )}
            </div>
            {created.status === "pending" && remaining > 0 && (
              <>
                <div className="wallet-qr-panel">
                  <h3>扫码支付</h3>
                  {qrEnabled && (isQrImage || qrDataUrl) ? (
                    <img
                      className="wallet-qr"
                      src={isQrImage ? qrSource : qrDataUrl}
                      alt="支付二维码"
                    />
                  ) : (
                    <div className="wallet-qr-placeholder">
                      <QrCode size={42} />
                      <span>
                        {qrEnabled ? "支付二维码生成中" : "二维码支付已关闭"}
                      </span>
                    </div>
                  )}
                  <p className="muted">
                    请使用手机打开{paymentTypeLabel[paymentType] || "支付应用"}
                    完成支付
                  </p>
                </div>
                <div className="wallet-countdown">
                  <span>剩余支付时间</span>
                  <strong>{formatRemaining(remaining)}</strong>
                  <small>等待支付状态确认</small>
                </div>
                <div className="wallet-payment-actions">
                  <button
                    onClick={() => void checkOrder(created)}
                    disabled={action.busy}
                  >
                    <RefreshCw size={15} /> 刷新支付状态
                  </button>
                  <button
                    onClick={() => void cancelOrder(created)}
                    disabled={action.busy}
                  >
                    取消订单
                  </button>
                </div>
              </>
            )}
            {created.status === "pending" && remaining <= 0 && (
              <p className="wallet-state-copy">订单已过期，请重新创建订单。</p>
            )}
            {created.status === "paid" && (
              <p className="wallet-state-copy success">
                支付成功，余额或订阅权益已到账。
              </p>
            )}
            {(created.status === "expired" ||
              created.status === "cancelled" ||
              created.status === "canceled") && (
              <p className="wallet-state-copy">该订单已结束。</p>
            )}
          </section>
        )}
        <QueryState query={orders}>
          {!!orders.data?.length && (
            <section className="section-band wallet-orders">
              <h2>支付订单</h2>
              {orders.data.map((order: Row) => (
                <div className="list-row" key={order.id}>
                  <span>
                    {date(order.created_at)} · {order.subject}
                  </span>
                  <strong>{money(order.amount)}</strong>
                  <Badge tone={order.status === "paid" ? "teal" : undefined}>
                    {order.status === "paid"
                      ? "已支付"
                      : order.status === "pending"
                        ? "待支付"
                        : order.status}
                  </Badge>
                  {order.status === "pending" && (
                    <>
                      <button onClick={() => setCreated(order)}>
                        继续支付
                      </button>
                      <button
                        disabled={action.busy}
                        onClick={() => void checkOrder(order)}
                      >
                        刷新状态
                      </button>
                    </>
                  )}
                </div>
              ))}
              <MoreRecords query={orders} />
            </section>
          )}
        </QueryState>
        <div className="wallet-ledger">
          <QueryState query={ledger}>
            <Table
              rows={ledger.data || []}
              filename="钱包流水"
              partial={ledger.hasNextPage}
              columns={[
                {
                  key: "created_at",
                  title: "时间",
                  render: (r) => date(r.created_at),
                },
                {
                  key: "type",
                  title: "类型",
                  render: (r) => ledgerNames[r.type] || r.type,
                },
                {
                  key: "amount",
                  title: "可用余额变动",
                  render: (r) => (
                    <span className={r.amount > 0 ? "positive" : ""}>
                      {r.amount > 0 ? "+" : ""}
                      {money(r.amount / 1e6)}
                    </span>
                  ),
                },
                {
                  key: "frozen_delta",
                  title: "冻结变动",
                  render: (r) => money(r.frozen_delta / 1e6),
                },
                {
                  key: "available_after",
                  title: "可用余额",
                  render: (r) => money(r.available_after / 1e6),
                },
                { key: "reason", title: "摘要" },
              ]}
            />
            <MoreRecords query={ledger} />
          </QueryState>
        </div>
      </QueryState>
    </>
  );
}
export function News() {
  const a = useData<Row[]>("/announcements");
  const n = useData<Row[]>("/notifications");
  const action = useAction();
  const [tab, setTab] = useState("announcements");
  return (
    <>
      <PageHead
        title="公告与通知"
        actions={
          <button onClick={() => action.run(() => post("/notifications/read"))}>
            <Check size={16} />
            通知全部已读
          </button>
        }
      />
      <div className="tabs">
        <button
          className={tab === "announcements" ? "active" : ""}
          onClick={() => setTab("announcements")}
        >
          网站公告
        </button>
        <button
          className={tab === "notifications" ? "active" : ""}
          onClick={() => setTab("notifications")}
        >
          个人通知
        </button>
      </div>
      <QueryState query={tab === "announcements" ? a : n}>
        {!(tab === "announcements" ? a.data : n.data)?.length ? (
          <Empty />
        ) : (
          (tab === "announcements" ? a.data : n.data)?.map((r) => (
            <article className="news-item" key={r.id}>
              <div className="actions">
                <h2>{r.title}</h2>
                {r.pinned && <Badge>置顶</Badge>}
                {r.level === "important" && <Badge tone="amber">重要</Badge>}
                <span className="grow" />
                <small>{date(r.starts_at || r.created_at)}</small>
              </div>
              <Markdown source={r.body} />
              {tab === "announcements" && r.read_version !== r.version && (
                <button
                  onClick={() =>
                    action.run(() => post(`/announcements/${r.id}/read`))
                  }
                >
                  标记已读
                </button>
              )}
              {tab === "notifications" && r.title.includes("素材") && (
                <Link to="/assets">前往资产库</Link>
              )}
            </article>
          ))
        )}
      </QueryState>
    </>
  );
}
export function Account({ user }: { user: Row }) {
  const sessions = useData<Row[]>("/auth/sessions");
  const action = useAction();
  const navigate = useNavigate();
  return (
    <>
      <PageHead title="账号设置" />
      <div className="settings-columns">
        <section>
          <h2>个人资料</h2>
          <p className="muted">
            账号：{user.username} · {user.email || "未设置邮箱"}
          </p>
          <EditForm
            fields={[
              { key: "display_name", label: "显示名称", required: true },
            ]}
            initial={user}
            busy={action.busy}
            onSubmit={(v) =>
              action.run(
                () => patch("/auth/profile", { display_name: v.display_name }),
                "已保存",
              )
            }
          />
        </section>
        <section>
          <h2>修改密码</h2>
          <EditForm
            fields={[
              {
                key: "current",
                label: "当前密码",
                type: "password",
                required: true,
              },
              {
                key: "password",
                label: "新密码（至少 8 位）",
                type: "password",
                required: true,
              },
            ]}
            busy={action.busy}
            onSubmit={(v) =>
              action.run(async () => {
                await post("/auth/password", v);
                navigate("/login");
              }, "密码已修改，请重新登录")
            }
          />
        </section>
      </div>
      <section className="section-band">
        <h2>登录设备</h2>
        <Table
          rows={sessions.data || []}
          columns={[
            { key: "user_agent", title: "设备" },
            {
              key: "created_at",
              title: "登录时间",
              render: (r) => date(r.created_at),
            },
            {
              key: "expires_at",
              title: "到期时间",
              render: (r) => date(r.expires_at),
            },
            {
              key: "action",
              title: "",
              render: (r) => (
                <button
                  onClick={() =>
                    action.run(
                      () => api(`/auth/sessions/${r.id}`, { method: "DELETE" }),
                      "会话已退出",
                    )
                  }
                >
                  退出此设备
                </button>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
