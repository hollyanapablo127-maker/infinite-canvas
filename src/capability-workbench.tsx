import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  Boxes,
  Sparkles,
  Play,
  Square,
  Download,
  FileAudio,
  Globe2,
  Box,
  Video,
  MessageSquare,
  Image as ImageIcon,
  RefreshCw,
  Plus,
  Trash2,
} from "lucide-react";
import {
  api,
  post,
  useData,
  useAction,
  Modal,
  money,
  QueryState,
  Badge,
  PageHead,
  type Row,
} from "./lib";
import { PROTOCOLS, type ProtocolId } from "../shared/protocols";
import { MODEL_TYPE_LABELS, type ModelType } from "../shared/catalog";
const WorldPlayer = lazy(() =>
  import("./live-capabilities").then((m) => ({ default: m.WorldPlayer })),
);
const RealtimeSession = lazy(() =>
  import("./live-capabilities").then((m) => ({ default: m.RealtimeSession })),
);
let viewerPromise: Promise<unknown> | undefined;
function ModelViewer({ url }: { url: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    viewerPromise ||= import("@google/model-viewer");
    void viewerPromise.then(() => setLoaded(true));
  }, []);
  return loaded ? (
    <div className="three-preview">
      {/* web component is initialized by the vendor module */}
      {(() => {
        const Tag = "model-viewer" as any;
        return (
          <Tag
            src={url}
            camera-controls
            auto-rotate
            shadow-intensity="1"
            alt="生成的3D模型，可拖动旋转"
            style={{ width: "100%", height: 330, background: "transparent" }}
          />
        );
      })()}
    </div>
  ) : (
    <p role="status">载入 3D 预览…</p>
  );
}
export function CapabilityOutput({
  job,
  onRefresh,
  live = true,
}: {
  job: Row;
  onRefresh: () => void;
  live?: boolean;
}) {
  const output = job.output || {};
  return (
    <div className="capability-output">
      {output.text && <pre className="capability-text">{output.text}</pre>}
      {(output.files || []).map((f: Row) => (
        <section key={f.id} className="capability-file">
          {f.kind === "audio" ? (
            <audio controls src={f.url} />
          ) : f.kind === "video" ? (
            <video controls src={f.url} />
          ) : f.kind === "image" ? (
            <img src={f.url} alt="生成产物预览" />
          ) : f.kind === "model" ? (
            <ModelViewer url={f.url} />
          ) : null}
          <a className="button" href={f.url} download={f.name}>
            <Download size={14} />
            {f.name}
          </a>
        </section>
      ))}
      {live &&
        job.protocol === "happyoyster" &&
        ["READY", "CONNECTING", "LIVE"].includes(job.status) && (
          <Suspense fallback={<p>准备世界播放器…</p>}>
            <WorldPlayer job={job} onRefresh={onRefresh} />
          </Suspense>
        )}
      {live &&
        ["bailian-realtime", "bailian-inference"].includes(job.protocol) &&
        ["READY", "LIVE", "CONNECTING"].includes(job.status) && (
          <Suspense fallback={<p>准备实时交互…</p>}>
            <RealtimeSession job={job} onRefresh={onRefresh} />
          </Suspense>
        )}
      {job.error && (
        <p className="error-box" role="alert">
          {job.error}
          {["UNKNOWN", "RECONCILE"].includes(job.status) &&
            "。预算仍保留，请联系管理员核实后处理，避免重复提交。"}
        </p>
      )}
    </div>
  );
}
const STATUS: Row = {
  QUEUED: "等待处理",
  SUBMITTING: "请求已提交",
  PENDING: "上游处理中",
  RUNNING: "正在生成",
  READY: "已就绪",
  LIVE: "实时会话中",
  CONNECTING: "连接中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELED: "已取消",
  UNKNOWN: "状态待核实",
  RECONCILE: "账单待核对",
};
export function CapabilityPanel({
  data,
  onUpdate,
  projectId,
  nodeId,
  boundPrompt,
  boundReferences = [],
}: {
  data: Row;
  onUpdate: (v: Row) => void;
  projectId?: string;
  nodeId?: string;
  boundPrompt?: string;
  boundReferences?: Row[];
}) {
  const cache = useQueryClient();
  const catalog = useData<Row>("/models"),
    action = useAction();
  const models: Row[] = (catalog.data?.catalog || []).filter(
    (m: Row) =>
      m.enabled &&
      m.type !== "image" &&
      m.channels.some((c: Row) => c.source === "bailian"),
  );
  const selected = data.model
    ? models.find((m) => m.model === data.model)
    : models[0];
  const [referenceKind, setReferenceKind] = useState("image");
  const [quote, setQuote] = useState<Row | null>(null),
    [reference, setReference] = useState(""),
    [lastError, setLastError] = useState("");
  const [jobId, setJobId] = useState<string | undefined>(data.capabilityJobId);
  const jobQuery = useData<Row>(`/capabilities/${jobId}`, 1500, !!jobId);
  const job = jobQuery.data;
  useEffect(() => {
    if (
      job &&
      ["SUCCEEDED", "FAILED", "CANCELED", "RECONCILE", "UNKNOWN"].includes(
        job.status,
      )
    ) {
      void cache.invalidateQueries({ queryKey: ["/capabilities"] });
      void cache.invalidateQueries({ queryKey: ["/auth/me"] });
      void cache.invalidateQueries({ queryKey: ["/wallet"] });
    }
  }, [job?.id, job?.status, cache]);

  const protocol = (selected?.protocol || "openai-chat") as ProtocolId;
  const parameters = data.parameters || {};
  const active =
    job &&
    [
      "QUEUED",
      "PENDING",
      "RUNNING",
      "SUBMITTING",
      "CONNECTING",
      "LIVE",
    ].includes(job.status);
  const updateParam = (value: Row) =>
    onUpdate({ parameters: { ...parameters, ...value } });
  const refs: Row[] = data.references || [];
  const input = () => ({
    model: selected?.model,
    prompt: boundPrompt ?? data.prompt ?? "",
    references: [...refs, ...boundReferences],
    parameters: {
      ...(protocol === "happyoyster" ? { max_seconds: 60 } : {}),
      ...parameters,
    },
    ...(projectId ? { project_id: projectId } : {}),
    ...(nodeId ? { node_id: nodeId } : {}),
  });
  const run = () =>
    void action.run(async () => {
      setLastError("");
      const body = input();
      const q = await post("/capabilities/quote", body);
      setQuote({ ...q, body, request_key: crypto.randomUUID() });
    });
  useEffect(() => {
    if (jobId !== data.capabilityJobId) setJobId(data.capabilityJobId);
  }, [data.capabilityJobId]);
  return (
    <div className="capability-panel">
      <QueryState query={catalog}>
        <label className="field">
          模型
          <select
            aria-label="多模态模型"
            value={selected?.model || data.model || ""}
            onChange={(e) => {
              const m = models.find((m) => m.model === e.target.value)!;
              onUpdate({
                model: m.model,
                parameters: {
                  max_seconds: 60,
                  ...(m.type === "video"
                    ? { duration: 5, resolution: "1080P" }
                    : m.type === "world"
                      ? { resolution: "480p" }
                      : {}),
                },
                capabilityJobId: undefined,
              });
              setJobId(undefined);
            }}
          >
            {!selected && data.model && (
              <option value={data.model} disabled>
                {data.model} · 已下架，请主动重新选择
              </option>
            )}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.display_name} · {MODEL_TYPE_LABELS[m.type as ModelType]}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <div className="protocol-note">
            <Badge>{MODEL_TYPE_LABELS[selected.type as ModelType]}</Badge>
            <span>{PROTOCOLS[protocol]?.label}</span>
            <small>{PROTOCOLS[protocol]?.transport.toUpperCase()}</small>
          </div>
        )}
        {!models.length && (
          <div className="notice">
            请先在渠道管理配置百炼连接，再在模型定价中发布对应能力模型。
          </div>
        )}
        <label className="field">
          {protocol === "bailian-tts" ? "合成文本" : "提示词 / 对话输入"}
          <textarea
            aria-label="多模态提示词"
            rows={4}
            value={boundPrompt ?? data.prompt ?? ""}
            readOnly={boundPrompt !== undefined}
            maxLength={
              protocol === "bailian-3d"
                ? 1024
                : protocol === "bailian-tts"
                  ? 600
                  : 16000
            }
            onChange={(e) => onUpdate({ prompt: e.target.value })}
            placeholder="描述画面、声音、世界，或提出问题…"
          />
        </label>
        {!["bailian-realtime", "bailian-inference", "bailian-tts"].includes(
          protocol,
        ) && (
          <div className="capability-references">
            <label className="field">
              参考素材（公网 URL）
              <div className="inline-add">
                <select
                  aria-label="参考素材类型"
                  value={referenceKind}
                  style={{ width: 92, flexShrink: 0 }}
                  onChange={(e) => setReferenceKind(e.target.value)}
                >
                  <option value="image">图片</option>
                  <option value="audio">音频</option>
                  <option value="video">视频</option>
                </select>
                <input
                  aria-label="多模态参考URL"
                  type="url"
                  placeholder="https://… 图片、音频或视频"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
                <button
                  disabled={
                    !reference.trim() ||
                    refs.length + boundReferences.length >= 4
                  }
                  onClick={() => {
                    onUpdate({
                      references: [
                        ...refs,
                        {
                          url: reference.trim(),
                          kind: [
                            "bailian-asr",
                            "bailian-asr-chat",
                            "bailian-audio",
                          ].includes(protocol)
                            ? "audio"
                            : referenceKind,
                        },
                      ],
                    });
                    setReference("");
                  }}
                >
                  <Plus size={15} />
                  添加
                </button>
              </div>
            </label>
            <small className="muted">
              也可从画布连接图片／音频素材节点。私有素材会通过本站签名地址提供给上游。
            </small>
            {boundReferences.length > 0 && (
              <small className="connected-input">
                已从画布连线读取 {boundReferences.length}{" "}
                份素材；断开连线后会自动移除。
              </small>
            )}
            {refs.map((r, index) => (
              <div className="reference-item" key={index}>
                <span>{r.url || r.asset_id}</span>
                <button
                  aria-label={`删除参考素材 ${index + 1}`}
                  onClick={() =>
                    onUpdate({ references: refs.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {[
          "bailian-tts",
          "bailian-audio",
          "bailian-inference",
          "bailian-realtime",
        ].includes(protocol) && (
          <label className="field">
            音色
            <input
              aria-label="合成音色"
              value={parameters.voice || ""}
              placeholder={
                protocol === "bailian-inference" ? "longanyang" : "Cherry"
              }
              onChange={(e) => updateParam({ voice: e.target.value })}
            />
            <small>按模型文档填写支持的音色。</small>
          </label>
        )}
        {protocol === "bailian-inference" && (
          <label className="field">
            实时模式
            <select
              aria-label="实时语音模式"
              value={parameters.mode || "tts"}
              onChange={(e) => updateParam({ mode: e.target.value })}
            >
              <option value="tts">流式语音合成</option>
              <option value="asr">实时语音识别</option>
            </select>
          </label>
        )}
        {protocol === "bailian-realtime" && (
          <label className="field">
            交互方式
            <select
              aria-label="实时交互方式"
              value={parameters.mode || "manual"}
              onChange={(e) => updateParam({ mode: e.target.value })}
            >
              <option value="manual">手动提交音频</option>
              <option value="vad">自动语音检测</option>
            </select>
          </label>
        )}
        {["bailian-video", "happyoyster"].includes(protocol) && (
          <div className="two-fields">
            <label className="field">
              分辨率
              <select
                aria-label="多模态分辨率"
                value={
                  parameters.resolution ||
                  (protocol === "happyoyster" ? "480p" : "1080P")
                }
                onChange={(e) => updateParam({ resolution: e.target.value })}
              >
                {(protocol === "happyoyster"
                  ? ["480p", "720p"]
                  : ["480P", "720P", "1080P"]
                ).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            {protocol === "bailian-video" ? (
              <label className="field">
                视频时长（秒）
                <input
                  aria-label="多模态视频时长"
                  type="number"
                  min={2}
                  max={30}
                  value={parameters.duration || 5}
                  onChange={(e) =>
                    updateParam({ duration: Number(e.target.value) })
                  }
                />
              </label>
            ) : (
              <label className="field">
                体验时长
                <select
                  aria-label="世界体验时长"
                  value={parameters.max_seconds || 60}
                  onChange={(e) =>
                    updateParam({ max_seconds: Number(e.target.value) })
                  }
                >
                  {[60, 90, 120].map((n) => (
                    <option key={n} value={n}>
                      {n} 秒
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {protocol === "bailian-3d" && (
          <div className="two-fields">
            <label className="field">
              贴图质量
              <select
                value={parameters.texture_quality || "standard"}
                onChange={(e) =>
                  updateParam({ texture_quality: e.target.value })
                }
              >
                <option value="standard">标准</option>
                <option value="detailed">精细</option>
              </select>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={parameters.pbr !== false}
                onChange={(e) => updateParam({ pbr: e.target.checked })}
              />
              PBR 材质
            </label>
          </div>
        )}
        {(protocol === "bailian-asr" ||
          protocol === "bailian-asr-chat" ||
          protocol === "bailian-audio" ||
          protocol === "bailian-realtime" ||
          protocol === "bailian-inference") && (
          <label className="field">
            预算时长上限（秒）
            <input
              aria-label="多模态预算时长"
              type="number"
              min={1}
              max={
                protocol.includes("realtime") || protocol.includes("inference")
                  ? 120
                  : 3600
              }
              value={parameters.max_seconds || 60}
              onChange={(e) =>
                updateParam({ max_seconds: Number(e.target.value) })
              }
            />
            <small>
              按上限预占预算，返回后按实际用量结算；超出预算需核对。
            </small>
          </label>
        )}
        <button
          className="primary capability-run"
          disabled={action.busy || active || !selected}
          onClick={run}
        >
          <Sparkles size={17} />
          {action.busy
            ? "获取报价…"
            : active
              ? STATUS[job!.status]
              : "开始创作"}
        </button>
        {job && (
          <div className="capability-result">
            <header>
              <Badge tone={job.status === "SUCCEEDED" ? "teal" : "neutral"}>
                {STATUS[job.status] || job.status}
              </Badge>
              <small>
                {job.charged
                  ? `已消费 ${money(job.charged)}`
                  : `预占 ${money(job.reserved)}`}
              </small>
              {["QUEUED", "READY"].includes(job.status) && (
                <button
                  onClick={() =>
                    void action.run(async () => {
                      await post(`/capabilities/${job.id}/cancel`);
                      await jobQuery.refetch();
                    }, "任务已取消")
                  }
                >
                  <Square size={12} />
                  取消
                </button>
              )}
            </header>
            <CapabilityOutput
              job={job}
              onRefresh={() => void jobQuery.refetch()}
            />
            {active && !job.output?.text && (
              <div className="stream-state" role="status">
                请求处理中，结果会自动出现，请勿重复提交。
              </div>
            )}
          </div>
        )}
        {lastError && <p className="error-box">{lastError}</p>}
      </QueryState>
      <Modal
        title="确认多模态创作预算"
        open={!!quote}
        onClose={() => setQuote(null)}
      >
        {quote && (
          <>
            <p>模型 {selected?.display_name}</p>
            <div className="quote-total">
              <span>本次最多预占</span>
              <strong>{money(quote.reserved)}</strong>
            </div>
            <p className="muted">
              已应用专属倍率 {quote.multiplier}
              ×。上游任务可能耗时较长，费用按任务快照结算，失败按结果退回未使用预算。
            </p>
            <button
              className="primary full"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const j = await post("/capabilities", {
                    ...quote.body,
                    quoteToken: quote.token,
                    request_key: quote.request_key,
                  });
                  setJobId(j.id);
                  onUpdate({ capabilityJobId: j.id });
                  setQuote(null);
                }, "任务已创建")
              }
            >
              <Play size={16} />
              确认并提交
            </button>
          </>
        )}
      </Modal>
    </div>
  );
}
// 多模态工作台暂时下线：入口隐藏，/studio 回落到我的画布。改回 true 即可恢复。
export const WORKBENCH_ENABLED = false;
export function CapabilityWorkbench() {
  const [params] = useSearchParams();
  const [data, setData] = useState<Row>({
    model: params.get("model") || "",
    prompt: "",
    parameters: { max_seconds: 60 },
  });
  const history = useData<Row[]>("/capabilities", 5000);
  return (
    <>
      <PageHead
        title="多模态工作台"
        subtitle="语言、音频、3D、世界与实时交互，让想象跨越媒介。"
      />
      <div className="capability-workbench">
        <section className="workbench-input glass-panel">
          <div className="form-section-title">
            <Boxes size={19} />
            选择能力，开始创作
          </div>
          <CapabilityPanel
            data={data}
            onUpdate={(value) => setData((v) => ({ ...v, ...value }))}
          />
        </section>
        <section className="workbench-history">
          <h2>
            最近的创作 <small>{history.data?.length || 0}</small>
          </h2>
          {(history.data || []).map((j) => (
            <details
              className="capability-history-item"
              key={j.id}
              open={j.id === data.capabilityJobId}
            >
              <summary>
                <span>{j.model}</span>
                <Badge>{STATUS[j.status] || j.status}</Badge>
                <small>{money(j.charged || j.reserved)}</small>
              </summary>
              <CapabilityOutput
                job={j}
                live={false}
                onRefresh={() => void history.refetch()}
              />
              {["READY", "LIVE", "CONNECTING"].includes(j.status) && (
                <button
                  onClick={() =>
                    setData({
                      model: j.model,
                      prompt: j.prompt || "",
                      parameters: j.parameters,
                      capabilityJobId: j.id,
                    })
                  }
                >
                  回到此任务
                </button>
              )}
            </details>
          ))}
          {!history.data?.length && (
            <div className="empty">
              <Sparkles size={28} />
              <p>你的下一段灵感，会从这里开始。</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
