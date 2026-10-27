import {
  useState,
  useEffect,
  useRef,
  useContext,
  createContext,
  useCallback,
} from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { get, set, del, update as updateDraft } from "idb-keyval";
import {
  Plus,
  Video,
  Image,
  StickyNote,
  Type,
  Play,
  WandSparkles,
  X,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Copy,
  Trash2,
  Undo2,
  Redo2,
  LayoutGrid,
  Group,
  History,
  Download,
  GitBranch,
  Maximize,
  Save,
  PanelRightClose,
  PanelRightOpen,
  Scissors,
  Expand,
  LoaderCircle,
  Check,
  ImagePlus,
  Settings2,
  ArrowRight,
  Boxes,
} from "lucide-react";
import {
  api,
  post,
  patch,
  useData,
  useAction,
  uid,
  money,
  date,
  Modal,
  IconButton,
  Empty,
  EditForm,
  QueryState,
  NotifyContext,
  downloadBlob,
  type Row,
} from "./lib";
import { Assets, newGenerationPair, TaskDetail } from "./pages";
import {
  MODEL_IDS,
  RESOLUTIONS,
  RATIOS,
  MODES,
  MEDIA_LABELS,
  MEDIA_LIMITS,
  MEDIA_TYPES,
  DEFAULT_PARAMETERS,
  STATUS_LABELS,
  mediaReferenceLabels,
  type Media,
} from "../shared/wan";
import {
  MODE_PORTS,
  allowedPorts,
  checkInputs,
  effectiveMode,
  incomingBindings,
  kindForPort,
  portIssue,
  referenceName,
  resolvePort,
  type Port,
} from "./canvas-graph";
import {
  IMAGE_MODE_PORTS,
  allowedImagePorts,
  checkImageInputs,
  imageKindForPort,
  imagePortIssue,
  incomingImageBindings,
  resolveImagePort,
  type ImagePort,
  type ImageGraphNode,
} from "./canvas-image-graph";
import {
  DEFAULT_IMAGE_PARAMETERS,
  IMAGE_MODEL_IDS,
  IMAGE_STATUS_LABELS,
  MODEL_CAPABILITIES,
  SIZE_PRESETS,
} from "../shared/image";

type CanvasNode = Node<Row>;
const NodeActions = createContext<(id: string, action: string) => void>(
  () => {},
);
const AssetContext = createContext<Record<string, Row>>({});
const AssetNames = createContext<Record<string, string>>({});
const PreviewSources = createContext<
  Record<string, { id: string; kind: string } | undefined>
>({});
const pendingCanvasSaves = new Map<string, Promise<void>>();

// React Flow caches handle bounds. Refresh them after a custom node's handle
// list or layout changes without changing the persisted graph data.
function useHandleRefresh(id: string, signature: string) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(frame);
  }, [id, signature, updateNodeInternals]);
}
// PostgreSQL JSONB reorders keys; draft equality must ignore object key order.
function contentSignature(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

const generationInputPorts = new Set<Port>(Object.values(MODE_PORTS).flat());

function sourceHandleFor(node: CanvasNode | undefined, handle?: string | null) {
  if (!node) return handle || undefined;
  if (node.type === "generation") return "video";
  if (node.type === "image") return "image";
  if (node.type === "asset") return "asset";
  if (node.type === "text") return "text";
  return handle || undefined;
}

function targetHandleFor(
  edge: Edge,
  source: CanvasNode | undefined,
  target: CanvasNode | undefined,
  used: Port[],
) {
  const explicit = edge.targetHandle || undefined;
  if (!target) return explicit;
  if (target.type === "preview")
    return explicit === "preview" ? explicit : "preview";
  if (target.type !== "generation") return explicit;
  if (!source) return explicit;

  const modePorts = MODE_PORTS[target.data.mode] || MODE_PORTS.text;
  if (explicit && modePorts.includes(explicit as Port)) {
    if (source.type === "text")
      return explicit === "prompt" ? explicit : undefined;
    if (source.type === "generation") return explicit;
    if (
      source.type === "asset" &&
      kindForPort(explicit as Port) === source.data.kind
    )
      return explicit;
  }
  return resolvePort(
    { ...edge, targetHandle: undefined },
    source,
    target,
    used,
  );
}

function targetImageHandleFor(
  edge: Edge,
  source: CanvasNode | undefined,
  target: CanvasNode,
  used: ImagePort[],
): ImagePort {
  const graphTarget = target as unknown as ImageGraphNode;
  const graphSource = source as unknown as ImageGraphNode | undefined;
  const explicit = edge.targetHandle as ImagePort | null | undefined;
  const ports = IMAGE_MODE_PORTS[target.data.mode] || IMAGE_MODE_PORTS.text;
  if (explicit && ports.includes(explicit) && graphSource) {
    const kind =
      graphSource.type === "text"
        ? "text"
        : graphSource.type === "image" ||
            (graphSource.type === "asset" && graphSource.data.kind === "image")
          ? "image"
          : "invalid";
    if (imageKindForPort(explicit) === kind) return explicit;
  }
  if (!graphSource) return explicit || "prompt";
  return resolveImagePort(
    { ...edge, targetHandle: undefined },
    graphSource,
    graphTarget,
    used,
  );
}

/**
 * Add the handle ids introduced after the first canvas format was shipped.
 * React Flow can still render edges without these fields, but it cannot route
 * them reliably once a node has more than one input or output handle.
 */
export function normalizeCanvasEdges(
  nodes: CanvasNode[],
  edges: Edge[],
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const usedByTarget = new Map<string, Port[]>();
  const usedImagesByTarget = new Map<string, ImagePort[]>();
  for (const node of nodes) {
    if (node.type === "generation")
      usedByTarget.set(
        node.id,
        (node.data.media || []).map((media: Media) => media.type as Port),
      );
    if (node.type === "image")
      usedImagesByTarget.set(
        node.id,
        (node.data.images || []).map(() => "reference_image" as ImagePort),
      );
  }
  return edges.map((edge, index) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const used = usedByTarget.get(edge.target) || [];
    const imageUsed = usedImagesByTarget.get(edge.target) || [];
    const targetHandle =
      target?.type === "image"
        ? targetImageHandleFor(edge, source, target, imageUsed)
        : targetHandleFor(edge, source, target, used);
    if (
      target?.type === "generation" &&
      targetHandle &&
      generationInputPorts.has(targetHandle as Port)
    )
      used.push(targetHandle as Port);
    if (target?.type === "generation") usedByTarget.set(target.id, used);
    if (target?.type === "image" && targetHandle)
      imageUsed.push(targetHandle as ImagePort);
    if (target?.type === "image") usedImagesByTarget.set(target.id, imageUsed);
    return {
      ...edge,
      id: edge.id || `edge-${edge.source}-${edge.target}-${index}`,
      sourceHandle: sourceHandleFor(source, edge.sourceHandle),
      targetHandle,
    };
  });
}

function CanvasMedia({
  id,
  kind,
  name,
}: {
  id: string;
  kind: string;
  name?: string;
}) {
  const assets = useContext(AssetContext);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  const unavailable = failed || assets[id]?.expired || assets[id]?.deleted_at;
  if (unavailable)
    return (
      <div className="media-placeholder">
        <Image size={26} />
        <span>素材已到期或不可用</span>
      </div>
    );
  const url = `/api/v1/assets/${id}/content`;
  if (kind === "image")
    return (
      <img src={url} alt={name || "参考素材"} onError={() => setFailed(true)} />
    );
  if (kind === "video")
    return (
      <video
        className="nodrag"
        controls
        preload="metadata"
        src={url}
        onError={() => setFailed(true)}
      />
    );
  if (kind === "audio")
    return (
      <audio
        className="nodrag"
        controls
        src={url}
        onError={() => setFailed(true)}
      />
    );
  return (
    <div className="media-placeholder">
      <Image size={26} />
      <span>{kind}</span>
    </div>
  );
}
function GenerationNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const act = useContext(NodeActions);
  const ports = MODE_PORTS[data.mode] || MODE_PORTS.text;
  useHandleRefresh(id, ports.join("|"));
  return (
    <div
      className={`canvas-node generation-node ${selected ? "selected" : ""}`}
    >
      <div className="node-head">
        <Video size={16} />
        <strong>{data.label}</strong>
        <span className="grow" />
        <BadgeStatus status={data.status} />
      </div>
      <div className="generation-content">
        <div className="node-ports" aria-label="生成输入">
          {ports.map((port) => (
            <div className="node-port" key={port}>
              <Handle
                id={port}
                type="target"
                position={Position.Left}
                title={port === "prompt" ? "文本" : MEDIA_LABELS[port]}
              />
              <span>{port === "prompt" ? "文本" : MEDIA_LABELS[port]}</span>
              <small>{port === "prompt" ? "1" : MEDIA_LIMITS[port]}</small>
            </div>
          ))}
        </div>
        <div className="generation-main">
          <div className="node-preview">
            {data.result_asset_id ? (
              <CanvasMedia id={data.result_asset_id} kind="video" />
            ) : (
              <div className="generation-placeholder">
                <FilmMark />
                <span>{MODES.find((m) => m[0] === data.mode)?.[1]}</span>
              </div>
            )}
          </div>
          <div className="node-body">
            <p>{data.prompt || "未填写提示词"}</p>
            <div className="node-meta">
              <span>{data.parameters?.resolution}</span>
              <span>
                {data.parameters?.duration === -1
                  ? "智能时长"
                  : `${data.parameters?.duration} 秒`}
              </span>
              <span>{data.model?.endsWith("prime") ? "高速" : "标准"}</span>
            </div>
            <div className="node-actions nodrag">
              <button className="primary" onClick={() => act(id, "run")}>
                <Play size={14} />
                生成
              </button>
              <IconButton title="复制节点" onClick={() => act(id, "duplicate")}>
                <Copy size={15} />
              </IconButton>
              {data.result_asset_id && (
                <IconButton title="结果分支" onClick={() => act(id, "branch")}>
                  <GitBranch size={15} />
                </IconButton>
              )}
            </div>
          </div>
        </div>
      </div>
      <Handle id="video" type="source" position={Position.Right} />
    </div>
  );
}
function FilmMark() {
  return (
    <div className="film-mark">
      <Video size={32} />
    </div>
  );
}
function AssetNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const labels = useContext(AssetNames);
  useHandleRefresh(id, `${data.asset_id || ""}:${data.kind || ""}`);
  return (
    <div className={`canvas-node asset-node ${selected ? "selected" : ""}`}>
      <div className="node-head">
        <Image size={16} />
        <strong title={data.name}>{labels[id] || data.name}</strong>
      </div>
      <div className="node-preview">
        <CanvasMedia id={data.asset_id} kind={data.kind} name={data.name} />
      </div>
      <Handle id="asset" type="source" position={Position.Right} />
    </div>
  );
}
function TextNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const act = useContext(NodeActions);
  useHandleRefresh(id, `${data.text || ""}:${Boolean(data.optimizeEnabled)}`);
  return (
    <div className={`canvas-node text-node ${selected ? "selected" : ""}`}>
      <div className="node-head">
        <StickyNote size={16} />
        <strong>文本</strong>
      </div>
      <p>{data.text || "写下你的灵感…"}</p>
      <label
        className="node-optimize-check nodrag nopan"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          aria-label="AI智能优化提示词"
          checked={Boolean(data.optimizeEnabled)}
          onChange={() => act(id, "toggle-optimize")}
        />
        <WandSparkles size={14} />
        <span>AI智能优化提示词</span>
      </label>
      {data.optimizeEnabled && (
        <button
          className="node-optimize-open nodrag nopan"
          onClick={() => act(id, "open-optimize")}
        >
          选择模型 · 开始优化
          <ArrowRight size={13} />
        </button>
      )}
      <Handle id="text" type="source" position={Position.Right} />
    </div>
  );
}
function PreviewNode({ id, selected }: NodeProps<CanvasNode>) {
  const sources = useContext(PreviewSources);
  const source = sources[id];
  useHandleRefresh(id, source?.id || "");
  return (
    <div className={`canvas-node preview-node ${selected ? "selected" : ""}`}>
      <Handle id="preview" type="target" position={Position.Left} />
      <div className="node-head">
        <Play size={16} />
        <strong>预览</strong>
      </div>
      <div className="node-preview">
        {source ? (
          <CanvasMedia id={source.id} kind={source.kind} />
        ) : (
          <div className="generation-placeholder">
            <FilmMark />
          </div>
        )}
      </div>
    </div>
  );
}
function NoteNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div className={`canvas-note ${selected ? "selected" : ""}`}>
      <StickyNote size={16} />
      <p>{data.text || "便签"}</p>
    </div>
  );
}
import { ImageNode } from "./image-node";
import { PromptOptimizer } from "./prompt-optimizer";

import { CapabilityPanel } from "./capability-workbench";
function CapabilityNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const act = useContext(NodeActions);
  useHandleRefresh(id, String(data.model));
  return (
    <div
      className={`canvas-node capability-node ${selected ? "selected" : ""}`}
    >
      <div className="node-head">
        <Boxes size={16} />
        <strong>多模态创作</strong>
      </div>
      <Handle id="prompt" type="target" position={Position.Left} />
      <div className="node-body">
        <strong>{data.model || "选择能力模型"}</strong>
        <p>{data.prompt || "语言、音频、3D、世界与实时交互"}</p>
        <button
          className="nodrag nopan"
          onClick={() => act(id, "open-capability")}
        >
          打开创作设置
          <ArrowRight size={13} />
        </button>
      </div>
      <Handle id="result" type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = {
  generation: GenerationNode,
  asset: AssetNode,
  text: TextNode,
  preview: PreviewNode,
  note: NoteNode,
  image: ImageNode,
  capability: CapabilityNode,
};
function BadgeStatus({ status }: { status?: string }) {
  return status ? (
    <span className={`node-status ${status === "SUCCEEDED" ? "positive" : ""}`}>
      {STATUS_LABELS[status] || status}
    </span>
  ) : null;
}
function safeContent(nodes: CanvasNode[], edges: Edge[], viewport?: Row) {
  const normalizedEdges = normalizeCanvasEdges(nodes, edges);
  return {
    nodes: nodes.map(
      ({
        id,
        type,
        position,
        data,
        parentId,
        extent,
        style,
        width,
        height,
      }) => ({
        id,
        type,
        position,
        data,
        parentId,
        extent,
        style,
        width,
        height,
      }),
    ),
    edges: normalizedEdges.map(
      ({ id, source, target, sourceHandle, targetHandle }) => ({
        id,
        source,
        target,
        sourceHandle,
        targetHandle,
      }),
    ),
    ...(viewport ? { viewport } : {}),
  };
}

export function CanvasPage() {
  const { id } = useParams();
  const catalog = useData("/models");
  return (
    <QueryState query={catalog}>
      <ReactFlowProvider key={id}>
        <CanvasEditor />
      </ReactFlowProvider>
    </QueryState>
  );
}
function CanvasEditor() {
  const { id } = useParams();
  const cache = useQueryClient();
  const modelCatalog = useData<Row>("/models");
  const videoModelOptions: Row[] = (modelCatalog.data?.catalog || []).filter(
    (m: Row) => m.type === "video" && m.enabled,
  );
  const imageModelOptions: Row[] = (modelCatalog.data?.catalog || []).filter(
    (m: Row) => m.type === "image" && m.enabled,
  );
  const project = useQuery<Row>({
    queryKey: [`/projects/${id}`],
    queryFn: async ({ signal }) => {
      await pendingCanvasSaves.get(id!);
      return api(`/projects/${id}`, { signal });
    },
    staleTime: 0,
    refetchOnMount: "always",
  });
  const allTasks = useData<Row[]>(
    `/generations?limit=200&project_id=${id}`,
    5000,
  );
  const imageTasksQuery = useQuery<Row>({
    queryKey: [`/image-generations?limit=200&project_id=${id}`],
    queryFn: () => api(`/image-generations?limit=200&project_id=${id}`),
    refetchInterval: 3000,
  });
  const imageTasks = imageTasksQuery.data?.tasks || [];
  const workflows = useData<Row[]>("/workflows", 5000);
  const assets = useData<Row[]>("/assets");
  const flow = useReactFlow();
  const navigate = useNavigate();
  const notify = useContext(NotifyContext);
  const action = useAction();
  const [deletion, setDeletion] = useState<{
    items: CanvasNode[];
    resolve: (value: boolean) => void;
  } | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]),
    [edges, setEdges] = useState<Edge[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [panel, setPanel] = useState(
      () => window.matchMedia("(min-width: 801px)").matches,
    ),
    [saveState, setSaveState] = useState("加载中"),
    [assetMode, setAssetMode] = useState<"node" | "input" | null>(null),
    [quote, setQuote] = useState<Row | null>(null),
    [batch, setBatch] = useState<Row | null>(null),
    [urlOpen, setUrlOpen] = useState(false),
    [assistant, setAssistant] = useState(false),
    [history, setHistory] = useState(false),
    [revisions, setRevisions] = useState<Row[] | null>(null),
    [taskDetail, setTaskDetail] = useState<Row | null>(null),
    [compare, setCompare] = useState(false),
    [draft, setDraft] = useState<Row | null>(null),
    [title, setTitle] = useState(""),
    [undoCount, setUndoCount] = useState(0);
  const version = useRef(0),
    loaded = useRef(""),
    saved = useRef(""),
    saving = useRef(false),
    conflict = useRef(false),
    undo = useRef<Row[]>([]),
    redo = useRef<Row[]>([]),
    viewport = useRef<Row>({ x: 0, y: 0, zoom: 1 }),
    latest = useRef({ nodes, edges });
  const titleRef = useRef(title),
    savedTitle = useRef("");
  const draftOwner = useRef(uid());
  titleRef.current = title;
  latest.current = { nodes, edges };
  useEffect(() => {
    if (!project.data || project.isFetching || loaded.current === id) return;
    const p = project.data;
    const loadedNodes = (p.content.nodes || []) as CanvasNode[];
    const loadedEdges = normalizeCanvasEdges(
      loadedNodes,
      (p.content.edges || []) as Edge[],
    );
    loaded.current = id!;
    version.current = p.version;
    latest.current = {
      nodes: loadedNodes,
      edges: loadedEdges,
    };
    setNodes(loadedNodes);
    setEdges(loadedEdges);
    setTitle(p.name);
    titleRef.current = p.name;
    savedTitle.current = p.name;
    viewport.current = p.content.viewport || { x: 0, y: 0, zoom: 1 };
    saved.current = contentSignature(
      safeContent(loadedNodes, loadedEdges, viewport.current),
    );
    setSaveState("已保存");
    setTimeout(() => flow.setViewport(viewport.current as any), 100);
    get(`canvas:${id}`)
      .then((d) => {
        if (
          d &&
          d.content &&
          (contentSignature(d.content) !== saved.current ||
            (d.name && d.name !== savedTitle.current))
        )
          setDraft(d);
      })
      .catch(() => {});
  }, [project.data, project.isFetching, id, flow]);
  const checkpoint = () => {
    undo.current.push(structuredClone(latest.current));
    if (undo.current.length > 50) undo.current.shift();
    redo.current = [];
    setUndoCount((x) => x + 1);
  };
  const save = useCallback(() => {
    if (!loaded.current || saving.current || conflict.current)
      return Promise.resolve();
    const job = (async function persist() {
      if (!loaded.current || saving.current || conflict.current) return;
      const content = safeContent(
        latest.current.nodes,
        latest.current.edges,
        viewport.current,
      );
      const json = contentSignature(content);
      const name = titleRef.current.trim() || savedTitle.current;
      if (json === saved.current && name === savedTitle.current) {
        setSaveState("已保存");
        await updateDraft<Row | undefined>(`canvas:${id}`, (stored) =>
          stored?.owner === draftOwner.current &&
          contentSignature(
            safeContent(
              latest.current.nodes,
              latest.current.edges,
              viewport.current,
            ),
          ) === saved.current &&
          (titleRef.current.trim() || savedTitle.current) === savedTitle.current
            ? undefined
            : stored,
        );
        return;
      }
      saving.current = true;
      setSaveState("保存中");
      try {
        await set(`canvas:${id}`, {
          owner: draftOwner.current,
          content,
          version: version.current,
          at: Date.now(),
          name,
        });
        const p = await patch(`/projects/${id}`, {
          content,
          version: version.current,
          name,
        });
        version.current = p.version;
        saved.current = json;
        savedTitle.current = name;
        cache.setQueryData([`/projects/${id}`], p);
        void cache.invalidateQueries({ queryKey: ["/projects"], exact: true });
        setSaveState("已保存");
        if (
          contentSignature(
            safeContent(
              latest.current.nodes,
              latest.current.edges,
              viewport.current,
            ),
          ) === json &&
          titleRef.current === name
        )
          await updateDraft<Row | undefined>(`canvas:${id}`, (stored) =>
            stored &&
            contentSignature(stored.content) === json &&
            (stored.name || name) === name
              ? undefined
              : stored,
          );
      } catch (e: any) {
        if (e.status === 409) {
          conflict.current = true;
          setSaveState("版本冲突");
        } else setSaveState("已暂存本机");
      } finally {
        saving.current = false;
      }
      if (
        !conflict.current &&
        navigator.onLine &&
        saved.current === json &&
        (contentSignature(
          safeContent(
            latest.current.nodes,
            latest.current.edges,
            viewport.current,
          ),
        ) !== json ||
          titleRef.current !== name)
      )
        await persist();
    })();
    pendingCanvasSaves.set(id!, job);
    const clear = () => {
      if (pendingCanvasSaves.get(id!) === job) pendingCanvasSaves.delete(id!);
    };
    void job.then(clear, clear);
    return job;
  }, [id, cache]);
  useEffect(() => {
    if (!loaded.current) return;
    if (nodes !== latest.current.nodes || edges !== latest.current.edges)
      return;
    const content = safeContent(nodes, edges, viewport.current);
    if (
      contentSignature(content) !== saved.current ||
      title !== savedTitle.current
    ) {
      if (!saving.current && !conflict.current) setSaveState("待保存");
      void set(`canvas:${id}`, {
        owner: draftOwner.current,
        content,
        name: title,
        version: version.current,
        at: Date.now(),
      }).catch(() => notify("本机草稿无法保存，请保持页面打开", true));
    }
    const timer = setTimeout(() => {
      void save();
    }, 900);
    return () => clearTimeout(timer);
  }, [nodes, edges, title, save]);
  useEffect(() => {
    const reconnect = () => save();
    window.addEventListener("online", reconnect);
    const leave = (e: BeforeUnloadEvent) => {
      const c = safeContent(
        latest.current.nodes,
        latest.current.edges,
        viewport.current,
      );
      if (
        contentSignature(c) !== saved.current ||
        titleRef.current !== savedTitle.current
      ) {
        void set(`canvas:${id}`, {
          owner: draftOwner.current,
          content: c,
          version: version.current,
          at: Date.now(),
          name: titleRef.current,
        });
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      if (loaded.current) void save();
      window.removeEventListener("online", reconnect);
      window.removeEventListener("beforeunload", leave);
    };
  }, [save, id]);
  useEffect(() => {
    if (!allTasks.data) return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((n) => {
        if (n.type !== "generation") return n;
        const t =
          allTasks.data.find(
            (t) => t.project_id === id && t.node_id === n.id,
          ) || allTasks.data.find((t) => t.id === n.data.taskId);
        if (
          !t ||
          (t.id === n.data.taskId &&
            t.status === n.data.status &&
            t.result_asset_id === n.data.result_asset_id)
        )
          return n;
        changed = true;
        return {
          ...n,
          data: {
            ...n.data,
            taskId: t.id,
            status: t.status,
            result_asset_id: t.result_asset_id,
          },
        };
      });
      return changed ? next : current;
    });
  }, [allTasks.data, id]);
  useEffect(() => {
    if (!imageTasks.length) return;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (node.type !== "image") return node;
        const task =
          imageTasks.find(
            (item: Row) => item.project_id === id && item.node_id === node.id,
          ) || imageTasks.find((item: Row) => item.id === node.data.taskId);
        if (!task) return node;
        const resultAssetIds = Array.isArray(task.result_assets)
          ? task.result_assets
          : [];
        if (
          task.id === node.data.taskId &&
          task.status === node.data.status &&
          contentSignature(resultAssetIds) ===
            contentSignature(node.data.result_asset_ids || [])
        )
          return node;
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            taskId: task.id,
            status: task.status,
            result_asset_ids: resultAssetIds,
            result_asset_id: resultAssetIds[0],
            charged: task.charged,
            error: task.error,
          },
        };
      });
      return changed ? next : current;
    });
  }, [imageTasks, id]);
  const chosen = nodes.find((n) => n.id === selected);
  const tasks = (allTasks.data || []).filter((t) => t.project_id === id);
  const assetNames: Record<string, string> = {};
  const previewSources: Record<
    string,
    { id: string; kind: string } | undefined
  > = {};
  for (const target of nodes) {
    if (target.type === "generation") {
      const counts: Record<string, number> = {};
      for (const item of target.data.media || [])
        counts[item.type] = (counts[item.type] || 0) + 1;
      for (const { source, port } of incomingBindings(target, nodes, edges)) {
        counts[port] = (counts[port] || 0) + 1;
        if (
          source.type === "asset" &&
          ["reference_image", "reference_video", "reference_audio"].includes(
            port,
          )
        ) {
          const label = referenceName(port, counts[port]);
          assetNames[source.id] = assetNames[source.id]
            ? `${assetNames[source.id]} / ${label}`
            : label;
        }
      }
    } else if (target.type === "preview") {
      const edge = edges.find((item) => item.target === target.id);
      const source = nodes.find((node) => node.id === edge?.source);
      const resultAssetId =
        source?.type === "generation"
          ? source.data.result_asset_id
          : source?.type === "image"
            ? source.data.result_asset_id
            : undefined;
      if (resultAssetId)
        previewSources[target.id] = {
          id: resultAssetId,
          kind: source?.type === "image" ? "image" : "video",
        };
    }
  }
  const update = (data: Row, nodeId = selected) => {
    checkpoint();
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    );
  };
  const position = () =>
    flow.screenToFlowPosition({
      x: window.innerWidth / 2 - 60,
      y: window.innerHeight / 2 - 100,
    });
  const addNode = (type: string) => {
    checkpoint();
    if (type === "capability") {
      const model = (modelCatalog.data?.catalog || []).find(
        (m: Row) =>
          ["speech", "threed", "world", "realtime", "language"].includes(
            m.type,
          ) && m.enabled,
      );
      const n = {
        id: uid(),
        type: "capability",
        position: position(),
        data: {
          model: model?.model || "",
          prompt: "",
          parameters: { max_seconds: 60 },
        },
      };
      setNodes((ns) => [...ns, n]);
      setSelected(n.id);
      setPanel(true);
      return;
    }
    if (type === "generation") {
      const pair = newGenerationPair("text", position());
      setNodes((ns) => [...ns, ...pair.nodes]);
      setEdges((es) => [...es, ...pair.edges]);
      setSelected(pair.nodes[0].id);
    } else if (type === "image") {
      const n = {
        id: uid(),
        type: "image",
        position: position(),
        data: {
          prompt: "",
          model: "qwen-image-3.0",
          mode: "text",
          images: [],
          parameters: { ...DEFAULT_IMAGE_PARAMETERS },
          status: "DRAFT",
        },
      };
      setNodes((ns) => [...ns, n]);
      setSelected(n.id);
    } else {
      const n = {
        id: uid(),
        type,
        position: position(),
        data: type === "note" ? { text: "新的创意" } : {},
      };
      setNodes((ns) => [...ns, n]);
      setSelected(n.id);
    }
    setPanel(true);
  };
  const inputFor = (n: CanvasNode, dependencies = false) => {
    checkInputs(n, nodes, edges);
    const media = [...(n.data.media || [])];
    let prompt = n.data.prompt || "";
    const bindings = incomingBindings(n, nodes, edges);
    for (const { source, port } of bindings) {
      if (source.type === "text") prompt = source.data.text || "";
      if (source.type === "asset")
        media.push({
          type: port,
          asset_id: source.data.asset_id,
        });
      if (source.type === "generation" && !dependencies) {
        if (port === "first_frame" || port === "last_frame")
          throw new Error("视频首尾帧衔接请使用运行批次");
        if (!source.data.result_asset_id)
          throw new Error("前序节点尚未生成，请使用批次运行");
        media.push({
          type: port,
          asset_id: source.data.result_asset_id,
        });
      }
    }
    const allTypes = [
      ...media,
      ...bindings
        .filter(({ source }) => source.type === "generation")
        .map(({ port }) => ({ type: port })),
    ];
    return {
      model: n.data.model,
      mode: effectiveMode(n.data.mode, allTypes),
      input: { prompt, media },
      parameters: n.data.parameters,
      project_id: id,
      node_id: n.id,
    };
  };
  const runNode = (nodeId: string) =>
    action.run(async () => {
      await save();
      const n = latest.current.nodes.find((n) => n.id === nodeId)!;
      const q = await post("/quotes", inputFor(n));
      setQuote({ ...q, idempotency: uid() });
    });
  const runImageNode = (nodeId: string) =>
    action.run(async () => {
      await save();
      const node = latest.current.nodes.find((item) => item.id === nodeId);
      if (!node || node.type !== "image") throw new Error("图片节点不存在");
      const graphNode = node as unknown as ImageGraphNode;
      const bindings = incomingImageBindings(
        graphNode,
        latest.current.nodes as unknown as ImageGraphNode[],
        latest.current.edges,
      );
      checkImageInputs(
        graphNode,
        latest.current.nodes as unknown as ImageGraphNode[],
        latest.current.edges,
      );
      let prompt = String(node.data.prompt || "");
      const images = [...(node.data.images || [])];
      for (const { source, port } of bindings) {
        if (source.type === "text" && port === "prompt")
          prompt = String(source.data.text || "");
        if (port !== "reference_image") continue;
        const assetId =
          source.type === "image"
            ? source.data.result_asset_id
            : source.data.asset_id;
        if (source.type === "image" && !assetId)
          throw new Error("前序图片尚未生成");
        if (assetId)
          images.push({ type: "reference_image", asset_id: assetId });
      }
      if (!prompt.trim()) throw new Error("请输入图片提示词");
      const input = {
        model: node.data.model || "qwen-image-3.0",
        mode: node.data.mode || "text",
        input: { prompt, images },
        parameters: {
          ...DEFAULT_IMAGE_PARAMETERS,
          ...(node.data.parameters || {}),
        },
        project_id: id,
        node_id: node.id,
      };
      const quoteResult = await post("/image-quotes", input);
      setQuote({
        ...quoteResult,
        kind: "image",
        nodeId,
        input,
        idempotency: uid(),
      });
    });
  const nodeAction = (nodeId: string, op: string) => {
    const n = nodes.find((n) => n.id === nodeId)!;
    if (op === "open-capability") {
      setSelected(nodeId);
      setPanel(true);
      return;
    }
    if (op === "toggle-optimize" || op === "open-optimize") {
      if (op === "toggle-optimize")
        update({ optimizeEnabled: !n.data.optimizeEnabled }, nodeId);
      setSelected(nodeId);
      setPanel(true);
      return;
    }
    if (op === "run") {
      if (n.type === "image") void runImageNode(nodeId);
      else void runNode(nodeId);
      return;
    }
    checkpoint();
    if (op === "duplicate") {
      if (n.type === "image") {
        const {
          taskId,
          status,
          result_asset_id,
          result_asset_ids,
          charged,
          error,
          ...data
        } = n.data;
        const copy = {
          id: uid(),
          type: "image",
          position: { x: n.position.x + 60, y: n.position.y + 70 },
          data,
        };
        setNodes((current) => [...current, copy]);
        setSelected(copy.id);
        return;
      }
      const { taskId, status, result_asset_id, ...data } = n.data;
      const pair = newGenerationPair(
        n.data.mode,
        {
          x: n.position.x + 60,
          y: n.position.y + 70,
        },
        data,
      );
      setNodes((ns) => [...ns, ...pair.nodes]);
      setEdges((es) => [...es, ...pair.edges]);
      setSelected(pair.nodes[0].id);
    }
    if (op === "branch") {
      if (n.type === "image") {
        if (!n.data.result_asset_id) return;
        const out = {
          id: uid(),
          type: "asset",
          position: { x: n.position.x + 400, y: n.position.y },
          data: {
            name: "生成图片 · 结果",
            kind: "image",
            asset_id: n.data.result_asset_id,
          },
        };
        setNodes((current) => [...current, out]);
        setSelected(out.id);
        return;
      }
      const out = {
        id: uid(),
        type: "asset",
        position: { x: n.position.x + 370, y: n.position.y },
        data: {
          name: `${n.data.label} · 结果`,
          kind: "video",
          asset_id: n.data.result_asset_id,
        },
      };
      setNodes((ns) => [...ns, out]);
      setSelected(out.id);
    }
  };
  const connect = (connection: Connection) => {
    const target = nodes.find((n) => n.id === connection.target);
    const source = nodes.find((n) => n.id === connection.source);
    if (target?.type === "capability") {
      if (!source || !["text", "asset", "image"].includes(source.type || "")) {
        notify("多模态节点接受文本、图片或音频素材输入", true);
        return;
      }
      const incoming = edges.filter((e) => e.target === target.id);
      if (incoming.some((e) => e.source === source.id)) {
        notify("此素材已连接", true);
        return;
      }
      if (
        source.type === "text" &&
        incoming.some(
          (e) => nodes.find((n) => n.id === e.source)?.type === "text",
        )
      ) {
        notify("多模态节点最多连接一个文本输入", true);
        return;
      }
      if (
        source.type !== "text" &&
        incoming.filter(
          (e) => nodes.find((n) => n.id === e.source)?.type !== "text",
        ).length +
          (target.data.references?.length || 0) >=
          4
      ) {
        notify("多模态节点最多接受4份参考素材", true);
        return;
      }
      checkpoint();
      setEdges((es) => addEdge({ ...connection, id: uid() }, es));
      return;
    }
    if (target?.type === "preview") {
      if (!source || !["generation", "image"].includes(source.type || "")) {
        notify("预览节点仅接受图片或视频生成输出", true);
        return;
      }
      if (edges.some((e) => e.target === target.id)) {
        notify("预览节点只能连接一个视频输出", true);
        return;
      }
      checkpoint();
      setEdges((es) =>
        addEdge(
          {
            ...connection,
            sourceHandle: connection.sourceHandle || "video",
            targetHandle: "preview",
            id: uid(),
          },
          es,
        ),
      );
      return;
    }
    if (target?.type === "image") {
      if (!source) return;
      let used: ImagePort[];
      try {
        used = checkImageInputs(
          target as unknown as ImageGraphNode,
          nodes as unknown as ImageGraphNode[],
          edges,
        );
      } catch (error) {
        notify(
          error instanceof Error ? error.message : "图片输入连接无效",
          true,
        );
        return;
      }
      const port = resolveImagePort(
        { ...connection, targetHandle: undefined },
        source as unknown as ImageGraphNode,
        target as unknown as ImageGraphNode,
        used,
      );
      const kind =
        source.type === "text"
          ? "text"
          : source.type === "image" ||
              (source.type === "asset" && source.data.kind === "image")
            ? "image"
            : "invalid";
      const issue = imagePortIssue(
        target.data.mode || "text",
        port,
        kind,
        used,
        target.data.model,
      );
      if (issue) {
        notify(issue, true);
        return;
      }
      if (
        edges.some(
          (edge) =>
            edge.source === source.id &&
            edge.target === target.id &&
            edge.targetHandle === port,
        )
      ) {
        notify("该素材已连接此输入点", true);
        return;
      }
      const visits = new Set<string>();
      const reaches = (from: string): boolean => {
        if (from === connection.source) return true;
        if (visits.has(from)) return false;
        visits.add(from);
        return edges
          .filter((edge) => edge.source === from)
          .some((edge) => reaches(edge.target));
      };
      if (
        connection.source === connection.target ||
        reaches(connection.target!)
      ) {
        notify("不能创建循环依赖", true);
        return;
      }
      checkpoint();
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            sourceHandle:
              connection.sourceHandle ||
              (source.type === "image"
                ? "image"
                : source.type === "asset"
                  ? "asset"
                  : "text"),
            targetHandle: port,
            id: uid(),
          },
          current,
        ),
      );
      return;
    }
    if (target?.type !== "generation") {
      notify("请连接至生成节点", true);
      return;
    }
    if (!source) return;
    let used: Port[];
    try {
      used = checkInputs(target, nodes, edges);
    } catch (e) {
      notify(e instanceof Error ? e.message : "输入连接无效", true);
      return;
    }
    const port = resolvePort(connection, source, target, used);
    const kind =
      source.type === "generation"
        ? port === "first_frame" || port === "last_frame"
          ? "image"
          : "video"
        : source.type === "text"
          ? "text"
          : source.type === "asset"
            ? source.data.kind
            : "invalid";
    const issue = portIssue(target.data.mode, port, kind, used);
    if (issue) {
      notify(issue, true);
      return;
    }
    if (
      edges.some(
        (edge) =>
          edge.source === source.id &&
          edge.target === target.id &&
          edge.targetHandle === port,
      )
    ) {
      notify("该素材已连接此输入点", true);
      return;
    }
    const visits = new Set<string>();
    const reaches = (from: string): boolean => {
      if (from === connection.source) return true;
      if (visits.has(from)) return false;
      visits.add(from);
      return edges
        .filter((e) => e.source === from)
        .some((e) => reaches(e.target));
    };
    if (connection.source === connection.target || reaches(connection.target)) {
      notify("不能创建循环依赖", true);
      return;
    }
    checkpoint();
    setEdges((es) =>
      addEdge(
        {
          ...connection,
          sourceHandle:
            connection.sourceHandle ||
            (source.type === "generation"
              ? "video"
              : source.type === "asset"
                ? "asset"
                : "text"),
          targetHandle: port,
          id: uid(),
        },
        es,
      ),
    );
  };
  const undoStep = (forward = false) => {
    const stack = forward ? redo.current : undo.current;
    const state = stack.pop();
    if (!state) return;
    (forward ? undo.current : redo.current).push(
      structuredClone(latest.current),
    );
    setNodes(state.nodes);
    setEdges(state.edges);
    setUndoCount((x) => x + 1);
  };
  const autoLayout = () => {
    checkpoint();
    const levels = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++)
      for (const n of nodes) {
        const incoming = edges.filter((e) => e.target === n.id);
        levels.set(
          n.id,
          incoming.length
            ? Math.max(...incoming.map((e) => levels.get(e.source) || 0)) + 1
            : 0,
        );
      }
    const counts: Row = {};
    setNodes((ns) =>
      ns.map((n) => {
        const level = levels.get(n.id) || 0;
        const row = counts[level] || 0;
        counts[level] = row + 1;
        return {
          ...n,
          parentId: undefined,
          extent: undefined,
          position: { x: level * 360 + 60, y: row * 390 + 60 },
        };
      }),
    );
    setTimeout(() => flow.fitView({ padding: 0.15 }), 50);
  };
  const group = () => {
    const selectedNodes = nodes.filter((n) => n.selected && n.type !== "group");
    if (selectedNodes.length < 2) {
      notify("请先选择至少两个节点");
      return;
    }
    checkpoint();
    const x = Math.min(...selectedNodes.map((n) => n.position.x)) - 30,
      y = Math.min(...selectedNodes.map((n) => n.position.y)) - 50;
    const groupId = uid();
    setNodes((ns) => [
      {
        id: groupId,
        type: "group",
        position: { x, y },
        data: { label: "分组" },
        style: {
          width: Math.max(...selectedNodes.map((n) => n.position.x)) - x + 350,
          height: Math.max(...selectedNodes.map((n) => n.position.y)) - y + 410,
          background: "rgba(14,130,114,.04)",
          borderColor: "#a4cfc4",
        },
      },
      ...ns.map((n) =>
        selectedNodes.some((s) => s.id === n.id)
          ? {
              ...n,
              parentId: groupId,
              extent: "parent" as const,
              position: { x: n.position.x - x, y: n.position.y - y },
            }
          : n,
      ),
    ]);
  };
  const batchRun = () =>
    action.run(async () => {
      await save();
      const picked = nodes.filter((n) => n.type === "generation" && n.selected);
      const list = picked.length
        ? picked
        : nodes.filter((n) => n.type === "generation");
      const included = new Set(list.map((n) => n.id));
      for (let i = 0; i < list.length; i++) {
        for (const e of edges.filter((e) => e.target === list[i].id)) {
          const ancestor = nodes.find(
            (n) => n.id === e.source && n.type === "generation",
          );
          if (ancestor && !included.has(ancestor.id)) {
            included.add(ancestor.id);
            list.push(ancestor);
          }
        }
      }
      if (!list.length) throw new Error("请先添加生成节点");
      const q = await post("/workflows/quote", {
        project_id: id,
        steps: list.map((n) => {
          const bindings = incomingBindings(n, nodes, edges).filter(
            ({ source }) => source.type === "generation",
          );
          return {
            id: n.id,
            input: inputFor(n, true),
            dependencies: [...new Set(bindings.map(({ source }) => source.id))],
            dependency_bindings: bindings.map(({ source, port }) => ({
              source: source.id,
              type: port,
            })),
            dependency_types: Object.fromEntries(
              bindings.map(({ source, port }) => [source.id, port]),
            ),
          };
        }),
      });
      setBatch(q);
    });
  const useResult = (task: Row, mode: string) => {
    checkpoint();
    const pair = newGenerationPair(mode, position(), {
      model: task.model,
      prompt:
        mode === "extend"
          ? "将视频1向后延长，保持主体、运动与声音连贯。"
          : mode === "edit"
            ? "编辑视频1："
            : task.input.input.prompt,
      media: task.result_asset_id
        ? [{ type: "reference_video", asset_id: task.result_asset_id }]
        : task.input.input.media,
      parameters: {
        ...task.input.parameters,
        ...(mode === "extend" ? { ratio: "adaptive" } : {}),
      },
    });
    setNodes((ns) => [...ns, ...pair.nodes]);
    setEdges((es) => [...es, ...pair.edges]);
    setSelected(pair.nodes[0].id);
    setHistory(false);
  };
  const useImageResult = (task: Row, includeImage = false) => {
    checkpoint();
    const assetId = includeImage ? (task.result_assets || [])[0] : undefined;
    const supportsImages =
      (MODEL_CAPABILITIES as Row)[task.model]?.maxImages > 0;
    const node = {
      id: uid(),
      type: "image",
      position: position(),
      data: {
        prompt: includeImage
          ? "在保持参考图主要内容的基础上进行编辑"
          : task.prompt,
        model: task.model,
        mode: assetId && supportsImages ? "image" : "text",
        images:
          assetId && supportsImages
            ? [{ type: "reference_image", asset_id: assetId }]
            : [],
        parameters: { ...DEFAULT_IMAGE_PARAMETERS, ...(task.parameters || {}) },
        status: "DRAFT",
      },
    };
    setNodes((current) => [...current, node]);
    setSelected(node.id);
    setPanel(true);
    setHistory(false);
  };
  const editChosenResult = (mode: string) =>
    action.run(async () => {
      if (!chosen) return;
      const task =
        tasks.find((t) => t.id === chosen.data.taskId) ||
        (chosen.data.taskId
          ? await api<Row>(`/generations/${chosen.data.taskId}`)
          : {
              model: chosen.data.model,
              input: {
                input: { prompt: chosen.data.prompt, media: chosen.data.media },
                parameters: chosen.data.parameters,
              },
              result_asset_id: chosen.data.result_asset_id,
            });
      if (task) useResult(task, mode);
    });
  if (project.isPending) return <QueryState query={project}>{null}</QueryState>;
  if (project.error) return <QueryState query={project}>{null}</QueryState>;
  if (loaded.current !== id)
    return (
      <div className="loading" role="status">
        <LoaderCircle className="spin" size={20} />
        加载画布中
      </div>
    );
  return (
    <div className="canvas-workspace">
      <header className="canvas-header">
        <Link className="icon-button" aria-label="返回画布列表" to="/projects">
          <ArrowLeft size={19} />
        </Link>
        <input
          className="canvas-title"
          aria-label="画布名称"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void save()}
        />
        <span
          className={`save-state ${saveState.includes("冲突") ? "error-text" : ""}`}
        >
          {saveState}
        </span>
        {saveState === "版本冲突" && (
          <button
            onClick={() =>
              action.run(async () => {
                const p = await post("/projects", {
                  name: `${title} · 本机副本`,
                  content: safeContent(nodes, edges, viewport.current),
                });
                navigate(`/canvas/${p.id}`);
                location.reload();
              })
            }
          >
            另存副本
          </button>
        )}
        <span className="grow" />
        <IconButton title="历史与任务" onClick={() => setHistory(true)}>
          <History size={19} />
        </IconButton>
        <IconButton title="保存" onClick={() => save()}>
          <Save size={18} />
        </IconButton>
        <button onClick={batchRun} disabled={action.busy}>
          <Play size={16} />
          运行批次
        </button>
        <IconButton
          title={panel ? "收起参数" : "打开参数"}
          onClick={() => setPanel(!panel)}
        >
          {panel ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
        </IconButton>
      </header>
      <div className="canvas-body">
        <div className="canvas-stage">
          <div className="canvas-toolbar">
            <IconButton
              title="添加生成节点"
              onClick={() => addNode("generation")}
            >
              <Video size={20} />
            </IconButton>
            <IconButton title="添加图片节点" onClick={() => addNode("image")}>
              <Image size={20} />
            </IconButton>
            <IconButton title="添加预览节点" onClick={() => addNode("preview")}>
              <Play size={19} />
            </IconButton>
            <IconButton
              title="添加素材节点"
              onClick={() => setAssetMode("node")}
            >
              <ImagePlus size={20} />
            </IconButton>
            <IconButton
              title="添加多模态节点"
              onClick={() => addNode("capability")}
            >
              <Boxes size={19} />
            </IconButton>
            <IconButton title="添加文本节点" onClick={() => addNode("text")}>
              <Type size={20} />
            </IconButton>
            <IconButton title="添加便签" onClick={() => addNode("note")}>
              <StickyNote size={20} />
            </IconButton>
            <i />
            <IconButton
              title="撤销"
              disabled={!undo.current.length}
              onClick={() => undoStep()}
            >
              <Undo2 size={18} />
            </IconButton>
            <IconButton
              title="重做"
              disabled={!redo.current.length}
              onClick={() => undoStep(true)}
            >
              <Redo2 size={18} />
            </IconButton>
            <i />
            <IconButton title="自动排列" onClick={autoLayout}>
              <LayoutGrid size={19} />
            </IconButton>
            <IconButton title="选中节点分组" onClick={group}>
              <Group size={19} />
            </IconButton>
            <IconButton
              title="适应画布"
              onClick={() => flow.fitView({ padding: 0.15 })}
            >
              <Maximize size={18} />
            </IconButton>
          </div>
          <AssetContext.Provider
            value={Object.fromEntries(
              (assets.data || []).map((a) => [a.id, a]),
            )}
          >
            <AssetNames.Provider value={assetNames}>
              <PreviewSources.Provider value={previewSources}>
                <NodeActions.Provider value={nodeAction}>
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={(changes) =>
                      setNodes((ns) => applyNodeChanges(changes, ns))
                    }
                    onEdgesChange={(changes) =>
                      setEdges((es) => applyEdgeChanges(changes, es))
                    }
                    onNodeDragStart={checkpoint}
                    onConnect={connect}
                    onNodeClick={(_e, n) => {
                      setSelected(n.id);
                      setPanel(true);
                    }}
                    onPaneClick={() => setSelected(null)}
                    onMoveEnd={(_e, v) => {
                      viewport.current = v;
                      void save();
                    }}
                    minZoom={0.1}
                    maxZoom={2}
                    deleteKeyCode={["Backspace", "Delete"]}
                    onBeforeDelete={async ({ nodes: removed }) => {
                      checkpoint();
                      const active = removed.filter(
                        (n) =>
                          ["generation", "image"].includes(n.type || "") &&
                          [
                            "QUEUED",
                            "SUBMITTING",
                            "PENDING",
                            "RUNNING",
                            "CANCELING",
                            "UNKNOWN",
                          ].includes(String(n.data.status)),
                      );
                      if (active.length)
                        return new Promise<boolean>((resolve) =>
                          setDeletion({ items: active, resolve }),
                        );
                      return true;
                    }}
                    defaultEdgeOptions={{ type: "smoothstep" }}
                    fitView={false}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background color="#cfd6d2" gap={24} size={1} />
                    <MiniMap
                      pannable
                      zoomable
                      nodeColor={(n) =>
                        n.type === "generation"
                          ? "#157b6d"
                          : n.type === "note"
                            ? "#d5ac3a"
                            : "#a6b1ab"
                      }
                    />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                </NodeActions.Provider>
              </PreviewSources.Provider>
            </AssetNames.Provider>
          </AssetContext.Provider>
          {!nodes.length && (
            <div className="canvas-empty">
              <div className="empty-node-mark">
                <Video size={36} />
              </div>
              <h2>{title}</h2>
              <div className="actions">
                <button
                  className="primary"
                  onClick={() => addNode("generation")}
                >
                  <Plus size={17} />
                  添加生成节点
                </button>
                <button onClick={() => setAssetMode("node")}>
                  <UploadIcon />
                  添加素材
                </button>
              </div>
            </div>
          )}
        </div>
        {panel && (
          <aside className="inspector">
            {!chosen ? (
              <div className="inspector-empty">
                <Settings2 size={26} />
                <h3>画布</h3>
                <p>
                  {nodes.length} 个节点 · {edges.length} 条连接
                </p>
                <button onClick={() => addNode("generation")}>
                  <Plus size={16} />
                  添加生成节点
                </button>
                <button onClick={() => addNode("image")}>
                  <Image size={16} />
                  添加图片节点
                </button>
                <button onClick={() => addNode("preview")}>
                  <Play size={16} />
                  添加预览节点
                </button>
                <button
                  onClick={() => {
                    downloadBlob(
                      new Blob(
                        [
                          JSON.stringify(
                            safeContent(nodes, edges, viewport.current),
                            null,
                            2,
                          ),
                        ],
                        { type: "application/json" },
                      ),
                      `${title}.json`,
                    );
                  }}
                >
                  <Download size={16} />
                  导出画布
                </button>
                <button
                  onClick={() =>
                    action.run(async () =>
                      setRevisions(await api(`/projects/${id}/revisions`)),
                    )
                  }
                >
                  <History size={16} />
                  历史版本
                </button>
                <label className="button">
                  导入画布
                  <input
                    type="file"
                    accept="application/json"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f)
                        action.run(async () => {
                          const c = JSON.parse(await f.text());
                          if (
                            !Array.isArray(c.nodes) ||
                            !Array.isArray(c.edges)
                          )
                            throw new Error("画布格式不正确");
                          checkpoint();
                          setNodes(c.nodes);
                          setEdges(normalizeCanvasEdges(c.nodes, c.edges));
                        });
                    }}
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="inspector-head">
                  <h2>
                    {chosen.type === "generation"
                      ? "生成设置"
                      : chosen.type === "asset"
                        ? "素材设置"
                        : chosen.type === "image"
                          ? "图片生成"
                          : chosen.type === "group"
                            ? "分组"
                            : chosen.type === "text"
                              ? "文本与灵感"
                              : "便签"}
                  </h2>
                  <IconButton
                    title="删除节点"
                    onClick={() =>
                      void flow.deleteElements({ nodes: [{ id: chosen.id }] })
                    }
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
                {chosen.type === "capability" ? (
                  <CapabilityPanel
                    key={chosen.id}
                    data={chosen.data}
                    projectId={id}
                    nodeId={chosen.id}
                    boundPrompt={
                      edges
                        .filter((e) => e.target === chosen.id)
                        .map((e) => nodes.find((n) => n.id === e.source))
                        .find((n) => n?.type === "text")?.data.text
                    }
                    boundReferences={edges
                      .filter((e) => e.target === chosen.id)
                      .flatMap((e) => {
                        const n = nodes.find((n) => n.id === e.source);
                        const asset =
                          n?.type === "asset"
                            ? n.data.asset_id
                            : n?.type === "image"
                              ? n.data.result_asset_id
                              : undefined;
                        return asset ? [{ asset_id: asset }] : [];
                      })}
                    onUpdate={(value) => update(value, chosen.id)}
                  />
                ) : chosen.type === "generation" ? (
                  <div className="inspector-content">
                    <label className="field">
                      节点名称
                      <input
                        value={chosen.data.label}
                        onChange={(e) => update({ label: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      生成模式
                      <select
                        aria-label="生成模式"
                        value={chosen.data.mode}
                        onChange={(e) => {
                          update({
                            mode: e.target.value,
                            parameters: {
                              ...chosen.data.parameters,
                              ...(e.target.value === "extend"
                                ? { ratio: "adaptive" }
                                : {}),
                            },
                          });
                        }}
                      >
                        {MODES.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      模型
                      <select
                        aria-label="模型"
                        value={chosen.data.model}
                        onChange={(e) => update({ model: e.target.value })}
                      >
                        {!videoModelOptions.some(
                          (m) => m.model === chosen.data.model,
                        ) && (
                          <option value={chosen.data.model} disabled>
                            {chosen.data.model} · 已下架
                          </option>
                        )}
                        {videoModelOptions.map((m) => (
                          <option key={m.model} value={m.model}>
                            {m.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="field-label">
                      提示词
                      <span>
                        {Array.from(chosen.data.prompt || "").length} / 20000
                      </span>
                      <IconButton
                        title="提示词辅助"
                        onClick={() => setAssistant(true)}
                      >
                        <WandSparkles size={16} />
                      </IconButton>
                    </div>
                    <textarea
                      className="prompt-input"
                      aria-label="提示词"
                      value={chosen.data.prompt}
                      onChange={(e) => update({ prompt: e.target.value })}
                      rows={6}
                      placeholder="描述画面、动作、镜头与声音"
                    />
                    {chosen.data.mode !== "text" && (
                      <section className="media-inputs">
                        <div className="field-label">
                          输入素材
                          <span>{chosen.data.media?.length || 0} / 20</span>
                          <IconButton
                            title="选择素材"
                            onClick={() => setAssetMode("input")}
                          >
                            <Plus size={16} />
                          </IconButton>
                          <IconButton
                            title="输入素材地址"
                            onClick={() => setUrlOpen(true)}
                          >
                            <LinkIcon />
                          </IconButton>
                        </div>
                        {(chosen.data.media || []).map(
                          (m: Media, i: number) => {
                            const name =
                              assets.data?.find((a) => a.id === m.asset_id)
                                ?.name ||
                              m.url?.slice(0, 70) ||
                              m.asset_id;
                            return (
                              <div className="media-input-row" key={i}>
                                <span className="reference-label">
                                  {mediaReferenceLabels(chosen.data.media)[i]}
                                </span>
                                <select
                                  aria-label={`素材 ${i + 1} 用途`}
                                  value={m.type}
                                  onChange={(e) =>
                                    update({
                                      media: chosen.data.media.map(
                                        (v: Media, j: number) =>
                                          i === j
                                            ? { ...v, type: e.target.value }
                                            : v,
                                      ),
                                    })
                                  }
                                >
                                  {MEDIA_TYPES.map((t) => (
                                    <option key={t} value={t}>
                                      {MEDIA_LABELS[t]}
                                    </option>
                                  ))}
                                </select>
                                <small title={name}>{name}</small>
                                <div className="actions">
                                  <IconButton
                                    title="上移素材"
                                    disabled={!i}
                                    onClick={() => {
                                      const media = [...chosen.data.media];
                                      [media[i - 1], media[i]] = [
                                        media[i],
                                        media[i - 1],
                                      ];
                                      update({ media });
                                    }}
                                  >
                                    <ArrowUp size={14} />
                                  </IconButton>
                                  <IconButton
                                    title="下移素材"
                                    disabled={
                                      i === chosen.data.media.length - 1
                                    }
                                    onClick={() => {
                                      const media = [...chosen.data.media];
                                      [media[i + 1], media[i]] = [
                                        media[i],
                                        media[i + 1],
                                      ];
                                      update({ media });
                                    }}
                                  >
                                    <ArrowDown size={14} />
                                  </IconButton>
                                  <IconButton
                                    title="删除素材"
                                    onClick={() =>
                                      update({
                                        media: chosen.data.media.filter(
                                          (_v: Media, j: number) => j !== i,
                                        ),
                                      })
                                    }
                                  >
                                    <X size={14} />
                                  </IconButton>
                                </div>
                              </div>
                            );
                          },
                        )}
                        {edges
                          .filter((e) => e.target === chosen.id)
                          .map((e) => (
                            <div className="connected-input" key={e.id}>
                              <GitBranch size={14} />
                              <span>
                                {nodes.find((n) => n.id === e.source)?.data
                                  .label ||
                                  nodes.find((n) => n.id === e.source)?.data
                                    .name}
                              </span>
                              <IconButton
                                title="移除连接"
                                onClick={() => {
                                  checkpoint();
                                  setEdges((es) =>
                                    es.filter((x) => x.id !== e.id),
                                  );
                                }}
                              >
                                <X size={14} />
                              </IconButton>
                            </div>
                          ))}
                      </section>
                    )}
                    <div className="two-fields">
                      <label className="field">
                        分辨率
                        <select
                          aria-label="分辨率"
                          value={chosen.data.parameters.resolution}
                          onChange={(e) =>
                            update({
                              parameters: {
                                ...chosen.data.parameters,
                                resolution: e.target.value,
                              },
                            })
                          }
                        >
                          {RESOLUTIONS.map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        画幅
                        <select
                          aria-label="画幅"
                          value={chosen.data.parameters.ratio}
                          disabled={chosen.data.mode === "extend"}
                          onChange={(e) =>
                            update({
                              parameters: {
                                ...chosen.data.parameters,
                                ratio: e.target.value,
                              },
                            })
                          }
                        >
                          {RATIOS.map((r) => (
                            <option key={r} value={r}>
                              {r === "adaptive" ? "自适应" : r}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className="field">
                      {chosen.data.mode === "extend"
                        ? "延长后完整输出时长"
                        : "输出时长"}
                      <div className="duration-control">
                        <input
                          aria-label="输出时长"
                          type="number"
                          min={2}
                          max={30}
                          disabled={chosen.data.parameters.duration === -1}
                          value={
                            chosen.data.parameters.duration === -1
                              ? ""
                              : chosen.data.parameters.duration
                          }
                          onChange={(e) =>
                            update({
                              parameters: {
                                ...chosen.data.parameters,
                                duration: Number(e.target.value),
                              },
                            })
                          }
                        />
                        <span>秒</span>
                        <label className="check-field">
                          <input
                            type="checkbox"
                            checked={chosen.data.parameters.duration === -1}
                            onChange={(e) =>
                              update({
                                parameters: {
                                  ...chosen.data.parameters,
                                  duration: e.target.checked ? -1 : 5,
                                },
                              })
                            }
                          />
                          智能
                        </label>
                      </div>
                    </label>
                    <label className="field">
                      随机种子
                      <input
                        type="number"
                        min={-1}
                        max={2147483647}
                        value={chosen.data.parameters.seed}
                        onChange={(e) =>
                          update({
                            parameters: {
                              ...chosen.data.parameters,
                              seed: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    {[
                      ["audio", "生成声音"],
                      ["prompt_extend", "智能改写"],
                      ["watermark", "添加水印"],
                    ].map(([key, label]) => (
                      <label className="toggle-field" key={key}>
                        <span>{label}</span>
                        <input
                          type="checkbox"
                          checked={chosen.data.parameters[key]}
                          onChange={(e) =>
                            update({
                              parameters: {
                                ...chosen.data.parameters,
                                [key]: e.target.checked,
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    <button
                      className="primary full"
                      disabled={action.busy}
                      onClick={() => runNode(chosen.id)}
                    >
                      <Play size={17} />
                      获取报价并生成
                    </button>
                    {chosen.data.taskId && (
                      <button
                        className="full"
                        onClick={() =>
                          setTaskDetail(
                            tasks.find((t) => t.id === chosen.data.taskId) || {
                              id: chosen.data.taskId,
                            },
                          )
                        }
                      >
                        查看当前任务
                      </button>
                    )}
                    {chosen.data.result_asset_id && (
                      <div className="two-fields">
                        <button onClick={() => editChosenResult("edit")}>
                          <Scissors size={16} />
                          编辑结果
                        </button>
                        <button onClick={() => editChosenResult("extend")}>
                          <Expand size={16} />
                          延长结果
                        </button>
                      </div>
                    )}
                  </div>
                ) : chosen.type === "note" || chosen.type === "text" ? (
                  <div className="text-inspector-content">
                    <textarea
                      className={
                        chosen.type === "text" ? "text-editor" : "note-editor"
                      }
                      aria-label={
                        chosen.type === "text" ? "文本内容" : "便签内容"
                      }
                      value={chosen.data.text}
                      onChange={(e) => update({ text: e.target.value })}
                    />
                    {chosen.type === "text" && (
                      <PromptOptimizer
                        key={chosen.id}
                        nodeId={chosen.id}
                        text={chosen.data.text || ""}
                        enabled={!!chosen.data.optimizeEnabled}
                        model={chosen.data.optimizeModel}
                        reasoning={chosen.data.optimizeReasoning}
                        onSettings={(value) => update(value, chosen.id)}
                        onText={(text) => update({ text }, chosen.id)}
                      />
                    )}
                  </div>
                ) : chosen.type === "image" ? (
                  <div className="inspector-content">
                    <label className="field">
                      生成模式
                      <select
                        value={chosen.data.mode || "text"}
                        onChange={(e) => update({ mode: e.target.value })}
                      >
                        <option value="text">文生图</option>
                        <option value="image">图生图 / 编辑</option>
                      </select>
                    </label>
                    <label className="field">
                      提示词
                      <textarea
                        value={chosen.data.prompt || ""}
                        onChange={(e) => update({ prompt: e.target.value })}
                        placeholder="描述主体、构图、光线和风格"
                        rows={4}
                      />
                    </label>
                    <label className="field">
                      模型
                      <select
                        value={chosen.data.model || "qwen-image-3.0"}
                        onChange={(e) => {
                          const model = e.target.value;
                          const capability =
                            (MODEL_CAPABILITIES as Row)[model] ||
                            MODEL_CAPABILITIES["qwen-image-3.0"];
                          const size =
                            chosen.data.parameters?.size || "1024x1024";
                          const dimensions =
                            size === "auto" ? [] : size.split("x").map(Number);
                          const capped =
                            dimensions.length &&
                            Math.max(...dimensions) > capability.maxPixels
                              ? "2048x2048"
                              : size;
                          const nextParameters: Row = {
                            ...DEFAULT_IMAGE_PARAMETERS,
                            ...chosen.data.parameters,
                            size: capped,
                          };
                          const unsupported =
                            capability.provider === "qwen"
                              ? [
                                  "quality",
                                  "background",
                                  "output_format",
                                  "output_compression",
                                  "moderation",
                                ]
                              : [
                                  "negative_prompt",
                                  "seed",
                                  "prompt_extend",
                                  "prompt_extend_mode",
                                  "enable_thinking",
                                  "watermark",
                                ];
                          for (const key of unsupported)
                            delete nextParameters[key];
                          update({
                            model,
                            mode: capability.maxImages
                              ? chosen.data.mode || "text"
                              : "text",
                            parameters: nextParameters,
                          });
                        }}
                      >
                        {!imageModelOptions.some(
                          (m) => m.model === chosen.data.model,
                        ) && (
                          <option value={chosen.data.model} disabled>
                            {chosen.data.model} · 已下架
                          </option>
                        )}
                        {imageModelOptions.map((model) => (
                          <option key={model.model} value={model.model}>
                            {model.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(() => {
                      const model = chosen.data.model || "qwen-image-3.0";
                      const capability =
                        (MODEL_CAPABILITIES as Row)[model] ||
                        MODEL_CAPABILITIES["qwen-image-3.0"];
                      const parameters = {
                        ...DEFAULT_IMAGE_PARAMETERS,
                        ...(chosen.data.parameters || {}),
                        size:
                          chosen.data.parameters?.size ||
                          String(chosen.data.resolution || "1024x1024").replace(
                            "*",
                            "x",
                          ),
                      };
                      const categories = ["1K", "2K", "4K"];
                      const options = Object.entries(SIZE_PRESETS).flatMap(
                        ([category, values]) =>
                          categories.indexOf(category) <=
                          categories.indexOf(capability.maxSize)
                            ? values.map((size) => [size, category] as const)
                            : [],
                      );
                      const results: string[] = Array.isArray(
                        chosen.data.result_asset_ids,
                      )
                        ? chosen.data.result_asset_ids
                        : chosen.data.result_asset_id
                          ? [chosen.data.result_asset_id]
                          : [];
                      const setParameter = (key: string, value: any) =>
                        update({ parameters: { ...parameters, [key]: value } });
                      const active = [
                        "QUEUED",
                        "SUBMITTING",
                        "PENDING",
                        "RUNNING",
                        "SAVING",
                      ].includes(chosen.data.status);
                      return (
                        <>
                          {chosen.data.mode === "image" &&
                            capability.maxImages > 0 && (
                              <section className="media-inputs">
                                <div className="field-label">
                                  参考图片
                                  <span>
                                    {chosen.data.images?.length || 0} /{" "}
                                    {capability.maxImages}
                                  </span>
                                  <IconButton
                                    title="从资产库选择参考图片"
                                    onClick={() => setAssetMode("input")}
                                    disabled={
                                      (chosen.data.images?.length || 0) >=
                                      capability.maxImages
                                    }
                                  >
                                    <Plus size={16} />
                                  </IconButton>
                                </div>
                                {(chosen.data.images || []).map(
                                  (image: Row, index: number) => {
                                    const asset = assets.data?.find(
                                      (item) => item.id === image.asset_id,
                                    );
                                    return (
                                      <div
                                        className="media-input-row"
                                        key={image.asset_id || index}
                                      >
                                        <span>
                                          {asset?.name || `图片 ${index + 1}`}
                                        </span>
                                        <IconButton
                                          title="移除参考图片"
                                          onClick={() =>
                                            update({
                                              images: chosen.data.images.filter(
                                                (_item: Row, i: number) =>
                                                  i !== index,
                                              ),
                                            })
                                          }
                                        >
                                          <X size={14} />
                                        </IconButton>
                                      </div>
                                    );
                                  },
                                )}
                                {edges
                                  .filter((edge) => edge.target === chosen.id)
                                  .map((edge) => (
                                    <div
                                      className="connected-input"
                                      key={edge.id}
                                    >
                                      <GitBranch size={14} />
                                      <span>
                                        {nodes.find(
                                          (node) => node.id === edge.source,
                                        )?.data.label ||
                                          nodes.find(
                                            (node) => node.id === edge.source,
                                          )?.data.name ||
                                          "连接素材"}
                                      </span>
                                      <IconButton
                                        title="移除连接"
                                        onClick={() =>
                                          setEdges((current) =>
                                            current.filter(
                                              (item) => item.id !== edge.id,
                                            ),
                                          )
                                        }
                                      >
                                        <X size={14} />
                                      </IconButton>
                                    </div>
                                  ))}
                              </section>
                            )}
                          <label className="field">
                            输出尺寸
                            <select
                              value={parameters.size}
                              onChange={(event) =>
                                setParameter("size", event.target.value)
                              }
                            >
                              <option value="auto">自动推荐</option>
                              {options.map(([size, category]) => (
                                <option key={size} value={size}>
                                  {size.replace("x", " × ")} · {category}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="two-fields">
                            <label className="field">
                              图片数量
                              <input
                                type="number"
                                min={1}
                                max={capability.maxN}
                                value={parameters.n}
                                onChange={(event) =>
                                  setParameter(
                                    "n",
                                    Math.min(
                                      capability.maxN,
                                      Math.max(
                                        1,
                                        Number(event.target.value) || 1,
                                      ),
                                    ),
                                  )
                                }
                              />
                            </label>
                            {capability.provider === "openai" ? (
                              <label className="field">
                                质量
                                <select
                                  value={parameters.quality || "auto"}
                                  onChange={(event) =>
                                    setParameter("quality", event.target.value)
                                  }
                                >
                                  <option value="auto">自动</option>
                                  <option value="low">低</option>
                                  <option value="medium">中</option>
                                  <option value="high">高</option>
                                </select>
                              </label>
                            ) : (
                              <label className="field">
                                随机种子
                                <input
                                  type="number"
                                  min={-1}
                                  max={2147483647}
                                  value={parameters.seed}
                                  onChange={(event) =>
                                    setParameter(
                                      "seed",
                                      Number(event.target.value),
                                    )
                                  }
                                />
                              </label>
                            )}
                          </div>
                          {capability.provider === "qwen" ? (
                            <>
                              <label className="field">
                                改写方式
                                <select
                                  value={parameters.prompt_extend_mode}
                                  onChange={(event) =>
                                    setParameter(
                                      "prompt_extend_mode",
                                      event.target.value,
                                    )
                                  }
                                >
                                  <option value="direct">直接增强</option>
                                  <option
                                    value="agent"
                                    disabled={chosen.data.mode === "image"}
                                  >
                                    智能体增强
                                  </option>
                                </select>
                              </label>
                              <label className="field">
                                负面提示词
                                <textarea
                                  value={parameters.negative_prompt || ""}
                                  maxLength={4500}
                                  rows={3}
                                  onChange={(event) =>
                                    setParameter(
                                      "negative_prompt",
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                              {[
                                ["prompt_extend", "智能改写"],
                                ["enable_thinking", "增强推理"],
                                ["watermark", "添加水印"],
                              ].map(([key, label]) => (
                                <label className="toggle-field" key={key}>
                                  <span>{label}</span>
                                  <input
                                    type="checkbox"
                                    checked={!!parameters[key]}
                                    onChange={(event) =>
                                      setParameter(key, event.target.checked)
                                    }
                                  />
                                </label>
                              ))}
                            </>
                          ) : (
                            <>
                              <div className="two-fields">
                                <label className="field">
                                  输出格式
                                  <select
                                    value={parameters.output_format || "png"}
                                    onChange={(event) =>
                                      setParameter(
                                        "output_format",
                                        event.target.value,
                                      )
                                    }
                                  >
                                    <option value="png">PNG</option>
                                    <option value="jpeg">JPEG</option>
                                    <option value="webp">WebP</option>
                                  </select>
                                </label>
                                <label className="field">
                                  背景
                                  <select
                                    value={parameters.background || "auto"}
                                    onChange={(event) =>
                                      update({
                                        parameters: {
                                          ...parameters,
                                          background: event.target.value,
                                          ...(event.target.value ===
                                            "transparent" &&
                                          parameters.output_format === "jpeg"
                                            ? { output_format: "png" }
                                            : {}),
                                        },
                                      })
                                    }
                                  >
                                    <option value="auto">自动</option>
                                    <option value="opaque">不透明</option>
                                    <option value="transparent">透明</option>
                                  </select>
                                </label>
                              </div>
                              {["jpeg", "webp"].includes(
                                parameters.output_format,
                              ) && (
                                <label className="field">
                                  压缩质量
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={parameters.output_compression ?? 100}
                                    onChange={(event) =>
                                      setParameter(
                                        "output_compression",
                                        Number(event.target.value),
                                      )
                                    }
                                  />
                                </label>
                              )}
                            </>
                          )}
                          {chosen.data.error && (
                            <p className="error-text">{chosen.data.error}</p>
                          )}
                          <button
                            className="primary full"
                            disabled={action.busy || active}
                            onClick={() => runImageNode(chosen.id)}
                          >
                            <Play size={16} />
                            {active
                              ? IMAGE_STATUS_LABELS[chosen.data.status]
                              : "获取报价并生成"}
                          </button>
                          {chosen.data.taskId && (
                            <button
                              className="full"
                              onClick={() =>
                                setTaskDetail({
                                  ...(imageTasks.find(
                                    (task: Row) =>
                                      task.id === chosen.data.taskId,
                                  ) || { id: chosen.data.taskId }),
                                  image: true,
                                })
                              }
                            >
                              查看当前任务
                            </button>
                          )}
                          {chosen.data.taskId &&
                            chosen.data.status === "QUEUED" && (
                              <button
                                className="full"
                                onClick={() =>
                                  action.run(async () => {
                                    await post(
                                      `/image-generations/${chosen.data.taskId}/cancel`,
                                    );
                                    void imageTasksQuery.refetch();
                                  }, "图片任务已取消")
                                }
                              >
                                取消任务
                              </button>
                            )}
                          {results.length > 0 && (
                            <div className="image-result-grid">
                              {results.map((assetId, index) => (
                                <img
                                  key={assetId}
                                  src={`/api/v1/assets/${assetId}/content`}
                                  alt={`生成结果 ${index + 1}`}
                                  loading="lazy"
                                />
                              ))}
                            </div>
                          )}
                          {chosen.data.charged > 0 && (
                            <p className="muted">
                              实际扣费 {money(chosen.data.charged)}
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : chosen.type === "asset" ? (
                  <div className="inspector-content">
                    <button onClick={() => setAssetMode("input")}>
                      替换素材
                    </button>
                    <p className="muted asset-node-hint">
                      连接到生成节点的具体输入点后，系统会按该输入点使用素材类型。
                    </p>
                    <Link className="button" to="/assets">
                      前往资产库
                    </Link>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      checkpoint();
                      setNodes((ns) =>
                        ns
                          .filter((n) => n.id !== chosen.id)
                          .map((n) =>
                            n.parentId === chosen.id
                              ? {
                                  ...n,
                                  parentId: undefined,
                                  extent: undefined,
                                  position: {
                                    x: n.position.x + chosen.position.x,
                                    y: n.position.y + chosen.position.y,
                                  },
                                }
                              : n,
                          ),
                      );
                    }}
                  >
                    取消分组
                  </button>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      <Modal
        title="资产库"
        open={!!assetMode}
        onClose={() => setAssetMode(null)}
        wide
      >
        <Assets
          onDeleted={async (assetId) => {
            checkpoint();
            const removed = new Set(
              nodes
                .filter(
                  (node) =>
                    node.type === "asset" && node.data.asset_id === assetId,
                )
                .map((node) => node.id),
            );
            setNodes((current) =>
              current
                .filter((node) => !removed.has(node.id))
                .map((node) =>
                  node.type === "generation" && Array.isArray(node.data.media)
                    ? {
                        ...node,
                        data: {
                          ...node.data,
                          media: node.data.media.filter(
                            (item: Media) => item.asset_id !== assetId,
                          ),
                        },
                      }
                    : node.type === "image" && Array.isArray(node.data.images)
                      ? {
                          ...node,
                          data: {
                            ...node.data,
                            images: node.data.images.filter(
                              (item: Row) => item.asset_id !== assetId,
                            ),
                          },
                        }
                      : node,
                ),
            );
            setEdges((current) =>
              current.filter(
                (edge) =>
                  !removed.has(edge.source) && !removed.has(edge.target),
              ),
            );
            if (selected && removed.has(selected)) setSelected(null);
            const refreshed = await project.refetch();
            if (refreshed.data) {
              version.current = refreshed.data.version;
              viewport.current =
                refreshed.data.content?.viewport || viewport.current;
              saved.current = contentSignature(
                safeContent(
                  refreshed.data.content?.nodes || [],
                  refreshed.data.content?.edges || [],
                  viewport.current,
                ),
              );
              savedTitle.current = refreshed.data.name;
            }
          }}
          onSelect={(a) => {
            if (assetMode === "node") {
              checkpoint();
              setNodes((ns) => [
                ...ns,
                {
                  id: uid(),
                  type: "asset",
                  position: position(),
                  data: {
                    asset_id: a.id,
                    name: a.name,
                    kind: a.kind,
                  },
                },
              ]);
            } else if (chosen?.type === "asset")
              update({ asset_id: a.id, name: a.name, kind: a.kind });
            else if (chosen?.type === "image") {
              if (a.kind !== "image") {
                notify("图片节点仅接受图片素材", true);
                return;
              }
              const capability =
                (MODEL_CAPABILITIES as Row)[
                  chosen.data.model || "qwen-image-3.0"
                ] || MODEL_CAPABILITIES["qwen-image-3.0"];
              const images = chosen.data.images || [];
              if (images.length >= capability.maxImages) {
                notify(
                  `该模型最多支持 ${capability.maxImages} 张参考图片`,
                  true,
                );
                return;
              }
              update({
                mode: "image",
                images: [
                  ...images,
                  { type: "reference_image", asset_id: a.id },
                ],
              });
            } else if (chosen) {
              const type =
                a.kind === "image"
                  ? chosen.data.mode === "first"
                    ? "first_frame"
                    : chosen.data.mode === "frames"
                      ? chosen.data.media?.some(
                          (m: Media) => m.type === "first_frame",
                        )
                        ? "last_frame"
                        : "first_frame"
                      : "reference_image"
                  : a.kind === "video"
                    ? "reference_video"
                    : a.kind === "audio"
                      ? "reference_audio"
                      : a.kind;
              update({
                media: [...(chosen.data.media || []), { type, asset_id: a.id }],
              });
            }
            setAssetMode(null);
          }}
        />
      </Modal>
      <Modal title="素材地址" open={urlOpen} onClose={() => setUrlOpen(false)}>
        <EditForm
          initial={{ type: "reference_image" }}
          fields={[
            {
              key: "type",
              label: "用途",
              options: MEDIA_TYPES.map((t) => [t, MEDIA_LABELS[t]]),
            },
            {
              key: "url",
              label: "HTTP(S) / 图片 Base64 / 临时 OSS URL",
              type: "textarea",
              required: true,
            },
            {
              key: "credential_id",
              label: "临时 OSS 原渠道 ID（仅临时 OSS 必填）",
            },
          ]}
          onSubmit={(v) => {
            update({
              media: [
                ...(chosen?.data.media || []),
                {
                  type: v.type,
                  url: v.url,
                  ...(v.url.startsWith("oss://")
                    ? {
                        binding: {
                          credential_id: v.credential_id,
                          model: chosen?.data.model,
                        },
                      }
                    : {}),
                },
              ],
            });
            setUrlOpen(false);
          }}
        />
      </Modal>
      <Modal
        title="提示词辅助"
        open={assistant}
        onClose={() => setAssistant(false)}
      >
        <EditForm
          fields={[
            { key: "story", label: "画面 / 分镜", type: "textarea" },
            { key: "dialogue", label: "台词 / 旁白" },
            { key: "music", label: "音乐 / 环境音" },
            { key: "style", label: "风格 / 镜头" },
            { key: "avoid", label: "需要避免的内容" },
            {
              key: "extension",
              label: "延长方向",
              options: [
                ["", "不添加"],
                ["forward", "向后延长"],
                ["backward", "向前补全"],
                ["both", "双向延长"],
              ],
            },
          ]}
          submit="加入提示词"
          onSubmit={(v) => {
            const lines = [
              chosen?.data.prompt,
              v.story,
              v.dialogue && `台词与旁白：${v.dialogue}`,
              v.music && `声音：${v.music}`,
              v.style && `风格与镜头：${v.style}`,
              v.avoid && `避免：${v.avoid}`,
              v.extension &&
                (
                  {
                    forward: "将视频1向后延长，保持连贯。",
                    backward: "在视频1前添加片段，衔接原视频开头。",
                    both: "在视频1前后分别扩展片段，保持主体与情节连贯。",
                  } as Row
                )[v.extension],
            ].filter(Boolean);
            update({ prompt: lines.join("\n") });
            setAssistant(false);
          }}
        />
      </Modal>
      <Modal title="确认生成" open={!!quote} onClose={() => setQuote(null)}>
        {quote && (
          <>
            {quote.kind === "image" ? (
              <>
                <div className="quote-total">
                  <span>图片生成预算上限</span>
                  <strong>{money(quote.reserved)}</strong>
                </div>
                <div className="detail-grid">
                  <span>模型 / 尺寸</span>
                  <b>
                    {quote.input.model} · {quote.sizeCategory}
                    {quote.autoSize ? "（自动档位预占）" : ""}
                  </b>
                  <span>输入图片</span>
                  <b>{quote.inputCount} 张</b>
                  <span>生成数量</span>
                  <b>{quote.outputCount} 张</b>
                  <span>输入 / 输出单价</span>
                  <b>
                    {money(quote.inputPrice)} / {money(quote.outputPrice)} 每张
                  </b>
                </div>
                <p className="muted">
                  按实际输入和生成结果结算；自动尺寸按最高档预占，余额不足时不会提交。
                </p>
                <button
                  className="primary full"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const task = await api("/image-generations", {
                        method: "POST",
                        headers: { "Idempotency-Key": quote.idempotency },
                        body: JSON.stringify({
                          ...quote.input,
                          quote: quote.token,
                        }),
                      });
                      update(
                        {
                          taskId: task.id,
                          status: task.status,
                          result_asset_id: null,
                          result_asset_ids: [],
                          error: null,
                        },
                        quote.input.node_id,
                      );
                      setQuote(null);
                      void imageTasksQuery.refetch();
                    }, "图片任务已提交")
                  }
                >
                  <Image size={16} />
                  确认并生成
                </button>
              </>
            ) : (
              <>
                <div className="quote-total">
                  <span>本次冻结上限</span>
                  <strong>{money(quote.reserved)}</strong>
                </div>
                <div className="detail-grid">
                  <span>输入视频</span>
                  <b>{quote.inputDuration.toFixed(2)} 秒</b>
                  <span>计费时长{quote.intelligent ? "上限" : ""}</span>
                  <b>{quote.estimatedSeconds} 秒</b>
                  <span>站内单价</span>
                  <b>{money(quote.unitPrice)} / 秒</b>
                </div>
                <p className="muted">
                  按实际用量结算，多余冻结金额自动退回。任务进入生成状态后不能取消。
                </p>
                <button
                  className="primary full"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      const t = await api("/generations", {
                        method: "POST",
                        headers: { "Idempotency-Key": quote.idempotency },
                        body: JSON.stringify({
                          input: quote.input,
                          quoteToken: quote.token,
                        }),
                      });
                      update(
                        {
                          taskId: t.id,
                          status: t.status,
                          result_asset_id: null,
                        },
                        quote.input.node_id,
                      );
                      setQuote(null);
                    }, "任务已提交")
                  }
                >
                  <Play size={16} />
                  确认并生成
                </button>
              </>
            )}
          </>
        )}
      </Modal>
      <Modal title="确认批次" open={!!batch} onClose={() => setBatch(null)}>
        {batch && (
          <>
            <p>{batch.count} 个生成节点</p>
            <div className="quote-total">
              <span>批次最高预算</span>
              <strong>{money(batch.maximum)}</strong>
            </div>
            <p>
              节点按依赖依次提交并逐项冻结余额。价格变化、余额不足或前序失败时停止后续提交。已提交的任务继续运行。
            </p>
            <button
              className="primary"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await post("/workflows", { token: batch.token });
                  setBatch(null);
                  setHistory(true);
                }, "批次已开始")
              }
            >
              确认运行
            </button>
          </>
        )}
      </Modal>
      <Modal
        title="生成记录"
        open={history}
        onClose={() => setHistory(false)}
        wide
      >
        <div className="actions">
          <button onClick={() => setCompare(true)}>结果对比</button>
        </div>
        {!tasks.length && !imageTasks.length ? (
          <Empty text="暂无生成任务" />
        ) : tasks.length > 0 ? (
          tasks.map((t) => (
            <div className="task-history-row" key={t.id}>
              {t.result_asset_id && (
                <video
                  preload="metadata"
                  controls
                  src={`/api/v1/assets/${t.result_asset_id}/content`}
                />
              )}
              <div>
                <strong>
                  {MODES.find((m) => m[0] === t.mode)?.[1]} ·{" "}
                  {STATUS_LABELS[t.status]}
                </strong>
                <small>
                  {date(t.created_at)} · {money(t.charged)}
                </small>
                <p>{t.input.input.prompt.slice(0, 100)}</p>
                <div className="actions">
                  <button onClick={() => setTaskDetail(t)}>详情</button>
                  <button
                    onClick={() =>
                      useResult({ ...t, result_asset_id: null }, t.mode)
                    }
                  >
                    复用参数
                  </button>
                  {t.result_asset_id && (
                    <>
                      <button onClick={() => useResult(t, "edit")}>编辑</button>
                      <button onClick={() => useResult(t, "extend")}>
                        延长
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : null}
        {imageTasks.map((task: Row) => {
          const resultAssets: string[] = task.result_assets || [];
          return (
            <div
              className="task-history-row image-task-history-row"
              key={`image-${task.id}`}
            >
              {resultAssets[0] && (
                <img
                  src={`/api/v1/assets/${resultAssets[0]}/content`}
                  alt="图片生成结果"
                  loading="lazy"
                />
              )}
              <div>
                <strong>
                  {task.mode === "image" ? "图生图 / 编辑" : "文生图"} ·{" "}
                  {IMAGE_STATUS_LABELS[task.status] || task.status}
                </strong>
                <small>
                  {task.model} · {task.parameters?.size || "auto"} ·{" "}
                  {date(task.created_at)} · {money(task.charged)}
                </small>
                <p>{String(task.prompt || "").slice(0, 100)}</p>
                {task.error && <span className="error-text">{task.error}</span>}
                <div className="actions">
                  <button
                    onClick={() => setTaskDetail({ ...task, image: true })}
                  >
                    详情
                  </button>
                  <button onClick={() => useImageResult(task)}>复用参数</button>
                  {resultAssets.length > 0 && (
                    <button onClick={() => useImageResult(task, true)}>
                      用作参考图
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <h3>批次</h3>
        {(workflows.data || [])
          .filter((r) => r.project_id === id)
          .map((r) => (
            <div className="list-row" key={r.id}>
              <span>
                {date(r.created_at)} · {r.status}
              </span>
              <span>
                {r.steps.filter((s: Row) => s.state === "DONE").length}/
                {r.steps.length}
              </span>
              {r.error && <span className="error-text">{r.error}</span>}
              {r.status === "RUNNING" && (
                <button
                  onClick={() =>
                    action.run(() => post(`/workflows/${r.id}/stop`))
                  }
                >
                  停止后续提交
                </button>
              )}
            </div>
          ))}
      </Modal>
      <Modal
        title="结果对比"
        open={compare}
        onClose={() => setCompare(false)}
        wide
      >
        <div className="compare-grid">
          {[0, 1].map((i) => (
            <ComparePanel
              key={i}
              tasks={tasks.filter((t) => t.result_asset_id)}
              initial={i}
            />
          ))}
        </div>
      </Modal>
      <Modal
        title="历史版本"
        open={!!revisions}
        onClose={() => setRevisions(null)}
      >
        {revisions?.map((r) => (
          <div className="list-row" key={r.id}>
            <span>
              版本 {r.version} · {date(r.created_at)}
            </span>
            <button
              onClick={() => {
                checkpoint();
                setNodes(r.content.nodes);
                setEdges(
                  normalizeCanvasEdges(r.content.nodes, r.content.edges),
                );
                setRevisions(null);
              }}
            >
              恢复到画布
            </button>
          </div>
        ))}
      </Modal>
      <Modal title="发现本机草稿" open={!!draft} onClose={() => setDraft(null)}>
        <p>本机存在 {draft && date(draft.at)} 未同步的修改。</p>
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              checkpoint();
              setNodes(draft!.content.nodes);
              setEdges(
                normalizeCanvasEdges(
                  draft!.content.nodes,
                  draft!.content.edges,
                ),
              );
              if (draft!.name) setTitle(draft!.name);
              if (draft!.content.viewport) {
                viewport.current = draft!.content.viewport;
                void flow.setViewport(draft!.content.viewport);
              }
              setDraft(null);
            }}
          >
            恢复草稿
          </button>
          <button
            onClick={() => {
              void del(`canvas:${id}`);
              setDraft(null);
            }}
          >
            使用服务器版本
          </button>
        </div>
      </Modal>
      {taskDetail && (
        <TaskDetail task={taskDetail} onClose={() => setTaskDetail(null)} />
      )}
      <Modal
        title="删除运行中的节点"
        open={!!deletion}
        onClose={() => {
          deletion?.resolve(false);
          setDeletion(null);
        }}
      >
        <p>
          删除节点不会停止已提交任务，费用仍按实际用量结算。结果可以在使用记录中找到。
        </p>
        <div className="actions">
          <button
            onClick={() => {
              deletion?.resolve(true);
              setDeletion(null);
            }}
          >
            仅删除节点
          </button>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                for (const n of deletion?.items || []) {
                  if (
                    n.type === "generation" &&
                    ["QUEUED", "PENDING"].includes(n.data.status)
                  )
                    await post(`/generations/${n.data.taskId}/cancel`);
                  if (n.type === "image" && n.data.status === "QUEUED")
                    await post(`/image-generations/${n.data.taskId}/cancel`);
                }
                deletion?.resolve(true);
                setDeletion(null);
              })
            }
          >
            取消可取消任务并删除
          </button>
        </div>
      </Modal>
    </div>
  );
}
function ComparePanel({ tasks, initial }: { tasks: Row[]; initial: number }) {
  const [index, setIndex] = useState(initial);
  const t = tasks[index] || tasks[0];
  return (
    <div>
      <select
        aria-label="对比结果"
        value={Math.min(index, Math.max(tasks.length - 1, 0))}
        onChange={(e) => setIndex(Number(e.target.value))}
      >
        {tasks.map((t, i) => (
          <option key={t.id} value={i}>
            {date(t.created_at)} · {t.model}
          </option>
        ))}
      </select>
      {t ? (
        <video controls src={`/api/v1/assets/${t.result_asset_id}/content`} />
      ) : (
        <Empty text="暂无结果" />
      )}
    </div>
  );
}
function UploadIcon() {
  return <ImagePlus size={16} />;
}
function LinkIcon() {
  return <ArrowRight size={16} />;
}
