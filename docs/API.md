# 站内 API v1

根路径 `/api/v1`。用户通过 Bearer 站内 API Key 调用；网页登录使用 HttpOnly 会话。管理员接口仅支持管理员网页会话。所有用户资源均验证归属。

## 异步生成

1. `POST /quotes`，传入模型输入，获取 5 分钟报价。URL 导入后，返回的 input 已转换为站内 asset_id。
2. `POST /generations`，传入 `{input: 报价返回的input, quoteToken: token}`，并设置 `Idempotency-Key`（8-128 字符）。重试必须使用原键及原内容。
3. `GET /generations/:id` 查询状态与实际用量。
4. `POST /generations/:id/cancel` 取消 QUEUED/PENDING。
5. 成功后 `GET /assets/:result_asset_id/content?download=1` 下载。

```json
{
  "model": "wan3.0-video",
  "mode": "text",
  "input": {"prompt": "海面日出，镜头缓慢推进", "media": []},
  "parameters": {"resolution":"720P","ratio":"16:9","duration":5,"audio":true,"seed":-1,"prompt_extend":true,"watermark":false}
}
```

model: wan3.0-video / wan3.0-video-prime。mode: text/first/frames/reference/file/edit/extend。
media: `{type,asset_id}` 或 `{type,url}`。类型 first_frame/last_frame/reference_image/reference_video/reference_audio/file/link。
临时 OSS 地址还需 binding `{credential_id,model}`，必须由管理员核实原上传账号与模型的绑定关系；不能把其他账号临时素材转给任意渠道。

完整参数和组合规则见 WAN3_SPEC.md。报价阶段执行元数据和组合校验，不会创建付费任务。素材导入会占临时空间。

## 其他接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /models | 模型能力与当前售价 |
| GET | /wallet | 本人余额与流水 |
| GET | /generations?limit=50&offset=0 | 本人任务 |
| POST | /assets/upload | multipart file 上传 |
| POST | /assets/import | {url,kind:media/link} |
| POST | /assets/:id/derive | {operation:trim/frame/frame_first/frame_last/flatten,start,duration,background} |
| POST | /assets/exports | {asset_ids:[]} |
| GET | /assets/exports/list | 本人导出任务 |
| GET | /assets/exports/:id/download | 下载 ZIP |
| GET | /projects | 画布列表 |
| PATCH | /projects/:id | version 乐观锁，content/name/archived/deleted |
| GET | /events | SSE 刷新事件 |

`frame_first` 和 `frame_last` 仅用于视频，分别保存实际首帧、尾帧为 JPEG 图片素材。无需传入 `start` 或 `duration`；返回素材的 `parent_id` 指向原视频，沿用原视频到期时间。提取出的图片可独立使用与删除。

## API 密钥

创建、编辑和撤销密钥需使用网页登录会话。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api-keys | 本人密钥与授权范围，不返回完整密钥 |
| POST | /api-keys | 创建密钥，完整密钥仅返回一次 |
| PATCH | /api-keys/:id | 修改名称、限额、停用状态和模型范围 |
| DELETE | /api-keys/:id | 立即失效并删除密钥，保留历史任务和账单 |

```json
{"name":"我的应用","models":["*"],"dailyLimit":500,"monthlyLimit":5000}
```

省略 `models` 时默认为 `["*"]`，允许调用当前和以后发布的所有模型。限制范围时传入模型 ID 数组，例如 `["gpt-image-2","my-model:alias"]`，支持手动配置目录外的 ID。实际调用仍依赖管理员发布模型、配置渠道与价格。空数组以及同时包含 `*` 和指定 ID 的数组会被拒绝。撤销后的历史任务解除密钥关联，但消费金额与用户账单保留。

错误格式 `{message,code,requestId}`。401 认证失败，403 权限不足，409 版本或幂等冲突，429 请求过快，503 未配置可用服务。金额以元返回，钱包 ledger 中 bigint 整数字段为微元（除以 1,000,000）。不得使用前端传入的价格进行扣费。
