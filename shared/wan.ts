import { z } from "zod";
import { adapterModel, modelIdSchema } from "./catalog";

export const MODEL_IDS = ["wan3.0-video", "wan3.0-video-prime"] as const;
export const RESOLUTIONS = ["480P", "720P", "1080P"] as const;
export const RATIOS = [
  "adaptive",
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
export const MEDIA_TYPES = [
  "first_frame",
  "last_frame",
  "reference_image",
  "reference_video",
  "reference_audio",
  "file",
  "link",
] as const;
export const MODES = [
  ["text", "文生视频"],
  ["first", "首帧生视频"],
  ["frames", "首尾帧生视频"],
  ["reference", "全模态参考"],
  ["file", "文件 / 网页"],
  ["edit", "视频编辑"],
  ["extend", "视频延长"],
] as const;
export const MEDIA_LABELS: Record<string, string> = {
  first_frame: "首帧",
  last_frame: "尾帧",
  reference_image: "参考图片",
  reference_video: "参考视频",
  reference_audio: "参考音频",
  file: "文件",
  link: "网页",
};
export const MEDIA_LIMITS: Record<(typeof MEDIA_TYPES)[number], number> = {
  first_frame: 1,
  last_frame: 1,
  reference_image: 10,
  reference_video: 5,
  reference_audio: 5,
  file: 1,
  link: 1,
};
export const STATUS_LABELS: Record<string, string> = {
  QUEUED: "等待提交",
  SUBMITTING: "提交中",
  PENDING: "排队中",
  RUNNING: "生成中",
  SAVING: "保存中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELED: "已取消",
  CANCELING: "取消中",
  UNKNOWN: "待核实",
  RECONCILE: "账单待核对",
  DELIVERY_FAILED: "结果交付失败",
};
export const DEFAULT_PARAMETERS = {
  resolution: "1080P",
  ratio: "adaptive",
  duration: 5,
  audio: true,
  seed: -1,
  prompt_extend: true,
  watermark: false,
} as const;
export const OFFICIAL_PRICES: Record<string, Record<string, number>> = {
  "wan3.0-video": { "480P": 0.3, "720P": 0.6, "1080P": 1.2 },
  "wan3.0-video-prime": { "480P": 0.45, "720P": 0.9, "1080P": 1.8 },
};
export const FILE_EXTENSIONS = [
  "docx",
  "doc",
  "xlsx",
  "xls",
  "pptx",
  "ppt",
  "pdf",
  "txt",
  "key",
  "pages",
  "numbers",
  "md",
];
export const parametersSchema = z
  .object({
    resolution: z.enum(RESOLUTIONS).default("1080P"),
    ratio: z.enum(RATIOS).default("adaptive"),
    duration: z
      .number()
      .int()
      .refine(
        (v) => v === -1 || (v >= 2 && v <= 30),
        "时长应为 2-30 秒整数或智能时长",
      )
      .default(5),
    audio: z.boolean().default(true),
    seed: z.number().int().min(-1).max(2147483647).default(-1),
    prompt_extend: z.boolean().default(true),
    watermark: z.boolean().default(false),
  })
  .strict();
export const mediaSchema = z
  .object({
    type: z.enum(MEDIA_TYPES),
    asset_id: z.string().uuid().optional(),
    url: z.string().max(30_000_000).optional(),
    binding: z
      .object({
        credential_id: z.string().uuid(),
        model: modelIdSchema.refine(
          (model) =>
            (MODEL_IDS as readonly string[]).includes(adapterModel(model)),
          "视频模型未接入",
        ),
      })
      .optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.asset_id) !== Boolean(v.url),
    "请选择站内素材或填写 URL",
  );
export const generationSchema = z
  .object({
    model: modelIdSchema.refine(
      (model) => (MODEL_IDS as readonly string[]).includes(adapterModel(model)),
      "视频模型未接入",
    ),
    mode: z
      .enum(["text", "first", "frames", "reference", "file", "edit", "extend"])
      .default("text"),
    input: z
      .object({
        prompt: z.string().default(""),
        media: z.array(mediaSchema).max(20).default([]),
      })
      .strict(),
    parameters: parametersSchema.default({}),
    project_id: z.string().uuid().optional(),
    node_id: z.string().max(100).optional(),
  })
  .strict();
export type GenerationInput = z.infer<typeof generationSchema>;
export type Parameters = z.infer<typeof parametersSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type Mode = GenerationInput["mode"];
export type MediaMeta = {
  kind: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  pages?: number;
  hasAlpha?: boolean;
  extension?: string;
};

export function validateGeneration(raw: unknown, metadata: MediaMeta[] = []) {
  const data = generationSchema.parse(raw);
  const { media, prompt } = data.input;
  const issues: string[] = [];
  if (!prompt.trim() && !media.length) issues.push("提示词与素材至少填写一项");
  if (Array.from(prompt).length > 20000)
    issues.push("提示词不能超过 20000 字符");
  const counts = Object.fromEntries(
    MEDIA_TYPES.map((type) => [
      type,
      media.filter((m) => m.type === type).length,
    ]),
  );
  for (const [type, limit] of Object.entries(MEDIA_LIMITS)) {
    if (counts[type] > limit)
      issues.push(`${MEDIA_LABELS[type]}最多 ${limit} 个`);
  }
  const framed = counts.first_frame + counts.last_frame;
  if (framed && media.length > framed)
    issues.push("首尾帧不能与参考素材、文件或网页混用");
  if (counts.last_frame && !counts.first_frame)
    issues.push("尾帧需要同时指定首帧");
  if (counts.file && counts.link) issues.push("文件和网页不能同时使用");
  if ((counts.file || counts.link) && !data.parameters.prompt_extend)
    issues.push("文件或网页需要开启智能改写");
  if (data.mode === "text" && media.length) issues.push("文生视频不接受素材");
  if (data.mode === "first" && (counts.first_frame !== 1 || media.length !== 1))
    issues.push("首帧模式需要且仅需要一张首帧图");
  if (
    data.mode === "frames" &&
    (counts.first_frame !== 1 || counts.last_frame !== 1 || media.length !== 2)
  )
    issues.push("首尾帧模式需要首帧和尾帧各一张");
  if (
    ["reference", "file", "edit", "extend"].includes(data.mode) &&
    (!media.length || framed)
  )
    issues.push("请选择兼容的参考素材");
  if (data.mode === "file" && !counts.file && !counts.link)
    issues.push("请选择文件或网页");
  if (["edit", "extend"].includes(data.mode) && !counts.reference_video)
    issues.push("编辑与延长需要参考视频");
  if (["edit", "extend"].includes(data.mode) && !prompt.trim())
    issues.push("请描述编辑或延长意图");
  let videoDuration = 0;
  let audioDuration = 0;
  media.forEach((m, i) => {
    const meta = metadata[i];
    if (!meta) return;
    const image = ["first_frame", "last_frame", "reference_image"].includes(
      m.type,
    );
    const video = m.type === "reference_video";
    const audio = m.type === "reference_audio";
    const expected = image
      ? "image"
      : video
        ? "video"
        : audio
          ? "audio"
          : m.type;
    if (meta.kind !== expected) issues.push(`素材 ${i + 1} 与所选用途不匹配`);
    const maxSize = (image ? 20 : audio ? 15 : 100) * 1_000_000;
    if ((meta.size || 0) > maxSize)
      issues.push(`素材 ${i + 1} 超过文件大小限制`);
    if (image || video) {
      const maxSide = image ? 8000 : 4096;
      const { width = 0, height = 0 } = meta;
      if (
        Math.min(width, height) < 240 ||
        Math.max(width, height) > maxSide ||
        Math.max(width, height) / Math.min(width, height) > 8
      )
        issues.push(`素材 ${i + 1} 尺寸或长宽比不符合要求`);
    }
    if (image && meta.hasAlpha)
      issues.push(`素材 ${i + 1} 含透明通道，请先转换`);
    if (video || audio) {
      if (!meta.duration || meta.duration < 1 || meta.duration > 15)
        issues.push(`素材 ${i + 1} 时长须为 1-15 秒`);
      if (video && (meta.fps || 0) < 16)
        issues.push(`素材 ${i + 1} 帧率须至少 16fps`);
      if (video) videoDuration += meta.duration || 0;
      if (audio) audioDuration += meta.duration || 0;
    }
    if (m.type === "file" && (meta.pages || 0) > 50)
      issues.push(`素材 ${i + 1} 超过 50 页`);
  });
  if (videoDuration > 15.001) issues.push("输入视频总时长不能超过 15 秒");
  if (audioDuration > 15.001) issues.push("输入音频总时长不能超过 15 秒");
  if (
    data.parameters.duration !== -1 &&
    videoDuration + data.parameters.duration > 30.001
  )
    issues.push("输入视频与输出视频总时长不能超过 30 秒");
  if (issues.length) throw new Error(issues.join("；"));
  return {
    data,
    inputDuration: videoDuration,
    estimatedDuration:
      data.parameters.duration === -1
        ? 30
        : videoDuration + data.parameters.duration,
  };
}

export function mediaReferenceLabels(media: Pick<Media, "type">[]) {
  const count: Record<string, number> = {};
  return media.map((m) => {
    count[m.type] = (count[m.type] || 0) + 1;
    const prefix = (
      {
        reference_image: "图",
        reference_video: "视频",
        reference_audio: "音频",
      } as Record<string, string>
    )[m.type];
    return prefix ? `${prefix}${count[m.type]}` : MEDIA_LABELS[m.type];
  });
}
