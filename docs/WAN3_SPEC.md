# Wan 3.0 完整适配清单

版本：v1.0；核对日期：2026-09-30；地域：华北2（北京）。  
本清单中的“已核对”仅表示文档事实已阅读，不表示已经实现或通过真实调用。所有实现与测试当前均未开始。

来源：

- [API 参考](https://docs.bailian.console.aliyun.com/zh/model-studio/wan3-video-generation-api-reference.md)
- [使用指南](https://docs.bailian.console.aliyun.com/zh/model-studio/wan3-video-generation-guide.md)
- [模型价格](https://docs.bailian.console.aliyun.com/zh/model-studio/model-pricing#wan30video_cn_h3)
- [提示词指南](https://docs.bailian.console.aliyun.com/zh/model-studio/wan3-video-generation-prompt-guide.md)
- [异步任务管理](https://docs.bailian.console.aliyun.com/zh/model-studio/manage-asynchronous-tasks.md)
- [临时文件 URL](https://docs.bailian.console.aliyun.com/zh/model-studio/get-temporary-file-url.md)
- [限流](https://docs.bailian.console.aliyun.com/zh/model-studio/rate-limit.md)

## 1. 模型与调用协议

| ID | 项目 | 官方规则 | 实现要求 |
| --- | --- | --- | --- |
| W-M01 | 标准版 | wan3.0-video | 独立模型目录项、六档价格之一组、使用记录保留精确 ID |
| W-M02 | 高速版 | wan3.0-video-prime；能力对齐标准版，端到端速度提升 | 与标准版共用能力 Schema，单独价格/配额/渠道配置 |
| W-M03 | 地域 | 模型、Endpoint、API Key 必须属于同一地域 | 只允许 cn-beijing；配置不匹配阻止启用 |
| W-M04 | 业务空间 | URL 中的 WorkspaceId 替换为真实业务空间 ID | 管理员必须配置，支持从 API Host 解析及校验 |
| W-M05 | 创建任务 | HTTP 异步调用 | 先创建获得 task_id，再查结果，不反复创建 |
| W-M06 | 常见耗时 | API 说明通常 1-5 分钟，并非 SLA | 展示排队/生成状态，不承诺固定完成时刻 |

创建：
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis

查询：
GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}

仅采用当前官方 Wan 3.0 的视频生成接口，不复用旧 Wan 2.x 的 image2video 等路径。

### 1.1 全部请求头

| ID | Header | 必须性/值 | 对应处理 |
| --- | --- | --- | --- |
| W-H01 | Content-Type | 创建必需，application/json | HTTP 客户端统一配置 |
| W-H02 | Authorization | 创建/查询必需，Bearer 上游百炼 API Key | 只在服务端注入，禁止传站内用户 Key 给百炼 |
| W-H03 | X-DashScope-Async | 创建必需，enable | 缺失会报不支持同步调用 |
| W-H04 | X-DashScope-OssResourceResolve | 使用百炼临时 oss:// URL 时，enable | 来自补充上传文档，不能遗漏此条件头 |

站内鉴权 Header 与供应商鉴权分层；用户传入的 Header 不原样转发到供应商。

### 1.2 全部请求体字段与参数

| ID | 路径 | 类型/必选 | 取值、默认值、约束 | 画布控件/服务端行为 |
| --- | --- | --- | --- | --- |
| W-P01 | model | string，必选 | wan3.0-video / wan3.0-video-prime | 模型选择；切换后重新报价 |
| W-P02 | input | object，必选 | prompt 与 media 至少存在一个有效值 | 后端检查有效内容，而非仅检查键存在 |
| W-P03 | input.prompt | string，条件必选 | 支持中英文，不超过 20000 字符；官方超过自动截断 | 提示词编辑器与计数，站内阻止超长提交并定位，不静默截断 |
| W-P04 | input.media | array，条件必选 | prompt 和 media 必填其一；只允许规定组合 | 有序素材列表；全模态总数最多 20 |
| W-P05 | input.media[].type | string，必选 | first_frame、last_frame、reference_image、reference_video、reference_audio、file、link | 类型端口/素材角色选择，固定枚举 |
| W-P06 | input.media[].url | string，必选 | 按类型接受 HTTP(S)、百炼临时 OSS URL 或图片 Base64 | 上传/资产选择/粘贴 URL；输入类型逐项校验 |
| W-P07 | parameters | object，可选 | 省略时使用官方默认 | 服务端保存最终有效参数快照 |
| W-P08 | parameters.resolution | string，可选 | 1080P 默认；720P；480P | 三档规格控件，与价格联动 |
| W-P09 | parameters.ratio | string，可选 | adaptive 默认；21:9、16:9、4:3、1:1、3:4、9:16 | 画幅选择和比例示意，固定值不遗漏 |
| W-P10 | parameters.duration | integer，可选 | 默认 5；固定 2-30；-1 为智能时长；有视频时输入总长+输出时长不超过 30 秒 | 固定/智能分段；固定整数输入；参考输入动态缩小上限 |
| W-P11 | parameters.audio | boolean，可选 | true 默认，有声音；false 无音轨；价格相同 | 有声开关，不能用静音降价 |
| W-P12 | parameters.seed | integer，可选 | -1 或 0-2147483647；-1/未指定自动随机 | 随机/指定种子；相同 seed 也不保证完全相同 |
| W-P13 | parameters.prompt_extend | boolean，可选 | true 默认；智能改写可能增加耗时；file/link 存在时必须 true | 智能改写开关；文件/网页模式固定开启并说明原因 |
| W-P14 | parameters.watermark | boolean，可选 | false 默认；true 添加水印 | 独立开关，保存快照 |

提示词字符计数按 Unicode 字符设计，中文和英文字母各一字符；服务端最终以官方校验为准，不能用 UTF-8 字节数冒充字符数。

请求默认值：1080P、adaptive、5 秒、audio=true、seed=-1、prompt_extend=true、watermark=false。首版通用生成节点采用这组默认；编辑/延长场景可以采用官方推荐的 duration=-1，并清楚显示智能时长与预算。

**没有独立上游字段的能力：**

- 生成模式由素材 type 与 prompt 语义决定，没有 mode 字段。
- 分镜数量、镜头时间线、运镜、台词、音色引用、BGM、风格、负向清单编译到 prompt。
- 没有公开的 negative_prompt、driving_audio、fps、n、size、video_extend_direction 等 Wan 3.0 请求参数。
- 不把旧模型参数或示例提示词中的“8K”“1000fps”映射成实际输出配置。
- 帧率固定输出 30fps；不向用户提供无效的帧率下拉框。
- 原生单次输出数量固定为 1；“生成多个版本”是站内多次任务，每次单独计费。
- 智能改写使用模型自身 prompt_extend，不引入额外 LLM。官方提示词 Skill 下载为帮助资源，不是 Wan 请求字段，本轮未安装。

## 2. 全部素材规格

| ID | 类型 | 数量限制 | 格式 | 尺寸/时长/大小 |
| --- | --- | --- | --- | --- |
| W-A01 | first_frame | 最多 1 张 | JPEG、JPG、PNG、BMP、WEBP | 单边 240-8000 像素；长短边比不超过 8:1；单图不超过 20MB；不支持透明通道 |
| W-A02 | last_frame | 最多 1 张，首尾帧组合使用 | 同图片格式 | 同图片约束，严格作为最后一帧 |
| W-A03 | reference_image | 最多 10 张 | 同图片格式 | 同图片约束 |
| W-A04 | reference_video | 最多 5 段 | mp4、mov | 每段 1-15 秒；所有参考视频合计不超过 15 秒；帧率至少 16fps；单边 240-4096 像素；长短边比不超过 8:1；单文件不超过 100MB |
| W-A05 | reference_audio | 最多 5 段 | wav、mp3 | 每段 1-15 秒；参考音频合计不超过 15 秒；单文件不超过 15MB |
| W-A06 | file | 最多 1 个，与 link 互斥 | docx、doc、xlsx、xls、pptx、ppt、pdf、txt、key、pages、numbers、md | 单文件不超过 100MB；pdf/docx/doc/pptx/ppt/key/pages 不超过 50 页 |
| W-A07 | link | 最多 1 个，与 file 互斥 | HTTP 或 HTTPS 公开网页 | 无需登录才能读取的新闻、博客、公众号等；不承诺所有公开页面都可解析 |
| W-A08 | 参考总数 | 最多 20 项 | 图、视频、音频、文件或网页 | 分类上限与总数上限同时满足；10+5+5 再加 1 文件是不合法的 21 项 |

说明：

- 图片 Base64 形式为 data:{MIME_type};base64,{base64_data}，只对图片类型开放。
- 视频、音频、文件支持公开 HTTP(S) URL 或百炼临时 OSS URL，不支持直接套用图片 Base64。
- link 仅支持公开 HTTP(S) 网页。
- 图片中透明通道的转换必须预览和明确触发，产生派生图片；不悄悄改变用户上传原文件。
- 动图、heic、svg、gif 等未列出的输入不能伪装为官方原生支持；若提供转换，作为站内独立操作并验证转换后文件。
- 视频不能仅凭扩展名判断；需检查真实容器、尺寸、帧率和时长；视频帧率与输出帧率是两个不同概念。
- file 页数限制只针对官方列出的七类格式，不给 xlsx/xls/numbers/txt/md 虚构 50 页限制。
- key/pages 等格式的本地页数探测存在工具支持差异：保留原格式的上游调用能力，能可靠探测则校验；无法探测标记为“由模型校验”，不能捏造页数或直接取消格式支持。
- 文档中的 MB 换算未给出字节定义；站内上传阈值采用保守十进制 MB，边界在集中测试中核对并记录。
- 原始 URL、导入副本、模型输入 URL 分开保存。使用站内 OSS 签名 URL 时需让阿里云在队列等待和读取期间能够访问，同时不突破媒体到期时间。

### 2.1 百炼临时 OSS URL 的特殊限制

上传临时空间取得的 oss://dashscope-instant/... 有效期 48 小时，只能在对应模型与同一阿里云主账号下调用，不能查询、修改或下载已上传的临时文件。凭证接口按主账号+模型限流 100 QPS，上限 1GB 不覆盖模型自身更小的文件限制。

首版生产素材优先使用站内 OSS。高级 URL 输入仍兼容官方临时格式，但要求绑定来源模型和主账号；不能随机路由到其他主账号或另一模型。来源不明确时先让用户选用站内上传，不能承诺任意临时 URL 可跨账号使用。使用该格式时自动附带 W-H04。

## 3. 全部合法素材组合

下面 R 表示 reference_image/reference_video/reference_audio，F 表示 file，L 表示 link。所有组合还须满足各类数量、总数与时长限制。

| ID | 场景 | 合法组合/触发 | 站内入口 |
| --- | --- | --- | --- |
| W-C01 | 文生视频 | 只有 prompt，不传 media | 文生 |
| W-C02 | 首帧生视频 | first_frame | 首帧 |
| W-C03 | 首尾帧生视频 | first_frame + last_frame | 首尾帧 |
| W-C04 | 图片参考 | reference_image | 全模态参考 |
| W-C05 | 视频参考 | reference_video | 全模态参考 |
| W-C06 | 音频参考 | reference_audio | 全模态参考 |
| W-C07 | 图片+视频 | reference_image + reference_video | 全模态参考 |
| W-C08 | 图片+音频 | reference_image + reference_audio | 全模态参考 |
| W-C09 | 视频+音频 | reference_video + reference_audio | 全模态参考 |
| W-C10 | 图片+视频+音频 | 三类 R 同时使用 | 全模态参考 |
| W-C11 | 文件/网页单独参考 | F 或 L | 文件/网页 |
| W-C12 | 文件/网页+图片 | F/L + reference_image | 文件/网页 + 全模态 |
| W-C13 | 文件/网页+视频 | F/L + reference_video | 文件/网页 + 全模态 |
| W-C14 | 文件/网页+音频 | F/L + reference_audio | 文件/网页 + 全模态 |
| W-C15 | 文件/网页+图片+视频 | F/L + reference_image + reference_video | 文件/网页 + 全模态 |
| W-C16 | 文件/网页+图片+音频 | F/L + reference_image + reference_audio | 文件/网页 + 全模态 |
| W-C17 | 文件/网页+视频+音频 | F/L + reference_video + reference_audio | 文件/网页 + 全模态 |
| W-C18 | 文件/网页+图片+视频+音频 | F/L + 全部 R，总数仍不超过 20 | 文件/网页 + 全模态 |
| W-C19 | 视频编辑 | 必须有 reference_video，可搭配 reference_image/reference_audio，prompt 包含编辑意图 | 视频编辑 |
| W-C20 | 视频延长 | 必须有 reference_video，可搭配 reference_image/reference_audio，prompt 包含延长意图 | 视频延长 |

W-C11 至 W-C18 的每一行都应分别覆盖 file 和 link 两种选择，不得只实现文件版本。

**必须阻止的组合：**

- first_frame/last_frame 与任一 reference_*、file、link 混用。
- file 与 link 同时出现。
- 缺少有效 prompt 且没有有效 media。
- 文生模式继续携带旧 media；切换模式时保留草稿但不能把不兼容素材悄悄提交。
- last_frame 单独使用：官方允许组合只列首帧与首尾帧，首版不将尾帧单独作为可用模式。
- 首尾帧模式附带 reference_audio 或旧版本 driving_audio。
- 通过重复素材引用绕过数量限制；按最终发给上游的 media 项数计数。
- 输入视频合计超过 15 秒，或固定输出目标与输入合计超过 30 秒。

切换模式不删除源素材节点；不兼容的连接由用户确认调整。所有合法组合必须能通过表单选择完成，不要求用户手写 JSON 才能使用。

## 4. 官方能力到画布的完整映射

| ID | 功能 | 操作与参数 |
| --- | --- | --- |
| W-F01 | 文生视频 | 自由提示词，单镜头/多镜头，完整分辨率/比例/时长 |
| W-F02 | 首帧控制 | 选择图片为 first_frame；推荐 adaptive |
| W-F03 | 首尾帧控制 | 两张图分别分配首尾；生成过渡；推荐 adaptive |
| W-F04 | 主体一致性 | 多人物、物品、场景等参考图/视频，分别编号引用 |
| W-F05 | 动作与运镜参考 | reference_video + 描述哪些运动需复用 |
| W-F06 | 风格参考 | 图片或视频作为风格引用，在 prompt 中区分主体与风格 |
| W-F07 | 音频参考 | 音乐节拍、台词、音色与口型参考；reference_audio + prompt |
| W-F08 | 文件生视频 | 支持全格式列表，prompt_extend 固定 true |
| W-F09 | 网页生视频 | 公开 URL，prompt_extend 固定 true |
| W-F10 | 多模态组合 | 依据第 3 节所有组合，最多 20 项 |
| W-F11 | 增加元素 | reference_video，可搭配参考图/音频，明确添加内容 |
| W-F12 | 删除元素 | prompt 指定去除对象 |
| W-F13 | 修改/替换元素 | 人物、服装、物品等修改，保留其他内容的意图写入 prompt |
| W-F14 | 风格/光线编辑 | 修改画风或光照 |
| W-F15 | 台词/音频编辑 | 编辑台词、人声、音乐、音效；保留 audio 开关 |
| W-F16 | 参考图编辑 | 原视频 + 参考图，指明对应元素 |
| W-F17 | 向后延长 | reference_video + 向后延长 prompt，adaptive |
| W-F18 | 向前延长 | reference_video + 向前延长 prompt，adaptive |
| W-F19 | 双向延长 | reference_video + 前后意图和期望秒数，adaptive |
| W-F20 | 原生声音 | 台词、环境音、BGM 等 prompt 内容；audio 控制是否包含音轨 |
| W-F21 | 智能时长 | duration=-1，按实际返回时长结算 |
| W-F22 | 智能改写 | prompt_extend 显式可控，文件/网页强制开启 |
| W-F23 | 随机种子 | 随机/指定种子，不承诺像素级复现 |
| W-F24 | 水印 | watermark 开关，不能与元数据或合规标识混为一谈 |
| W-F25 | 白模参考/渲染 | 提示词指南的参考视频应用方式，不新增模型参数 |
| W-F26 | 多宫格故事板参考 | 多宫格分镜图 + 顺序/剧情提示词 |
| W-F27 | 多关键帧参考 | 多张 reference_image + 顺序提示词；区别于严格首尾帧控制 |

W-F25 至 W-F27 来自补充 Prompt 指南，纳入模板与参考入口，不意味着新增接口。提示词指南的能力示例代表使用方式，不能保证每次生成完全符合构图、数字或口型要求。

### 4.1 编辑与延长的时长语义

编辑推荐 ratio=adaptive、duration=-1，用于保持原比例和时长；仍保留官方完整可选参数。

延长的 duration 表示**最终输出视频总时长**，不是只传新增部分秒数。例如原片 5 秒，向后延长 2 秒，目标输出 duration=7；该任务计费时长是输入 5 + 输出 7 = 12 秒。

任意有视频输入的任务同时满足：

- 每段输入视频 1-15 秒，所有输入视频合计不超过 15 秒。
- 输入总时长 + 目标输出时长不超过 30 秒。
- 固定输出时长只能是合法整数，动态上限为 floor(30 - 输入总时长)。
- 延长场景的输出应大于选定原片时长；界面同时展示“原片时长、期望延长、输出总长、计费总长”。
- 多视频延长时以哪个片段为主体依赖 prompt，不能自行宣称供应商一定先拼接所有输入；提供指定主体素材和明确最终输出目标，存在歧义先询问。
- 官方延长示例有 duration=5 的通用示例，与前述语义不够一致；实施与集中测试按说明文字、真实响应核对，不把示例中的数值当通用公式。

### 4.2 素材编号与提示词

- reference_image、reference_video、reference_audio 分别按最终 media 数组中各类型出现顺序编号。
- 图1与视频1与音频1可以同时存在；文件和网页不自动伪装成图片编号。
- 图片可在提示词里写“图1”或“图片1”；文本编辑辅助统一为“图1”。
- 使用结构化引用时，拖动顺序后同步编译编号并预览；用户手写的文字引用只能检测提示，不能未经确认大范围替换自由文本。
- 保留最终提交的原文，不用后续画布编辑覆盖历史任务 prompt。
- 分镜模板、台词、音效、风格、负向清单均可省略；生成一个视频不强制填写复杂表格。

## 5. 全部返回字段与状态

### 5.1 创建响应

| ID | 路径 | 内容 | 处理 |
| --- | --- | --- | --- |
| W-R01 | output | object | 容器 |
| W-R02 | output.task_id | string，24 小时查询有效期 | 持久化并绑定站内任务/用户/渠道 |
| W-R03 | output.task_status | string | 保存原始状态，映射用户状态 |
| W-R04 | request_id | string | 管理员排障、关联日志 |
| W-R05 | code | 失败时错误码 | 分类：参数、鉴权、限流、内容审核等 |
| W-R06 | message | 失败时错误详情 | 管理员脱敏留证，用户友好错误 |

### 5.2 查询请求

Authorization 必需；路径 task_id 必需；WorkspaceId 使用创建该任务时的绑定业务空间。查询时不发送新的生成请求体。

### 5.3 查询响应

| ID | 路径 | 类型/内容 | 产品与账务用途 |
| --- | --- | --- | --- |
| W-R07 | output.task_id | string | 核对请求关联，防串单 |
| W-R08 | output.task_status | string | 状态机 |
| W-R09 | output.submit_time | YYYY-MM-DD HH:mm:ss.SSS | 保留原始时间并归一化；供应商时间区需核对 |
| W-R10 | output.scheduled_time | 同格式 | 排队/运行耗时 |
| W-R11 | output.end_time | 同格式 | 完成时间 |
| W-R12 | output.orig_prompt | string | 原提示词返回；不能当“改写后提示词” |
| W-R13 | output.video_url | string，成功返回 | 立即转存，原链接有效期 24 小时 |
| W-R14 | output.code | string，任务失败返回 | 任务级错误，区别 HTTP 成功 |
| W-R15 | output.message | string，任务失败返回 | 错误提示与记录 |
| W-R16 | usage | object，仅成功结果计数 | 计量快照 |
| W-R17 | usage.video_count | integer，固定 1 | 不生成假多输出记录 |
| W-R18 | usage.duration | float，总计费视频秒数 | 最终结算依据，包含输入与输出 |
| W-R19 | usage.input_video_duration | float，无视频输入为 0.0 | 输入费用拆分展示 |
| W-R20 | usage.output_video_duration | float | 输出费用拆分展示 |
| W-R21 | usage.fps | integer，输出 30 | 保存真实元数据 |
| W-R22 | usage.SR | integer，例如 720 | 分辨率核对，注意大写字段名 |
| W-R23 | usage.ratio | string，例如 16:9 | 自适应画幅的实际输出展示 |
| W-R24 | request_id | string | 查询请求排障，区别任务 ID |

保留未识别的响应扩展字段于受限的原始响应记录，不直接透传给用户。缺少/不一致 usage 时进入核对流程，不能凭预估冒充实扣。

### 5.4 全部上游状态

| ID | 官方值 | 含义 | 站内行为 |
| --- | --- | --- | --- |
| W-S01 | PENDING | 上游排队 | 展示排队，可申请取消 |
| W-S02 | RUNNING | 处理中 | 继续后台查询，不承诺可取消 |
| W-S03 | SUCCEEDED | 执行成功 | 用量结算和结果转存分别推进，避免重复 |
| W-S04 | FAILED | 失败 | 保存错因，解除冻结，不计模型费 |
| W-S05 | CANCELED | 已取消 | 确认状态后解除冻结，不凭按钮点击认定成功 |
| W-S06 | UNKNOWN | 任务不存在或未知，过期亦可能返回 | 待核实；不得直接重提或按失败退款 |

上游查询建议约 15 秒一次；查询 20 RPS 为账户维度。task_id 和结果 URL 均按 Wan 文档的 24 小时限制处理，不依赖上游长期保存。

### 5.5 补充异步管理

- 单条查询用于取结果；批量任务列表可用于管理员对账与疑似提交任务核实。
- 批量列表查询参数：task_id、start_time、end_time、model_name、status、page_no、page_size；时间窗口不超过 24 小时，默认最近 24 小时，默认页码 1、页大小 10。
- 批量返回保留 data、total、total_page、page_no、page_size、request_id、code、message；data[] 中保存 api_key_id、caller_parent_id、caller_uid、gmt_create、start_time、end_time、region、request_id、status、task_id、user_api_unique_key、model_name。上述管理信息不原样开放给用户。
- SDK 示例还提及 api_key_id、region 筛选，但 HTTP 参数主表未完整列出；如对账依赖这些扩展过滤，集中集成测试需核对真实支持，不能据示例自行保证可用。
- 取消仅支持 PENDING；其他状态返回 UnsupportedOperation。拟采用 POST /api/v1/tasks/{task_id}/cancel，最终需在集中集成测试核对。
- 通用异步管理文档的部分示例把 tasks 与 task_id 之间的斜杠遗漏；Wan 主文档查询路径有斜杠，不能直接复制通用文档的拼写错误。
- 上游同主账号任务互相可查/可取消，站内按 user_id 再鉴权。
- 可选事件通知需额外配置云端事件服务，首版以持久化轮询完成可靠功能，不依赖回调才能工作。

## 6. 北京全部价格档位与计费规则

| ID | 模型 | 输出分辨率 | 官方原价，输入/输出均适用 | 文档标注活动 | 站内初始售价 |
| --- | --- | --- | --- | --- | --- |
| W-B01 | wan3.0-video | 480P | 0.30 元/秒 | 限时 7 折，计算值 0.21 元/秒 | 0.30 元/秒 |
| W-B02 | wan3.0-video | 720P | 0.60 元/秒 | 限时 7 折，计算值 0.42 元/秒 | 0.60 元/秒 |
| W-B03 | wan3.0-video | 1080P | 1.20 元/秒 | 限时 7 折，计算值 0.84 元/秒 | 1.20 元/秒 |
| W-B04 | wan3.0-video-prime | 480P | 0.45 元/秒 | 本表未标折扣 | 0.45 元/秒 |
| W-B05 | wan3.0-video-prime | 720P | 0.90 元/秒 | 本表未标折扣 | 0.90 元/秒 |
| W-B06 | wan3.0-video-prime | 1080P | 1.80 元/秒 | 本表未标折扣 | 1.80 元/秒 |

价格核对日为 2026-09-30。官方活动计算值是根据文档文字推算，未登录控制台核实资格或结束日期，不能据此自动认定实际账单。

| ID | 计费事实 | 实现规则 |
| --- | --- | --- |
| W-B07 | 输入视频和输出视频均按秒收费 | 有参考视频必须加输入秒数，按输出分辨率档位单价计 |
| W-B08 | 输出按实际成功生成秒数 | 使用 usage，不只用请求 duration |
| W-B09 | 请求失败不计费、不占免费额度 | 站内失败释放冻结 |
| W-B10 | 声音开关价格相同 | 六档不再分有声/无声价 |
| W-B11 | 免费额度每模型表列 30 秒，输入+输出合计 | 属于符合条件的阿里云账户，不自动复制给每位站内用户 |
| W-B12 | 免费额度仅北京提供 | 首版地域固定北京，但不保证账户仍有额度 |
| W-B13 | 免费额度有效期 90 天 | 起点按开通百炼/模型发布/申请通过日期中较晚者，账户实际权益需核对 |
| W-B14 | 万相专节优先于通用视频规则 | 通用视频段落写“输入不计费”，不能套用于 Wan 3.0 |
| W-B15 | 规格分档，不是累计量阶梯 | 版本 × 输出分辨率，不能加 Token 阶梯或未经说明的时长阶梯 |
| W-B16 | 原价、官方活动、站内售价、渠道成本不同 | 分开字段与版本，不用一种折扣混算全部 |

### 6.1 计费核对示例

以下为站内初始价格，金额单位元；不考虑官方活动和上游免费额度。

| 情况 | 计费秒数 | 用户扣费 | 渠道倍率 | 估算成本 |
| --- | --- | --- | --- | --- |
| 标准版 720P，文生 5 秒 | 0+5=5 | 0.6×5=3.00 | 0.5x | 1.50 |
| 标准版 720P，参考输入 4 秒，输出 6 秒 | 4+6=10 | 0.6×10=6.00 | 0.5x | 3.00 |
| 标准版 720P，原片 5 秒延长为 7 秒 | 5+7=12 | 0.6×12=7.20 | 1x | 7.20 |
| 高速版 1080P，输入 5 秒，输出 10 秒 | 5+10=15 | 1.8×15=27.00 | 0.5x | 13.50 |
| 标准版 1080P，智能时长 | 提交前未知，最高合计 30 | 最多先冻结 36.00，终态按实际退补冻结 | 按绑定渠道 | 按最终扣费计算 |
| 明确 FAILED | 无成功计费用量 | 0 | 任意 | 站内估算模型成本 0，实际账单差异另核对 |

图片、音频、文件和网页没有在该专节被列为额外 Token 收费项，不给用户叠加其他模型的文件 Token 规则；站内存储或增值收费如需引入，必须另行确认，首版不擅自添加。

## 7. 验收覆盖要求

- W-M、W-H、W-P、W-A、W-C、W-F、W-R、W-S、W-B 每个编号都必须关联实现文件与集中测试用例。
- W-C11-W-C18 对 file/link 分别执行覆盖；全部参数必须可从画布设置并在最终请求快照中证明。
- 两模型都应验证所有参数 Schema 与模式可达；每个模型、每个分辨率至少有真实调用证据。
- 所有合法组合先通过集中自动化请求契约验证，再按预算执行真实模型组合验收；未实测组合单独标注，不声称已验证。
- 非法组合、边界值、素材页数/帧率/时长/尺寸、智能时长、失败/取消/未知、费用快照必须有集中测试。
- 本轮保留原文快照供后续逐条核查；正式开发前复核官方变更，并保留差异记录。
