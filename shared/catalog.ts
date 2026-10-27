import { z } from "zod";

export const MODEL_TYPES = [
  "video",
  "image",
  "language",
  "speech",
  "threed",
  "world",
  "realtime",
] as const;
export type ModelType = (typeof MODEL_TYPES)[number];
export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  video: "视频",
  image: "图片",
  language: "语言",
  speech: "音频",
  threed: "3D",
  world: "世界",
  realtime: "实时多模态",
};
export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(150)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
    "模型 ID 仅支持字母、数字和 . _ : / -",
  );
const adapters = new Map<string, string>();
const capabilities = new Map<string, Record<string, unknown>>();
export function modelCapabilityOverrides(model: string) {
  return capabilities.get(model) || {};
}
export function registerModelAdapters(
  rows: Array<{
    model: string;
    adapter?: string;
    capabilities?: Record<string, unknown>;
  }>,
) {
  for (const row of rows) {
    if (row.adapter) adapters.set(row.model, row.adapter);
    if (row.capabilities) capabilities.set(row.model, row.capabilities);
  }
}
export function adapterModel(model: string) {
  return adapters.get(model) || model;
}
export const REASONING_OPTIONS = [
  ["auto", "自动 · 跟随模型默认"],
  ["none", "关闭思考"],
  ["minimal", "极轻"],
  ["low", "轻量"],
  ["medium", "均衡"],
  ["high", "深入"],
  ["xhigh", "最高"],
] as const;
