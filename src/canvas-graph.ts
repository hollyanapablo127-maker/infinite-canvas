import {
  MEDIA_LABELS,
  MEDIA_LIMITS,
  MEDIA_TYPES,
  type Media,
} from "../shared/wan";

export type Port = "prompt" | (typeof MEDIA_TYPES)[number];
export type GraphNode = {
  id: string;
  type?: string;
  data: Record<string, any>;
};
export type GraphEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export const MODE_PORTS: Record<string, Port[]> = {
  text: ["prompt"],
  first: ["prompt", "first_frame"],
  frames: ["prompt", "first_frame", "last_frame"],
  reference: [
    "prompt",
    "first_frame",
    "last_frame",
    "reference_image",
    "reference_video",
    "reference_audio",
    "file",
    "link",
  ],
  file: [
    "prompt",
    "file",
    "link",
    "reference_image",
    "reference_video",
    "reference_audio",
  ],
  edit: ["prompt", "reference_video", "reference_image", "reference_audio"],
  extend: ["prompt", "reference_video", "reference_image", "reference_audio"],
};

export function kindForPort(port: Port) {
  if (["first_frame", "last_frame", "reference_image"].includes(port))
    return "image";
  if (port === "reference_video") return "video";
  if (port === "reference_audio") return "audio";
  if (port === "prompt") return "text";
  return port;
}

export function allowedPorts(mode: string, kind: string): Port[] {
  return (MODE_PORTS[mode] || MODE_PORTS.text).filter(
    (port) => kindForPort(port) === kind,
  );
}

export function resolvePort(
  edge: GraphEdge,
  source: GraphNode,
  target: GraphNode,
  used: Port[],
): Port {
  if (edge.targetHandle) return edge.targetHandle as Port;
  if (source.type === "text") return "prompt";
  if (source.type === "generation") {
    if (target.data.mode === "first") return "first_frame";
    if (target.data.mode === "frames")
      return used.includes("first_frame") ? "last_frame" : "first_frame";
    return "reference_video";
  }
  if (source.type === "asset" && source.data.kind === "image" && target.data.mode === "reference")
    return "reference_image";
  const options = allowedPorts(target.data.mode, source.data.kind);
  return options.find((port) => !used.includes(port)) || options[0] || "prompt";
}

export function portIssue(
  mode: string,
  port: Port,
  kind: string,
  existing: Port[],
): string | null {
  if (!(MODE_PORTS[mode] || MODE_PORTS.text).includes(port))
    return "当前生成模式没有这个输入连接点";
  if (kindForPort(port) !== kind) return "素材类型与连接点不匹配";
  if (port === "prompt")
    return existing.includes("prompt") ? "文本输入最多连接 1 个节点" : null;
  const media = existing.filter((type) => type !== "prompt");
  if (media.length >= 20) return "输入素材最多 20 个";
  const limit = MEDIA_LIMITS[port];
  if (media.filter((type) => type === port).length >= limit)
    return `${MEDIA_LABELS[port]}最多 ${limit} 个`;
  const frames = ["first_frame", "last_frame"];
  const other = MEDIA_TYPES.filter((type) => !frames.includes(type));
  if (
    (frames.includes(port) &&
      media.some((type) => other.includes(type as any))) ||
    (other.includes(port) && media.some((type) => frames.includes(type)))
  )
    return "首尾帧不能与参考素材、文件或网页混用";
  if (
    (port === "file" && media.includes("link")) ||
    (port === "link" && media.includes("file"))
  )
    return "文件和网页不能同时使用";
  return null;
}

export function incomingBindings(
  target: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
) {
  const bindings: { source: GraphNode; port: Port; edge: GraphEdge }[] = [];
  const used: Port[] = (target.data.media || []).map((m: Media) => m.type);
  for (const edge of edges.filter((item) => item.target === target.id)) {
    const source = nodes.find((node) => node.id === edge.source);
    if (!source || source.type === "preview") continue;
    const port = resolvePort(edge, source, target, used);
    bindings.push({ source, port, edge });
    used.push(port);
  }
  return bindings;
}

export function checkInputs(
  target: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
) {
  const used: Port[] = [];
  for (const item of target.data.media || []) {
    const port = item.type as Port;
    const issue = portIssue(target.data.mode, port, kindForPort(port), used);
    if (issue) throw new Error(issue);
    used.push(port);
  }
  for (const { source, port } of incomingBindings(target, nodes, edges)) {
    const kind =
      source.type === "generation"
        ? ["first_frame", "last_frame"].includes(port)
          ? "image"
          : "video"
        : source.type === "text"
          ? "text"
          : source.data.kind;
    if (!["generation", "text", "asset"].includes(source.type || ""))
      throw new Error("此节点不能作为生成输入");
    const issue = portIssue(target.data.mode, port, kind, used);
    if (issue) throw new Error(issue);
    used.push(port);
  }
  return used;
}

export function effectiveMode(mode: string, media: Pick<Media, "type">[]) {
  if (mode !== "reference") return mode;
  if (media.some((item) => item.type === "last_frame")) return "frames";
  if (media.some((item) => item.type === "first_frame")) return "first";
  return mode;
}

export function referenceName(type: Port, ordinal: number) {
  if (type === "reference_image") return `图片${ordinal}`;
  if (type === "reference_video") return `视频${ordinal}`;
  if (type === "reference_audio") return `音频${ordinal}`;
  return MEDIA_LABELS[type] || "文本";
}
