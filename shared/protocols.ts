export const PROTOCOLS = {
  "openai-chat": {
    label: "OpenAI 兼容 · Chat SSE",
    types: ["language"],
    provider: "any",
    transport: "sse",
    adapter: "",
    unit: "million_tokens",
  },
  "openai-image": {
    label: "OpenAI 图片 · GPT Image 系列",
    types: ["image"],
    provider: "openai",
    transport: "http",
    adapter: "gpt-image-2",
    unit: "request",
  },
  "bailian-image": {
    label: "百炼图片 · Qwen Image 系列",
    types: ["image"],
    provider: "bailian",
    transport: "http",
    adapter: "qwen-image-3.0",
    unit: "request",
  },
  "bailian-video": {
    label: "百炼视频 · 万相原生异步",
    types: ["video"],
    provider: "bailian",
    transport: "async",
    adapter: "wan3.0-video",
    unit: "second",
  },
  "bailian-multimodal": {
    label: "百炼原生 · 多模态理解",
    types: ["language"],
    provider: "bailian",
    transport: "sse",
    adapter: "",
    unit: "million_tokens",
  },
  "bailian-tts": {
    label: "百炼 · Qwen TTS",
    types: ["speech"],
    provider: "bailian",
    transport: "http",
    adapter: "",
    unit: "million_characters",
  },
  "bailian-audio": {
    label: "百炼 · 语音合成 / 音效生成",
    types: ["speech"],
    provider: "bailian",
    transport: "http",
    adapter: "",
    unit: "second",
  },
  "bailian-asr": {
    label: "百炼 · 录音文件识别",
    types: ["speech"],
    provider: "bailian",
    transport: "async",
    adapter: "",
    unit: "second",
  },
  "bailian-asr-chat": {
    label: "百炼 · 短音频识别（Chat）",
    types: ["speech"],
    provider: "bailian",
    transport: "sse",
    adapter: "",
    unit: "second",
  },
  "bailian-omni": {
    label: "百炼 · 全模态 Chat",
    types: ["language", "speech"],
    provider: "bailian",
    transport: "sse",
    adapter: "",
    unit: "million_tokens",
  },
  "bailian-3d": {
    label: "百炼 · Tripo 3D 异步",
    types: ["threed"],
    provider: "bailian",
    transport: "async",
    adapter: "",
    unit: "request",
  },
  happyoyster: {
    label: "百炼 · HappyOyster 世界模型",
    types: ["world"],
    provider: "bailian",
    transport: "rtc",
    adapter: "",
    unit: "second",
  },
  "bailian-realtime": {
    label: "百炼 · 实时多模态 Realtime WS",
    types: ["realtime"],
    provider: "bailian",
    transport: "websocket",
    adapter: "",
    unit: "second",
  },
  "bailian-inference": {
    label: "百炼 · 实时语音 Inference WS",
    types: ["realtime"],
    provider: "bailian",
    transport: "websocket",
    adapter: "",
    unit: "second",
  },
} as const;
export type ProtocolId = keyof typeof PROTOCOLS;
export const PROTOCOL_IDS = Object.keys(PROTOCOLS) as ProtocolId[];
export function protocolFor(
  type: string,
  adapter = "",
  model = "",
): ProtocolId {
  if (type === "image")
    return adapter.startsWith("gpt-") || model.startsWith("gpt-")
      ? "openai-image"
      : "bailian-image";
  if (type === "video") return "bailian-video";
  if (type === "speech") return "bailian-tts";
  if (type === "threed") return "bailian-3d";
  if (type === "world") return "happyoyster";
  if (type === "realtime") return "bailian-realtime";
  return "openai-chat";
}
export const BAILIAN_MODEL_PRESETS = [
  {
    model: "qwen-plus",
    type: "language",
    protocol: "openai-chat",
    label: "通义千问 · 文本",
  },
  {
    model: "qwen3-vl-plus",
    type: "language",
    protocol: "openai-chat",
    label: "千问视觉理解",
  },
  {
    model: "qwen-image-2.1-turbo",
    type: "image",
    protocol: "bailian-image",
    label: "千问图像生成 / 编辑",
  },
  {
    model: "wan2.7-t2v",
    type: "video",
    protocol: "bailian-video",
    label: "万相文生视频",
  },
  {
    model: "qwen3-tts-flash",
    type: "speech",
    protocol: "bailian-tts",
    label: "千问语音合成",
  },
  {
    model: "qwen-audio-3.1-tts-next",
    type: "speech",
    protocol: "bailian-audio",
    label: "音效 / 语音生成",
  },
  {
    model: "qwen3-asr-flash-filetrans",
    type: "speech",
    protocol: "bailian-asr",
    label: "录音文件识别",
  },
  {
    model: "qwen3-asr-flash",
    type: "speech",
    protocol: "bailian-asr-chat",
    label: "短音频识别",
  },
  {
    model: "qwen3-omni-flash",
    type: "language",
    protocol: "bailian-omni",
    label: "全模态理解",
  },
  {
    model: "Tripo/Tripo-H3.1",
    type: "threed",
    protocol: "bailian-3d",
    label: "Tripo 文生 / 图生 3D",
  },
  {
    model: "happyoyster-1.0-adventure",
    type: "world",
    protocol: "happyoyster",
    label: "世界探索 · Adventure",
  },
  {
    model: "happyoyster-1.0-directing",
    type: "world",
    protocol: "happyoyster",
    label: "世界导演 · Directing",
  },
  {
    model: "happyoyster-1.0-acting",
    type: "world",
    protocol: "happyoyster",
    label: "世界演绎 · Acting",
  },
  {
    model: "qwen3.5-omni-plus-realtime",
    type: "realtime",
    protocol: "bailian-realtime",
    label: "实时多模态交互",
  },
  {
    model: "cosyvoice-v3-flash",
    type: "realtime",
    protocol: "bailian-inference",
    label: "实时语音合成",
  },
] as const;
export const BAILIAN_REGIONS = [
  ["cn-beijing", "华北 2 · 北京"],
  ["ap-southeast-1", "新加坡"],
  ["us-east-1", "美国 · 弗吉尼亚"],
] as const;
export function bailianHost(workspace: string, region: string) {
  return workspace
    ? `https://${workspace}.${region}.maas.aliyuncs.com`
    : region === "ap-southeast-1"
      ? "https://dashscope-intl.aliyuncs.com"
      : region === "us-east-1"
        ? "https://dashscope-us.aliyuncs.com"
        : "https://dashscope.aliyuncs.com";
}
export function apiRoot(base: string) {
  return base
    .replace(/\/api\/v1\/?$/, "")
    .replace(/\/(?:compatible-mode\/)?v1\/?$/, "")
    .replace(/\/+$/, "");
}
export function chatBase(base: string) {
  return /\/v1\/?$/.test(base) && !/\/api\/v1\/?$/.test(base)
    ? base.replace(/\/+$/, "")
    : `${apiRoot(base)}/compatible-mode/v1`;
}
