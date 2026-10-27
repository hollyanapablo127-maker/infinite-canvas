// 图片生成任务
export interface ImageGeneration {
  id: string;
  user_id: string;
  project_id: string;
  node_id: string;
  prompt: string;
  negative_prompt?: string;
  model: string;
  resolution: string;
  n: number;
  seed?: number;
  ref_image?: string;
  ref_strength?: number;
  style?: string;
  status: "draft" | "pending" | "running" | "succeeded" | "failed";
  result_url?: string;
  error_message?: string;
  estimated_cost: number;
  actual_cost?: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

// 图片渠道
export interface ImageCredential {
  id: string;
  name: string;
  type: "qwen" | "openai";
  api_key: string;
  base_url?: string;
  region?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// 图片定价
export interface ImagePrice {
  id: string;
  model: string;
  resolution: string;
  official: number;
  sale: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
