import { z } from "zod";
import {
  adapterModel,
  modelIdSchema,
  modelCapabilityOverrides,
} from "./catalog";

export const IMAGE_MODEL_IDS = [
  "qwen-image-3.0-pro",
  "qwen-image-3.0",
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
] as const;

export const IMAGE_SIZE_CATEGORIES = ["1K", "2K", "4K"] as const;
export const IMAGE_SIZES = IMAGE_SIZE_CATEGORIES;
export const SIZE_PRESETS = {
  "1K": [
    "512x512",
    "768x1024",
    "1024x768",
    "1024x1024",
    "896x1152",
    "1152x896",
  ],
  "2K": [
    "1536x1024",
    "1024x1536",
    "1920x1080",
    "1080x1920",
    "2048x2048",
    "1536x2048",
    "2048x1536",
  ],
  "4K": ["3840x2160", "2160x3840", "4096x2160", "2160x4096"],
} as const;

export const IMAGE_MODES = [
  ["text", "文生图"],
  ["image", "图生图 / 编辑"],
] as const;

const BASE_MODEL_CAPABILITIES = {
  "qwen-image-3.0-pro": {
    provider: "qwen",
    maxImages: 3,
    maxSize: "2K",
    maxPixels: 2048,
    supportNegative: true,
    supportThinking: true,
    supportExtend: true,
    maxN: 6,
  },
  "qwen-image-3.0": {
    provider: "qwen",
    maxImages: 3,
    maxSize: "2K",
    maxPixels: 2048,
    supportNegative: true,
    supportThinking: true,
    supportExtend: true,
    maxN: 6,
  },
  "gpt-image-2": {
    provider: "openai",
    maxImages: 16,
    maxSize: "4K",
    maxPixels: 4096,
    supportNegative: false,
    supportThinking: false,
    supportExtend: false,
    maxN: 4,
  },
  "gpt-image-2.5-flare": {
    provider: "openai",
    maxImages: 16,
    maxSize: "4K",
    maxPixels: 4096,
    supportNegative: false,
    supportThinking: false,
    supportExtend: false,
    maxN: 4,
  },
  "gpt-image-2.5-sunburst": {
    provider: "openai",
    maxImages: 16,
    maxSize: "4K",
    maxPixels: 4096,
    supportNegative: false,
    supportThinking: false,
    supportExtend: false,
    maxN: 4,
  },
} as const;

export const MODEL_CAPABILITIES: Record<
  string,
  (typeof BASE_MODEL_CAPABILITIES)[keyof typeof BASE_MODEL_CAPABILITIES]
> = new Proxy(BASE_MODEL_CAPABILITIES, {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    const base = target[adapterModel(key) as keyof typeof target];
    if (!base) return undefined;
    return { ...base, ...modelCapabilityOverrides(key) };
  },
});

export const IMAGE_OFFICIAL_PRICES: Record<
  string,
  Record<string, { input: number; output: number }>
> = {
  "qwen-image-3.0-pro": {
    "1K": { input: 0.02, output: 0.25 },
    "2K": { input: 0.02, output: 0.5 },
  },
  "qwen-image-3.0": {
    "1K": { input: 0.02, output: 0.18 },
    "2K": { input: 0.02, output: 0.18 },
  },
  "gpt-image-2": {
    "1K": { input: 0, output: 0.08 },
    "2K": { input: 0, output: 0.1 },
    "4K": { input: 0, output: 0.15 },
  },
  "gpt-image-2.5-flare": {
    "1K": { input: 0, output: 0.1 },
    "2K": { input: 0, output: 0.14 },
    "4K": { input: 0, output: 0.2 },
  },
  "gpt-image-2.5-sunburst": {
    "1K": { input: 0, output: 0.1 },
    "2K": { input: 0, output: 0.14 },
    "4K": { input: 0, output: 0.2 },
  },
};

export const IMAGE_STATUS_LABELS: Record<string, string> = {
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

export const DEFAULT_IMAGE_PARAMETERS = {
  size: "1024x1024",
  n: 1,
  seed: -1,
  prompt_extend: true,
  prompt_extend_mode: "direct",
  enable_thinking: true,
  watermark: false,
} as const;

export const imageParametersSchema = z
  .object({
    size: z.string().regex(/^\d+x\d+$|^auto$/, "尺寸格式无效"),
    n: z.number().int().min(1).max(6).default(1),
    seed: z.number().int().min(-1).max(2147483647).default(-1),
    negative_prompt: z.string().max(4500).optional(),
    prompt_extend: z.boolean().default(true),
    prompt_extend_mode: z.enum(["direct", "agent"]).default("direct"),
    enable_thinking: z.boolean().default(true),
    watermark: z.boolean().default(false),
    quality: z.enum(["auto", "low", "medium", "high"]).optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
  })
  .strict();

export const imageInputSchema = z
  .object({
    type: z.literal("reference_image"),
    asset_id: z.string().uuid().optional(),
    url: z.string().max(30_000_000).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.asset_id) !== Boolean(v.url),
    "请选择站内素材或填写 URL",
  );

export const imageGenerationSchema = z
  .object({
    model: modelIdSchema.refine(
      (model) =>
        (IMAGE_MODEL_IDS as readonly string[]).includes(adapterModel(model)),
      "图片模型未接入",
    ),
    mode: z.enum(["text", "image"]).default("text"),
    input: z
      .object({
        prompt: z
          .string()
          .min(1, "请输入提示词")
          .max(4500, "提示词最多 4500 tokens"),
        images: z.array(imageInputSchema).max(16).default([]),
      })
      .strict(),
    parameters: imageParametersSchema.default(DEFAULT_IMAGE_PARAMETERS),
    project_id: z.string().uuid().optional(),
    node_id: z.string().max(100).optional(),
  })
  .strict();

export type ImageGenerationInput = z.infer<typeof imageGenerationSchema>;
export type ImageParameters = z.infer<typeof imageParametersSchema>;
export type ImageInput = z.infer<typeof imageInputSchema>;
export type ImageMode = ImageGenerationInput["mode"];

export type ImageMeta = {
  kind: string;
  extension?: string;
  size?: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
};

export function getSizeCategory(
  size: string,
  model?: string,
): "1K" | "2K" | "4K" {
  if (size === "auto") return "1K";
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return "1K";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const capability = model
    ? MODEL_CAPABILITIES[model as keyof typeof MODEL_CAPABILITIES]
    : undefined;
  if (capability?.provider === "qwen")
    return width * height <= 2_250_000 ? "1K" : "2K";
  const longestSide = Math.max(width, height);
  if (longestSide <= 1280) return "1K";
  if (longestSide <= 3072) return "2K";
  return "4K";
}

export function imageReserveCategory(size: string, model: string) {
  const capability =
    MODEL_CAPABILITIES[model as keyof typeof MODEL_CAPABILITIES];
  return size === "auto" ? capability.maxSize : getSizeCategory(size, model);
}

export function validateImageGeneration(
  raw: unknown,
  metadata: ImageMeta[] = [],
) {
  const data = imageGenerationSchema.parse(raw);
  const { images, prompt } = data.input;
  const issues: string[] = [];
  const capability = MODEL_CAPABILITIES[data.model];

  if (!prompt.trim()) issues.push("请输入提示词");
  if (Array.from(prompt).length > 4500) issues.push("提示词最多 4500 tokens");
  if (data.mode === "text" && images.length)
    issues.push("文生图模式不接受参考图片");
  if (data.mode === "image" && !images.length)
    issues.push("图生图模式需要至少一张参考图片");
  if (images.length > capability.maxImages)
    issues.push(`该模型最多支持 ${capability.maxImages} 张参考图片`);
  if (data.parameters.n > capability.maxN)
    issues.push(`该模型最多生成 ${capability.maxN} 张图片`);

  const sizeCategory = imageReserveCategory(data.parameters.size, data.model);
  const categories = ["1K", "2K", "4K"];
  if (categories.indexOf(sizeCategory) > categories.indexOf(capability.maxSize))
    issues.push(`该模型最大支持 ${capability.maxSize} 分辨率`);

  if (data.parameters.size !== "auto") {
    const [width, height] = data.parameters.size.split("x").map(Number);
    const area = width * height;
    const aspect = Math.max(width, height) / Math.min(width, height);
    if (
      width < 1 ||
      height < 1 ||
      Math.max(width, height) > capability.maxPixels ||
      area < 512 * 512 ||
      aspect > 8 ||
      (capability.provider === "qwen" && area > 2048 * 2048)
    )
      issues.push(
        `输出尺寸不符合该模型要求（最大 ${capability.maxPixels}px，比例不超过 8:1）`,
      );
  }

  if (data.parameters.negative_prompt && !capability.supportNegative)
    issues.push("该模型不支持负面提示词");
  if (data.parameters.prompt_extend_mode === "agent" && data.mode === "image")
    issues.push("图生图模式不支持 agent 改写模式");
  if (capability.provider === "qwen") {
    if (
      data.parameters.quality ||
      data.parameters.background ||
      data.parameters.output_format ||
      data.parameters.output_compression !== undefined ||
      data.parameters.moderation
    )
      issues.push("Qwen 模型不支持 GPT 图片参数");
  } else if (
    data.parameters.background === "transparent" &&
    !["png", "webp"].includes(data.parameters.output_format || "png")
  ) {
    issues.push("透明背景仅支持 PNG 或 WebP 格式");
  }

  images.forEach((img, i) => {
    const meta = metadata[i];
    if (!meta) return;
    if (meta.kind !== "image") issues.push(`素材 ${i + 1} 必须是图片`);
    if (
      capability.provider === "openai" &&
      meta.extension &&
      !["jpg", "jpeg", "png", "webp"].includes(meta.extension.toLowerCase())
    )
      issues.push(`素材 ${i + 1} 格式不受 GPT 图片编辑接口支持`);
    const maxInputSize =
      capability.provider === "qwen" ? 10_000_000 : 20_000_000;
    if ((meta.size || 0) > maxInputSize)
      issues.push(`素材 ${i + 1} 超过 ${maxInputSize / 1_000_000}MB 限制`);
    const { width = 0, height = 0 } = meta;
    if (
      Math.min(width, height) < 1 ||
      Math.max(width, height) > 8000 ||
      Math.max(width, height) / Math.min(width, height) > 10
    )
      issues.push(
        `素材 ${i + 1} 尺寸或长宽比不符合要求（1-8000px，最大比例10:1）`,
      );
  });

  if (issues.length) throw new Error(issues.join("；"));
  return {
    data,
    inputCount: images.length,
    outputCount: data.parameters.n,
    sizeCategory,
  };
}
