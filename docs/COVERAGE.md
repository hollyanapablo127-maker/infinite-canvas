# 实现覆盖与统一测试入口

本地交付版：2026-09-30。下面是实现位置；具体测试证据与外部待验收范围见 ACCEPTANCE_REPORT.md，不能将实现覆盖等同于真实模型验证。

| 需求 | 实现 |
| --- | --- |
| 两模型、七模式、全部参数与组合 | shared/wan.ts；server/generations.ts；src/canvas.tsx |
| 全部六档、官方原价、站内折扣、版本定价 | server/finance.ts、admin.ts；src/pages.tsx、admin.tsx |
| 报价、预占、实际用量、输入加输出计费 | server/generations.ts、finance.ts |
| 北京异步接口、查询、取消、未知态、并发、恢复 | server/generations.ts、worker.ts |
| 账号、统一登录、双区菜单、注册邮箱、重置 | server/auth.ts、security.ts；src/main.tsx |
| 个人 API、日/月限额、轮换、撤销 | server/personal.ts；src/pages.tsx |
| 管理员余额、调用退款、余额退款、冲正、成本 | server/admin.ts；src/admin.tsx |
| 私有存储、素材校验、派生、缩略图、30 天生命周期 | server/assets.ts、storage.ts、network.ts |
| 节点、连线、平移缩放、便签、分组、历史、草稿 | src/canvas.tsx；server/personal.ts |
| 模板创建、复制、归档、删除恢复 | src/pages.tsx；server/personal.ts |
| 编辑、三种延长意图、提示词辅助、结果对比 | src/canvas.tsx |
| 显式批次、依赖、环路、最高预算、失败停止 | server/workflows.ts；src/canvas.tsx |
| 个人资产、记录、API、账单、公告、账号 | src/pages.tsx |
| 管理仪表盘、价格、用户、渠道、记录、公告、设置、审计 | src/admin.tsx |
| 部署与备份 | Dockerfile、compose.yaml、docs/OPERATIONS.md |

文档页数：PDF 与 PPTX 本地读取实际页/幻灯片数；DOCX 读取文档属性声明的页数；DOC/PPT/KEY/PAGES 无可靠本地布局引擎时交给上游最终校验，不伪造页数。所有格式均可上传。临时 OSS 无法本地探测时保守按 30 秒预占，原账号和模型绑定必须匹配。

当前外部验收依赖：真实北京百炼 API、北京 OSS / 公网 HTTPS、SMTP、生产 PostgreSQL。尚未提供配置，不做假成功。
