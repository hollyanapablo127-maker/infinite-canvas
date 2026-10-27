# 百炼全模态接入与渠道改造

2026-10-22。本次实现由主智能体开发；子智能体仅参与文档调研、方案预设计和只读审查。

## 连接与协议

一个「百炼 API」连接现在只对应一个管理记录，包含地域、Workspace ID、Base URL、加密 API Key、支持模型和映射。内部的视频、图片和语言凭据为兼容既有调度与历史任务而保留，不再在管理页面重复显示。

旧版本一次新增产生的双凭据，只在审计记录明确记载它们来自同一次创建、且密钥/空间/名称完全一致时归并；不会仅凭同名合并。旧任务与凭据版本不会删除。

协议属于请求/响应的家族，模型名称属于映射。例如 GPT Image 2 与 2.5 都使用 `openai-image`，并不各自创建一个协议。模型具体能力仍可能不同，不能把同协议理解为相同限额。

百炼地域的 API Key、域名、授权不可混用；推荐填写业务空间专属域名。创建界面的「百炼模型预设」只帮助填写模型、类型与协议，不会自动发布价格或发起付费调用。

## 已实现入口与生命周期

| 能力           | 协议家族                             | 实现                                                                                                                                                                       |
| -------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文本与视觉理解 | OpenAI Chat SSE / 百炼原生多模态 SSE | 文本、参考图片/音频的对话输出，增量展示，提交后自动保存结果；文本节点仍可使用 AI 提示词优化                                                                                |
| 图像           | Qwen Image 原生 / GPT Image 兼容     | 现有图片节点复用统一渠道，支持图像生成与编辑、尺寸价格、历史快照；按文档区分 Qwen 同步与异步 endpoint，并保留异步调度                                                      |
| 视频           | 百炼视频异步                         | 原有 Wan 3.0 流程保留；新视频协议使用 resolution/ratio/duration，提交、轮询、产物保存                                                                                      |
| 语音合成       | Qwen TTS / SpeechSynthesizer         | 合成文本与音色配置，返回音频保存为本站产物并用播放器播放                                                                                                                   |
| 音频生成       | Qwen Audio SpeechSynthesizer         | `text_prompt` 与可选参考音频生成音效/声音，自动保存产物                                                                                                                    |
| 语音识别       | Filetrans 异步 / Chat 短音频         | 文件引用、异步转写查询或 SSE 短音频转写，展示文本                                                                                                                          |
| 3D             | Tripo 异步                           | 文本/单图/四槽多图输入，轮询任务，及时保存 GLB 与预览图，浏览器旋转预览/下载                                                                                               |
| 世界           | HappyOyster REST + RTC               | Adventure、Directing、Acting 的世界创建与构建状态；后端获取 ticket 并进房，浏览器仅取得短期 RTC 参数，官方 RTC Core 播放与交互；支持模式允许的方向控制/指令/暂停/恢复/结束 |
| 实时多模态     | Realtime WebSocket                   | 站内一次性票据、服务端鉴权代理、文本/音频/视频帧输入、文字与音频输出、限时结算                                                                                             |
| 实时语音       | Inference WebSocket                  | run-task / continue-task / finish-task，服务端固定任务 ID 和模型，TTS/ASR 双向传输                                                                                         |

模型广场增加 3D、世界、实时多模态分类；「多模态工作台」与画布「多模态节点」提供这些能力的操作入口。音频和图像等私有输入需配置可公开访问的本站 HTTPS 地址或 OSS，以便上游读取签名素材。

实时音视频采集只有用户主动点击后开始，停止或离开页面释放设备。HappyOyster 不把长期 Key 或继承完整权限的临时 API Key 下发给浏览器，世界管理仍经本站后端，前端通过官方 `@happy-oyster/js-sdk-core` 消费 RTC 凭据。

## 删除、预算与恢复

渠道删除是软删除。未提交的队列任务和未开始的就绪会话取消并退回冻结预算；已提交异步任务继续使用凭据版本查询。历史任务与凭据版本保留。

新多模态任务使用签名报价、唯一请求键、专属倍率和价格快照。文本 token 预算包含参考素材预留；音频/实时会话按用户确认的预算时长预占。上游明确拒绝会释放预算；无法确认是否已受理的网络错误进入待核实，不自动重发付费请求。超预算用量进入人工核对，避免重复扣费。

管理员的「多模态任务核对」入口可查询未知任务、核对释放或结算。产物使用站内鉴权下载，受存储配额与30天保留期约束。

## 参考项目中采用的设计

参考 `E:/ProgramProjects/sub2api-main` 的逻辑渠道/凭据分层、模型映射与计费单位设计，没有复制 Go/Vue 实现。公告增加主动提醒/静默、排序与阅读人数；暂后处理按用户与公告版本去重，不会擅自标为已读。设置分组增加键盘方向键/Home/End导航，服务说明与联系邮箱可编辑并展示在登录页。

## 官方资料（阅读后实现）

- [获取 API Key](https://docs.bailian.console.aliyun.com/zh/model-studio/get-api-key)
- [地域与接入域名](https://help.aliyun.com/zh/model-studio/regions)
- [OpenAI 兼容](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [千问图像生成与编辑](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- [视频生成](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)
- [Qwen TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
- [音频生成](https://docs.bailian.console.aliyun.com/zh/model-studio/audio-generation-api)
- [语音识别](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [Tripo 3D](https://help.aliyun.com/zh/model-studio/tripo-3d-generation-api-reference)
- [HappyOyster 鉴权](https://help.aliyun.com/zh/model-studio/happyoyster-auth-setup)
- [HappyOyster Adventure](https://help.aliyun.com/zh/model-studio/happyoyster-adventure-create-world-api-reference)
- [HappyOyster Directing](https://help.aliyun.com/zh/model-studio/happyoyster-directing-create-world-api-reference)
- [HappyOyster Acting](https://help.aliyun.com/zh/model-studio/happyoyster-acting-create-world-api-reference)
- [HappyOyster Web SDK](https://help.aliyun.com/zh/model-studio/happyoyster-web-sdk-api-reference)
- [Realtime/Inference WebSocket](https://help.aliyun.com/zh/model-studio/realtime-websocket-overview)

真实调用受账号开通、地域、模型版本、容量和规格授权约束。自动测试使用本地模拟 HTTP/SSE/WebSocket 上游，不能视为真实百炼付费验收；生产使用前请用对应账号逐项验证并确认预算。

## 本轮回归验证

- 侧栏 hover 命中区固定，nav 禁止横向滚动；边缘小幅移动光标仍保持位置与尺寸。
- 同一渠道创建键重复提交只创建一次；支持编辑、撤销模型、清除映射回到同名与删除退款。
- 渠道删除后，已提交的异步任务仍通过凭据快照查询并保存产物。
- 本地模拟 HTTP、SSE、RTC进房 REST 和 WebSocket，验证实际协议字段、鉴权、票据复用拒绝和价格结算。
- 官方 RTC 与 3D 预览库按需加载，仅进入对应能力时下载；供应商库不加入常规模型广场首屏依赖。
