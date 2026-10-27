import { IMAGE_MODEL_IDS, MODEL_CAPABILITIES } from "../shared/image";

export type ImagePort = "prompt" | "reference_image";
export type ImageGraphNode = {
  id: string;
  type?: string;
  data: Record<string, any>;
};
export type ImageGraphEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export const IMAGE_MODE_PORTS: Record<string, ImagePort[]> = {
  text: ["prompt"],
  image: ["prompt", "reference_image"],
};

export function imageKindForPort(port: ImagePort) {
  if (port === "reference_image") return "image";
  if (port === "prompt") return "text";
  return port;
}

export function allowedImagePorts(mode: string, kind: string): ImagePort[] {
  return (IMAGE_MODE_PORTS[mode] || IMAGE_MODE_PORTS.text).filter(
    (port) => imageKindForPort(port) === kind,
  );
}

export function resolveImagePort(
  edge: ImageGraphEdge,
  source: ImageGraphNode,
  target: ImageGraphNode,
  used: ImagePort[],
): ImagePort {
  if (edge.targetHandle) return edge.targetHandle as ImagePort;
  if (source.type === "text") return "prompt";
  if (source.type === "image-generation" || source.type === "image") {
    return "reference_image";
  }
  if (source.type === "asset" && source.data.kind === "image") {
    return "reference_image";
  }
  const options = allowedImagePorts(target.data.mode, source.data.kind);
  return options.find((port) => !used.includes(port)) || options[0] || "prompt";
}

export function imagePortIssue(
  mode: string,
  port: ImagePort,
  kind: string,
  existing: ImagePort[],
  model: string,
): string | null {
  if (!(IMAGE_MODE_PORTS[mode] || IMAGE_MODE_PORTS.text).includes(port))
    return "当前生成模式没有这个输入连接点";
  if (imageKindForPort(port) !== kind) return "素材类型与连接点不匹配";
  if (port === "prompt")
    return existing.includes("prompt") ? "文本输入最多连接 1 个节点" : null;

  const capability = MODEL_CAPABILITIES[model as keyof typeof MODEL_CAPABILITIES];
  if (!capability) return "未知的模型";

  const images = existing.filter((p) => p === "reference_image");
  if (images.length >= capability.maxImages) {
    return `该模型最多支持 ${capability.maxImages} 张参考图片`;
  }

  return null;
}

export function incomingImageBindings(
  target: ImageGraphNode,
  nodes: ImageGraphNode[],
  edges: ImageGraphEdge[],
) {
  const bindings: { source: ImageGraphNode; port: ImagePort; edge: ImageGraphEdge }[] = [];
  const used: ImagePort[] = (target.data.images || []).map(() => "reference_image" as ImagePort);

  for (const edge of edges.filter((item) => item.target === target.id)) {
    const source = nodes.find((node) => node.id === edge.source);
    if (!source || source.type === "preview") continue;
    const port = resolveImagePort(edge, source, target, used);
    bindings.push({ source, port, edge });
    used.push(port);
  }
  return bindings;
}

export function checkImageInputs(
  target: ImageGraphNode,
  nodes: ImageGraphNode[],
  edges: ImageGraphEdge[],
) {
  const used: ImagePort[] = [];

  // 检查现有的图片输入
  for (const img of target.data.images || []) {
    const issue = imagePortIssue(target.data.mode || "text", "reference_image", "image", used, target.data.model);
    if (issue) throw new Error(issue);
    used.push("reference_image");
  }

  // 检查连线输入
  for (const { source, port } of incomingImageBindings(target, nodes, edges)) {
    const kind =
      source.type === "image-generation" || source.type === "image"
        ? "image"
        : source.type === "text"
          ? "text"
          : source.data.kind;
    if (!["image-generation", "image", "text", "asset"].includes(source.type || ""))
      throw new Error("此节点不能作为生成输入");
    const issue = imagePortIssue(target.data.mode, port, kind, used, target.data.model);
    if (issue) throw new Error(issue);
    used.push(port);
  }
  return used;
}

export function imageReferenceName(ordinal: number) {
  return `图片${ordinal}`;
}
