import { useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { Image, LoaderCircle, Sparkles } from "lucide-react";
import { IMAGE_STATUS_LABELS, MODEL_CAPABILITIES } from "../shared/image";
import type { Row } from "./lib";

export function ImageNode({ id, data, selected }: NodeProps) {
  const updateNodeInternals = useUpdateNodeInternals();
  const model = String(data.model || "qwen-image-3.0");
  const mode = String(data.mode || "text");
  const supportsImages = (MODEL_CAPABILITIES as Row)[model]?.maxImages > 0;
  const resultAssets: string[] = Array.isArray(data.result_asset_ids)
    ? data.result_asset_ids
    : data.result_asset_id
      ? [data.result_asset_id]
      : [];
  const status = String(data.status || "DRAFT").toUpperCase();
  const parameters = (data.parameters || {}) as Row;
  const size = parameters.size || data.resolution || "1024x1024";
  const prompt = String(data.prompt || "");

  useEffect(() => {
    const frame = requestAnimationFrame(() => updateNodeInternals(id));
    return () => cancelAnimationFrame(frame);
  }, [id, mode, supportsImages, resultAssets.length, updateNodeInternals]);

  return (
    <div className={`canvas-node image-generation-node ${selected ? "selected" : ""}`} data-status={status}>
      <div className="image-node-ports">
        <div className="node-port">
          <Handle id="prompt" type="target" position={Position.Left} />
          <span>提示词</span>
        </div>
        {mode === "image" && supportsImages && (
          <div className="node-port">
            <Handle id="reference_image" type="target" position={Position.Left} />
            <span>参考图</span>
          </div>
        )}
      </div>
      <div className="image-node-main">
        <div className="node-head">
          <Image size={16} />
          <strong>图片生成</strong>
          <span className={`node-status ${status === "SUCCEEDED" ? "positive" : ""}`}>
            {status === "DRAFT" ? "草稿" : IMAGE_STATUS_LABELS[status] || status}
          </span>
        </div>
        <div className="image-node-preview">
          {resultAssets[0] ? (
            <img
              src={`/api/v1/assets/${resultAssets[0]}/content`}
              alt="图片生成结果"
              loading="lazy"
            />
          ) : (
            <div className="generation-placeholder">
              {status === "QUEUED" || status === "SUBMITTING" || status === "PENDING" || status === "RUNNING" || status === "SAVING" ? (
                <LoaderCircle className="spin" size={24} />
              ) : (
                <Sparkles size={24} />
              )}
            </div>
          )}
        </div>
        <div className="node-body">
          <p title={prompt}>{prompt || "未填写提示词"}</p>
          <div className="node-meta">
            <span>{model}</span>
            <span>{size === "auto" ? "自动尺寸" : size}</span>
            <span>×{parameters.n || 1}</span>
          </div>
        </div>
      </div>
      <Handle id="image" type="source" position={Position.Right} />
    </div>
  );
}
