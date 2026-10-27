# 图片生成功能集成进度

## 已完成

### 1. 核心数据模型 (shared/image.ts)
- ✅ 5个模型定义：qwen-image-3.0-pro, qwen-image-3.0, gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst
- ✅ 分辨率分类：1K, 2K, 4K
- ✅ 生成模式：文生图、图生图
- ✅ 完整的参数 Schema：size, n, seed, negative_prompt, prompt_extend, watermark 等
- ✅ 价格定义（元/张）
- ✅ 验证逻辑：validateImageGeneration

### 2. 后端 API (server/images.ts)
- ✅ 报价接口：POST /api/v1/image-quotes
- ✅ 提交任务：POST /api/v1/image-generations
- ✅ 查询任务：GET /api/v1/image-generations/:id
- ✅ 列表查询：GET /api/v1/image-generations
- ✅ 取消任务：POST /api/v1/image-generations/:id/cancel
- ✅ 任务调度：dispatchImageTask (支持 Qwen 和 GPT 两种渠道)
- ✅ 结果保存：saveImageResults (转存图片、结算费用)

### 3. 数据库设计 (migrations_image.sql → schema.sql)
- ✅ image_prices 表：存储各模型各档位的价格
- ✅ image_credentials 表：图片生成渠道（qwen/openai）
- ✅ image_tasks 表：图片生成任务记录
- ✅ image_task_events 表：任务事件日志
- ✅ 初始价格数据插入（13个价格档位）
- ✅ 集成到 schema.sql 和 db.ts migrate 函数

### 4. Worker 集成 (server/worker.ts, server/main.ts)
- ✅ 集成 dispatchImageTask 到主循环
- ✅ 集成 saveImageResults 到主循环
- ✅ 路由注册：image-quotes 和 image-generations

### 5. 财务模块适配 (server/finance.ts)
- ✅ walletEntry 函数兼容新旧两种调用方式
- ✅ walletReserve 新增事务版本
- ✅ 冻结/解冻逻辑适配图片任务
- ✅ 图片任务失败时正确释放冻结金额

### 6. 画布图逻辑 (src/canvas-image-graph.ts)
- ✅ 图片生成节点的端口定义
- ✅ 输入验证逻辑
- ✅ 连线解析和检查

### 7. 管理后台 (src/admin.tsx)
- ✅ 图片渠道管理页面
  - Qwen 渠道：provider, name, workspace, key, priority, enabled
  - GPT 渠道：provider, name, baseUrl, key, priority, enabled
- ✅ 图片价格管理
  - model, size_category, input_official, input_sale, output_official, output_sale
- ✅ 字段定义：imageCredentialFields, imagePriceFields
- ✅ columns 定义：image-prices, image-credentials
- ✅ create 函数支持图片价格和渠道
- ✅ save 函数支持图片数据处理
- ✅ Modal 标题和预览支持

### 8. 前端组件 (src/)
- ✅ image-node.tsx: 图片生成节点组件
- ✅ image-panel.tsx: 图片生成配置面板
- ✅ types.ts: 图片相关类型定义

## 待完成

### 1. 前端画布集成 (src/canvas.tsx)
- ⏳ 将 ImageNode 注册到 nodeTypes
- ⏳ 添加创建图片节点的按钮
- ⏳ 集成 ImagePanel 到画布侧边栏
- ⏳ 处理图片节点的连线逻辑

### 2. 后端 API 实现
- ⏳ 实现管理后台的图片价格 CRUD 接口
- ⏳ 实现管理后台的图片渠道 CRUD 接口

### 3. 前端页面
- ⏳ 图片模型广场（类似视频模型）
- ⏳ 图片使用记录
- ⏳ 集成到主导航

### 4. 测试
- ⏳ Qwen 同步生图测试
- ⏳ GPT 生图测试（已有临时 API key）
- ⏳ 价格计算验证
- ⏳ 多张生成测试
- ⏳ 图生图测试
- ⏳ 端到端集成测试

## 技术要点

### Qwen 接口特点
- 同步调用（无异步任务）
- OpenAI 兼容模式或 DashScope 原生协议
- 支持图生图（最多3张）
- 支持负面提示词、增强推理
- 按像素面积分档：≤2,250,000 为 1K，否则 2K

### GPT 接口特点
- 第三方中转，走 OpenAI 格式
- 仅文生图，不支持图生图
- 返回 b64_json 格式
- 支持 4K 分辨率
- quality 参数（standard/hd）

### 价格体系
- 按张计费，区分输入/输出
- Qwen 有输入计费（图生图），GPT 无输入计费
- 预占机制：提交时冻结最大可能费用
- 结算时按实际生成数量扣费

### 渠道管理
- Qwen：image_credentials 表（provider='qwen'）
- GPT：image_credentials 表（provider='openai'）
- 加密存储 API Key
- 优先级调度

## 下一步行动

1. 实现管理后台的图片价格和渠道 CRUD API
2. 在 canvas.tsx 中集成图片节点
3. 端到端测试
4. 完善文档
5. 部署上线

## 文件清单

### 后端
- ✅ shared/image.ts - 核心模型和验证
- ✅ server/images.ts - API 和调度逻辑
- ✅ server/schema.sql - 数据库表定义
- ✅ server/db.ts - 价格初始化
- ✅ server/finance.ts - 财务适配
- ✅ server/worker.ts - Worker 集成
- ✅ server/main.ts - 路由注册

### 前端
- ✅ src/admin.tsx - 管理后台
- ✅ src/canvas-image-graph.ts - 画布图逻辑
- ✅ src/image-node.tsx - 节点组件
- ✅ src/image-panel.tsx - 配置面板
- ✅ src/types.ts - 类型定义
- ⏳ src/canvas.tsx - 画布集成（待完成）

### 文档
- ✅ docs/IMAGE_GENERATION_PROGRESS.md - 进度追踪
