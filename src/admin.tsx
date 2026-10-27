import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Plus,
  Pencil,
  Trash2,
  Wallet,
  ShieldCheck,
  TrendingUp,
  Users,
  Video,
  CircleDollarSign,
  PackageOpen,
  CreditCard,
  SlidersHorizontal,
  FileText,
  Zap,
  ShieldCheck as ShieldIcon,
  UserRound,
  Server,
  Mail,
  Database,
  Image as ImageIcon,
} from "lucide-react";
import {
  useData,
  usePagedData,
  MoreRecords,
  useAction,
  post,
  patch,
  api,
  money,
  date,
  bytes,
  uid,
  Table,
  PageHead,
  Modal,
  EditForm,
  QueryState,
  Badge,
  Markdown,
  type Row,
  type Field,
} from "./lib";
import { MODEL_IDS, RESOLUTIONS, STATUS_LABELS } from "../shared/wan";
import {
  IMAGE_MODEL_IDS,
  IMAGE_SIZE_CATEGORIES,
  MODEL_CAPABILITIES,
} from "../shared/image";
import { ChannelManagement } from "./admin-channels";
import { CapabilityAdministration } from "./admin-capabilities";
import { ModelManagement } from "./model-admin";

const titles: Row = {
  dashboard: "管理仪表盘",
  users: "用户管理",
  credentials: "渠道管理",
  channels: "渠道管理",
  "image-credentials": "图片渠道管理",
  usage: "全站使用记录",
  announcements: "公告管理",
  plans: "订阅套餐",
  settings: "系统设置",
  audit: "操作审计",
};
const modelOptions = MODEL_IDS.map((m) => [m, m] as [string, string]);
const channelFields: Field[] = [
  { key: "name", label: "渠道名称", required: true },
  {
    key: "account_group",
    label: "阿里云主账号标识",
    required: true,
    hint: "同一主账号的多个 Key 使用相同标识，共享模型并发额度。",
  },
  { key: "workspace", label: "北京 WorkspaceId", required: true },
  {
    key: "key",
    label: "百炼 API Key（修改时留空保留原密钥）",
    type: "password",
  },
  {
    key: "multiplier",
    label: "成本倍率",
    type: "number",
    min: 0,
    max: 100,
    required: true,
    hint: "1 = 用户消费金额；0.5 = 用户消费金额的一半。",
  },
  {
    key: "budget",
    label: "累计成本预算（元，0 不限）",
    type: "number",
    min: 0,
  },
  { key: "priority", label: "调度优先级", type: "number", min: -100, max: 100 },
  {
    key: "concurrency",
    label: "主账号模型并发上限",
    type: "number",
    min: 1,
    max: 5,
  },
  {
    key: "modelChoice",
    label: "允许模型",
    options: [["both", "全部 Wan 3.0 模型"], ...modelOptions],
  },
  { key: "enabled", label: "启用渠道", type: "checkbox" },
];

const imageCredentialFields: Field[] = [
  {
    key: "provider",
    label: "渠道类型",
    options: [
      ["qwen", "百炼 API"],
      ["openai", "OpenAI"],
    ],
    required: true,
  },
  { key: "name", label: "渠道名称", required: true },
  {
    key: "workspace",
    label: "WorkspaceId（仅 Qwen）",
    hint: "阿里云百炼的 Workspace ID，OpenAI 兼容渠道留空",
  },
  {
    key: "baseUrl",
    label: "API Base URL（仅 OpenAI 兼容）",
    hint: "例如：https://sn-api.top/；可填写站点根地址或以 /v1 结尾的地址",
  },
  {
    key: "key",
    label: "API Key",
    type: "password",
    hint: "新增时必填；编辑时留空保留当前密钥",
  },
  {
    key: "priority",
    label: "调度优先级",
    type: "number",
    min: -100,
    max: 100,
    hint: "数字越大优先级越高，相同优先级随机选择",
  },
  { key: "enabled", label: "启用渠道", type: "checkbox" },
];

const imagePriceFields: Field[] = [
  {
    key: "model",
    label: "模型",
    options: IMAGE_MODEL_IDS.map((m) => [m, m]),
    required: true,
  },
  {
    key: "size_category",
    label: "尺寸分类",
    options: IMAGE_SIZE_CATEGORIES.map((s) => [s, s]),
    required: true,
  },
  {
    key: "input_official",
    label: "输入原价（元 / 张）",
    type: "number",
    min: 0,
    required: true,
    hint: "图生图时参考图片的成本，文生图无输入成本",
  },
  {
    key: "input_sale",
    label: "输入售价（元 / 张）",
    type: "number",
    min: 0,
    required: true,
  },
  {
    key: "output_official",
    label: "输出原价（元 / 张）",
    type: "number",
    min: 0.000001,
    required: true,
  },
  {
    key: "output_sale",
    label: "输出售价（元 / 张）",
    type: "number",
    min: 0.000001,
    required: true,
  },
  { key: "enabled", label: "启用定价", type: "checkbox" },
];

const announcementFields: Field[] = [
  {
    key: "display_mode",
    label: "展示方式",
    options: [
      ["banner", "主动提醒"],
      ["silent", "静默 · 仅在公告列表显示"],
    ],
  },
  {
    key: "sort",
    label: "排序优先级（数字越小越靠前）",
    type: "number",
    min: -10000,
    max: 10000,
  },
  { key: "title", label: "标题", required: true },
  {
    key: "body",
    label: "Markdown 正文",
    type: "textarea",
    required: true,
    hint: "支持标题、列表、粗体、斜体、代码和 HTTPS 链接。",
  },
  {
    key: "level",
    label: "等级",
    options: [
      ["normal", "普通"],
      ["important", "重要"],
    ],
  },
  {
    key: "audience",
    label: "受众",
    options: [
      ["all", "全站"],
      ["user", "用户"],
      ["admin", "管理员"],
    ],
  },
  {
    key: "starts_at",
    label: "开始时间",
    type: "datetime-local",
    required: true,
  },
  { key: "ends_at", label: "结束时间（可留空）", type: "datetime-local" },
  { key: "pinned", label: "置顶", type: "checkbox" },
  { key: "published", label: "发布", type: "checkbox" },
];
const paymentFields: Field[] = [
  {
    key: "enabled",
    label: "启用支付",
    type: "checkbox",
  },
  { key: "productPrefix", label: "商品名称前缀" },
  { key: "productSuffix", label: "商品名称后缀" },
  {
    key: "minRecharge",
    label: "最低金额（元）",
    type: "number",
    min: 0.01,
  },
  {
    key: "maxRecharge",
    label: "最高金额（元）",
    type: "number",
    min: 0.01,
  },
  {
    key: "dailyLimit",
    label: "每日限额（元）",
    type: "number",
    min: 0,
  },
  {
    key: "balanceRate",
    label: "余额兑换倍率",
    type: "number",
    min: 0.0001,
  },
  {
    key: "subscriptionRate",
    label: "订阅换算倍率",
    type: "number",
    min: 0.0001,
  },
  {
    key: "renewalFeeRate",
    label: "充值手续费（%）",
    type: "number",
    min: 0,
    max: 100,
  },
  {
    key: "orderTimeoutMinutes",
    label: "订单超时时间（分钟）",
    type: "number",
    min: 1,
    max: 1440,
  },
  {
    key: "maxPendingOrders",
    label: "最多待支付订单数",
    type: "number",
    min: 1,
    max: 50,
  },
  { key: "qrEnabled", label: "启用二维码支付", type: "checkbox" },
  {
    key: "gatewayUrl",
    label: "易支付网关地址",
    hint: "填写服务商根地址，例如 https://pay.example.com。",
  },
  { key: "pid", label: "商户 ID" },
  {
    key: "key",
    label: "商户密钥（留空保留原密钥）",
    type: "password",
  },
  {
    key: "paymentType",
    label: "支付类型",
    options: [
      ["alipay", "支付宝"],
      ["wxpay", "微信支付"],
      ["qqpay", "QQ 钱包"],
    ],
  },
  {
    key: "notifyUrl",
    label: "异步通知地址（可留空使用本站地址）",
  },
  {
    key: "returnUrl",
    label: "同步返回地址（可留空返回充值页）",
  },
];
const planFields: Field[] = [
  { key: "name", label: "套餐名称", required: true },
  { key: "description", label: "套餐描述", type: "textarea", required: true },
  {
    key: "price",
    label: "价格（元）",
    type: "number",
    min: 0.01,
    required: true,
  },
  { key: "original_price", label: "原价（元）", type: "number", min: 0.01 },
  { key: "quota_day", label: "日额度", type: "number", min: 0 },
  { key: "quota_week", label: "周额度", type: "number", min: 0 },
  { key: "quota_month", label: "月额度", type: "number", min: 0 },
  {
    key: "valid_days",
    label: "有效期",
    type: "number",
    min: 1,
    required: true,
  },
  {
    key: "valid_unit",
    label: "有效期单位",
    options: [
      ["day", "天"],
      ["week", "周"],
      ["month", "月"],
    ],
  },
  { key: "sort", label: "排序", type: "number", min: 0 },
  {
    key: "features",
    label: "功能特性（每行一项）",
    type: "textarea",
    hint: "例如：不限并发\\n优先队列\\n到期自动停止",
  },
  { key: "enabled", label: "上架销售", type: "checkbox" },
];
const localDate = (v: any) => {
  const d = new Date(v);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function AdminPage() {
  const { section = "dashboard" } = useParams();
  if (section === "capabilities") return <CapabilityAdministration />;
  if (section === "plans") return <PlansPage />;
  if (["prices", "image-prices"].includes(section)) return <ModelManagement />;
  if (["channels", "credentials", "image-credentials"].includes(section))
    return <ChannelManagement />;
  return <AdminSection key={section} section={section} />;
}
function AdminSection({ section }: { section: string }) {
  const paged = ["users", "usage", "audit"].includes(section);
  const standardQuery = useData(
    `/admin/${section}`,
    section === "dashboard" ? 30000 : undefined,
    !paged,
  );
  const pagesQuery = usePagedData(`/admin/${section}`, undefined, paged);
  const q = paged ? pagesQuery : standardQuery;
  const action = useAction();
  const [edit, setEdit] = useState<Row | null>(null),
    [balance, setBalance] = useState<Row | null>(null),
    [reconcile, setReconcile] = useState<Row | null>(null),
    [userAction, setUserAction] = useState<Row | null>(null);
  const [ledger, setLedger] = useState<Row | null>(null);
  const [settingsTab, setSettingsTab] = useState("general");
  const data = q.data;
  const create = () =>
    setEdit(
      section === "users"
        ? { role: "user" }
        : section === "credentials"
          ? {
              multiplier: 1,
              priority: 0,
              concurrency: 5,
              budget: 0,
              enabled: true,
              modelChoice: "both",
            }
          : section === "image-credentials"
            ? {
                provider: "qwen",
                priority: 0,
                enabled: true,
              }
            : {
                display_mode: "banner",
                sort: 0,
                level: "normal",
                audience: "all",
                published: false,
                pinned: false,
                starts_at: localDate(new Date()),
              },
    );
  const fields: Field[] =
    section === "users"
      ? [
          {
            key: "username",
            label: "账号（3-40 位字母、数字或 _. -）",
            required: true,
          },
          { key: "display_name", label: "显示名称", required: true },
          { key: "email", label: "邮箱", type: "email" },
          {
            key: "password",
            label: "初始密码（至少 8 位）",
            type: "password",
            required: true,
          },
          {
            key: "role",
            label: "身份",
            options: [
              ["user", "用户"],
              ["admin", "管理员"],
            ],
          },
        ]
      : section === "credentials"
        ? channelFields
        : section === "image-credentials"
          ? imageCredentialFields.map((field) =>
              field.key === "key" ? { ...field, required: !edit } : field,
            )
          : announcementFields;
  const save = (v: Row) =>
    action.run(async () => {
      let body: Row = { ...v };
      if (section === "credentials") {
        body.models =
          v.modelChoice === "both" ? [...MODEL_IDS] : [v.modelChoice];
        if (!v.key) delete body.key;
      }
      if (section === "image-credentials") {
        if (!v.key) delete body.key;
        if (v.provider === "qwen") {
          delete body.baseUrl;
        } else {
          delete body.workspace;
        }
      }
      if (section === "announcements") {
        body.starts_at = new Date(v.starts_at).toISOString();
        body.ends_at = v.ends_at ? new Date(v.ends_at).toISOString() : null;
      }
      if (edit?.id) await patch(`/admin/${section}/${edit.id}`, body);
      else await post(`/admin/${section}`, body);
      setEdit(null);
    }, "已保存");
  const columns: Row = {
    users: [
      { key: "username", title: "账号" },
      { key: "display_name", title: "名称" },
      {
        key: "role",
        title: "身份",
        render: (r: Row) => (r.role === "admin" ? "管理员" : "用户"),
      },
      {
        key: "available",
        title: "可用余额",
        render: (r: Row) => money(r.available),
      },
      { key: "frozen", title: "冻结", render: (r: Row) => money(r.frozen) },
      {
        key: "disabled",
        title: "状态",
        render: (r: Row) => (
          <Badge tone={r.disabled ? "red" : "teal"}>
            {r.disabled ? "已停用" : "正常"}
          </Badge>
        ),
      },
      {
        key: "discount_multiplier",
        title: "专属倍率",
        render: (r: Row) =>
          `${Number(r.discount_multiplier ?? 1)}×${Number(r.discount_multiplier ?? 1) < 1 ? ` · ${(Number(r.discount_multiplier) * 10).toFixed(1)} 折` : ""}`,
      },
      {
        key: "created_at",
        title: "注册时间",
        render: (r: Row) => date(r.created_at),
      },
      {
        key: "action",
        title: "操作",
        render: (r: Row) => (
          <div className="actions">
            <button onClick={() => setBalance(r)}>
              <Wallet size={15} />
              余额
            </button>
            <button onClick={() => setLedger(r)}>流水</button>
            <button
              onClick={() =>
                setUserAction({ ...r, operation: "discount_multiplier" })
              }
            >
              <CircleDollarSign size={15} />
              专属倍率
            </button>
            <button
              onClick={() => setUserAction({ ...r, operation: "password" })}
            >
              重置密码
            </button>
            <button onClick={() => setUserAction({ ...r, operation: "role" })}>
              身份
            </button>
            <button
              onClick={() => setUserAction({ ...r, operation: "disabled" })}
            >
              {r.disabled ? "启用" : "停用"}
            </button>
          </div>
        ),
      },
    ],
    credentials: [
      { key: "name", title: "渠道" },
      { key: "account_group", title: "主账号" },
      { key: "workspace", title: "北京空间" },
      {
        key: "multiplier",
        title: "成本倍率",
        render: (r: Row) => `${Number(r.multiplier)}x`,
      },
      { key: "calls", title: "调用数" },
      {
        key: "cost",
        title: "估算成本",
        render: (r: Row) => money(r.cost / 1e6),
      },
      {
        key: "revenue",
        title: "实收",
        render: (r: Row) => money(r.revenue / 1e6),
      },
      {
        key: "budget_micro",
        title: "累计预算",
        render: (r: Row) =>
          r.budget_micro > 0 ? money(r.budget_micro / 1e6) : "不限",
      },
      {
        key: "enabled",
        title: "状态",
        render: (r: Row) => <Badge>{r.enabled ? "启用" : "停用"}</Badge>,
      },
      {
        key: "action",
        title: "",
        render: (r: Row) => (
          <button
            onClick={() =>
              setEdit({
                ...r,
                multiplier: Number(r.multiplier),
                budget: r.budget_micro / 1e6,
                modelChoice: r.models.length === 2 ? "both" : r.models[0],
              })
            }
          >
            <Pencil size={15} />
            编辑
          </button>
        ),
      },
    ],
    "image-credentials": [
      { key: "name", title: "渠道名称" },
      {
        key: "provider",
        title: "类型",
        render: (r: Row) =>
          r.provider === "qwen" ? "阿里云通义千问" : "OpenAI 兼容",
      },
      {
        key: "workspace",
        title: "Workspace / Base URL",
        render: (r: Row) => (r.provider === "qwen" ? r.workspace : r.base_url),
      },
      {
        key: "priority",
        title: "优先级",
        render: (r: Row) => r.priority || 0,
      },
      {
        key: "enabled",
        title: "状态",
        render: (r: Row) => <Badge>{r.enabled ? "启用" : "停用"}</Badge>,
      },
      {
        key: "created_at",
        title: "创建时间",
        render: (r: Row) => date(r.created_at),
      },
      {
        key: "action",
        title: "",
        render: (r: Row) => (
          <div className="actions">
            <button
              onClick={() =>
                setEdit({
                  ...r,
                  baseUrl: r.base_url || "",
                  key: "",
                })
              }
            >
              <Pencil size={15} />
              编辑
            </button>
            <button
              disabled={action.busy}
              onClick={() => {
                if (!window.confirm(`删除渠道 ${r.name}？`)) return;
                void action.run(
                  () =>
                    api(`/admin/image-credentials/${r.id}`, {
                      method: "DELETE",
                    }),
                  "渠道已删除",
                );
              }}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ),
      },
    ],
    usage: [
      {
        key: "created_at",
        title: "时间",
        render: (r: Row) => date(r.created_at),
      },
      { key: "username", title: "用户" },
      { key: "model", title: "模型" },
      { key: "resolution", title: "规格" },
      {
        key: "status",
        title: "状态",
        render: (r: Row) => <Badge>{STATUS_LABELS[r.status]}</Badge>,
      },
      { key: "charged", title: "计费", render: (r: Row) => money(r.charged) },
      { key: "cost", title: "估算成本", render: (r: Row) => money(r.cost) },
      {
        key: "actual_cost",
        title: "对账成本",
        render: (r: Row) =>
          r.actual_cost === null ? "-" : money(r.actual_cost),
      },
      { key: "channel", title: "渠道" },
      {
        key: "action",
        title: "",
        render: (r: Row) => (
          <button onClick={() => setReconcile(r)}>核对</button>
        ),
      },
    ],
    announcements: [
      { key: "title", title: "标题" },
      {
        key: "display_mode",
        title: "展示方式",
        render: (r: Row) => (
          <Badge>{r.display_mode === "silent" ? "静默" : "主动提醒"}</Badge>
        ),
      },
      {
        key: "read_count",
        title: "已读用户",
        render: (r: Row) => r.read_count ?? 0,
      },
      {
        key: "published",
        title: "状态",
        render: (r: Row) => (
          <Badge>{r.published ? "已发布" : "草稿 / 撤回"}</Badge>
        ),
      },
      { key: "audience", title: "受众" },
      {
        key: "starts_at",
        title: "开始",
        render: (r: Row) => date(r.starts_at),
      },
      { key: "ends_at", title: "结束", render: (r: Row) => date(r.ends_at) },
      {
        key: "action",
        title: "",
        render: (r: Row) => (
          <button
            onClick={() =>
              setEdit({
                ...r,
                starts_at: localDate(r.starts_at),
                ends_at: r.ends_at ? localDate(r.ends_at) : "",
              })
            }
          >
            <Pencil size={15} />
            编辑 / 发布
          </button>
        ),
      },
    ],
    audit: [
      {
        key: "created_at",
        title: "时间",
        render: (r: Row) => date(r.created_at),
      },
      { key: "username", title: "操作人" },
      { key: "action", title: "操作" },
      { key: "target", title: "对象" },
      {
        key: "detail",
        title: "详情",
        render: (r: Row) => (
          <details>
            <summary>查看</summary>
            <pre>{JSON.stringify(r.detail, null, 2)}</pre>
          </details>
        ),
      },
    ],
  };
  return (
    <>
      <PageHead
        title={titles[section] || "管理"}
        subtitle="管理员工作区"
        actions={
          [
            "users",
            "credentials",
            "image-credentials",
            "announcements",
          ].includes(section) && (
            <button className="primary" onClick={create}>
              <Plus size={16} />
              {section === "users"
                ? "创建用户"
                : section === "credentials"
                  ? "添加渠道"
                  : section === "image-credentials"
                    ? "添加图片渠道"
                    : "新建公告"}
            </button>
          )
        }
      />
      <QueryState query={q}>
        {section === "dashboard" ? (
          data && (
            <>
              <div className="stats">
                <div>
                  <Users />
                  <span>用户总数</span>
                  <strong>{data.users.total}</strong>
                  <small>
                    今日新增 {data.users.today} · 近 24 小时活跃{" "}
                    {data.users.active}
                  </small>
                </div>
                <div>
                  <CircleDollarSign />
                  <span>今日实收</span>
                  <strong>{money(data.today.revenue / 1e6)}</strong>
                  <small>今日成本 {money(data.today.cost / 1e6)}</small>
                </div>
                <div>
                  <Video />
                  <span>今日调用</span>
                  <strong>{data.today.calls}</strong>
                  <small>运行中 {data.tasks.active}</small>
                </div>
                <div>
                  <TrendingUp />
                  <span>累计毛利（估算）</span>
                  <strong>
                    {money((data.tasks.revenue - data.tasks.cost) / 1e6)}
                  </strong>
                  <small>累计退款 {money(data.tasks.refunded / 1e6)}</small>
                </div>
              </div>
              <section className="section-band">
                <h2>近 30 天调用</h2>
                {data.trends.length ? (
                  <div className="bar-chart">
                    {data.trends.map((d: Row) => (
                      <div key={d.day} title={`${d.day}: ${d.count} 次`}>
                        <span
                          style={{
                            height: Math.max(
                              4,
                              (Number(d.count) /
                                Math.max(
                                  ...data.trends.map((x: Row) => x.count),
                                )) *
                                150,
                            ),
                          }}
                        />
                        <small>{d.day}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">暂无调用数据</p>
                )}
              </section>
              <div className="stats">
                <div>
                  <span>成功 / 失败</span>
                  <strong>
                    {data.tasks.succeeded} / {data.tasks.failed}
                  </strong>
                </div>
                <div>
                  <span>临时存储</span>
                  <strong>{bytes(data.storage.bytes)}</strong>
                </div>
                <div>
                  <span>全站可用 / 冻结</span>
                  <strong>{money(data.wallets.available / 1e6)}</strong>
                  <small>{money(data.wallets.frozen / 1e6)} 冻结</small>
                </div>
              </div>
              <h2>最近调用</h2>
              <Table
                rows={data.recent}
                columns={columns.usage.filter(
                  (c: Row) =>
                    !["username", "channel", "actual_cost", "action"].includes(
                      c.key,
                    ),
                )}
              />
            </>
          )
        ) : section === "settings" ? (
          data && (
            <div className="admin-settings-page">
              <div
                className="admin-settings-tabs"
                role="tablist"
                aria-label="系统设置菜单"
              >
                {(
                  [
                    ["general", "通用设置", SlidersHorizontal],
                    ["terms", "登录条款", FileText],
                    ["features", "功能开关", Zap],
                    ["security", "安全与认证", ShieldIcon],
                    ["users", "用户默认值", UserRound],
                    ["gateway", "网关服务", Server],
                    ["payment", "支付设置", CreditCard],
                    ["mail", "邮件设置", Mail],
                    ["data", "数据备份", Database],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === key}
                    className={settingsTab === key ? "active" : ""}
                    tabIndex={settingsTab === key ? 0 : -1}
                    onKeyDown={(event) => {
                      if (
                        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                          event.key,
                        )
                      )
                        return;
                      event.preventDefault();
                      const buttons = Array.from(
                        event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                          '[role="tab"]',
                        ),
                      );
                      const index = buttons.indexOf(event.currentTarget);
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? buttons.length - 1
                            : (index +
                                (event.key === "ArrowRight" ? 1 : -1) +
                                buttons.length) %
                              buttons.length;
                      buttons[next].click();
                      buttons[next].focus();
                    }}
                    onClick={() => setSettingsTab(key)}
                  >
                    <Icon size={16} /> {label}
                  </button>
                ))}
              </div>
              <div className="admin-settings-content" role="tabpanel">
                {settingsTab === "payment" ? (
                  <>
                    <header>
                      <h2>支付设置</h2>
                      <p>配置在线充值、订阅支付与易支付商户参数</p>
                    </header>
                    <div className="admin-settings-inner">
                      <EditForm
                        key="payment"
                        initial={data.payment || {}}
                        fields={paymentFields}
                        submit="保存支付设置"
                        busy={action.busy}
                        onSubmit={(v) =>
                          action.run(
                            () => patch("/admin/settings", { payment: v }),
                            "支付设置已保存",
                          )
                        }
                      />
                    </div>
                  </>
                ) : settingsTab === "terms" ? (
                  <>
                    <header>
                      <h2>服务说明与联系</h2>
                      <p>
                        编辑本站使用说明和联系邮箱，Markdown 将安全渲染给用户。
                      </p>
                    </header>
                    <div className="admin-settings-inner">
                      <EditForm
                        initial={{
                          terms: data.terms || "",
                          supportEmail: data.supportEmail || "",
                        }}
                        fields={[
                          {
                            key: "terms",
                            label: "站点服务说明（Markdown）",
                            type: "textarea",
                          },
                          {
                            key: "supportEmail",
                            label: "联系邮箱",
                            type: "email",
                          },
                        ]}
                        busy={action.busy}
                        onSubmit={(v) =>
                          action.run(
                            () => patch("/admin/settings", v),
                            "服务说明已保存",
                          )
                        }
                        preview={(v) => (
                          <div className="notice">
                            <Markdown
                              source={String(
                                v.terms || "这里会显示服务说明预览",
                              )}
                            />
                          </div>
                        )}
                      />
                    </div>
                  </>
                ) : settingsTab === "general" ||
                  settingsTab === "features" ||
                  settingsTab === "security" ||
                  settingsTab === "users" ? (
                  <>
                    <header>
                      <h2>
                        {settingsTab === "general"
                          ? "站点设置"
                          : settingsTab === "features"
                            ? "功能开关"
                            : settingsTab === "security"
                              ? "安全与认证"
                              : "用户默认值"}
                      </h2>
                      <p>
                        {settingsTab === "general"
                          ? "站点品牌与运行状态"
                          : settingsTab === "features"
                            ? "控制可用服务"
                            : settingsTab === "security"
                              ? "注册与邮箱验证"
                              : "新用户与任务默认配置"}
                      </p>
                    </header>
                    <div className="admin-settings-inner">
                      <EditForm
                        key={settingsTab}
                        initial={data}
                        fields={
                          settingsTab === "general"
                            ? [
                                {
                                  key: "siteName",
                                  label: "网站名称",
                                  required: true,
                                },
                                {
                                  key: "maintenance",
                                  label: "维护模式（暂停新任务）",
                                  type: "checkbox",
                                },
                              ]
                            : settingsTab === "features"
                              ? [
                                  {
                                    key: "registrationOpen",
                                    label: "开放注册",
                                    type: "checkbox",
                                  },
                                ]
                              : settingsTab === "security"
                                ? [
                                    {
                                      key: "emailVerification",
                                      label: "注册要求邮箱验证码",
                                      type: "checkbox",
                                    },
                                  ]
                                : [
                                    {
                                      key: "concurrentPerUser",
                                      label: "每用户并行任务",
                                      type: "number",
                                      min: 1,
                                      max: 20,
                                    },
                                    {
                                      key: "storageLimitGB",
                                      label: "每用户临时资产空间（GB）",
                                      type: "number",
                                      min: 0.1,
                                    },
                                    {
                                      key: "defaultApiDailyLimit",
                                      label: "新 API Key 默认日限额（元）",
                                      type: "number",
                                      min: 1,
                                    },
                                    {
                                      key: "defaultApiMonthlyLimit",
                                      label: "新 API Key 默认月限额（元）",
                                      type: "number",
                                      min: 1,
                                    },
                                    {
                                      key: "unknownAlertHours",
                                      label: "未知任务提醒间隔（小时）",
                                      type: "number",
                                      min: 1,
                                      max: 24,
                                    },
                                  ]
                        }
                        busy={action.busy}
                        onSubmit={(v) =>
                          action.run(
                            () =>
                              patch("/admin/settings", {
                                ...v,
                                retentionDays: 30,
                              }),
                            "设置已保存",
                          )
                        }
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <header>
                      <h2>
                        {settingsTab === "terms"
                          ? "登录条款"
                          : settingsTab === "gateway"
                            ? "网关服务"
                            : settingsTab === "mail"
                              ? "邮件设置"
                              : "数据备份"}
                      </h2>
                    </header>
                    <div className="admin-settings-inner admin-settings-status">
                      {settingsTab === "terms" ? (
                        <p>当前站点尚未配置登录条款。</p>
                      ) : settingsTab === "gateway" ? (
                        <p>
                          公开地址：{data.services?.publicBase || "未配置"}
                          <br />
                          服务区域：{data.services?.region || "-"}
                        </p>
                      ) : settingsTab === "mail" ? (
                        <p>
                          邮件服务：{data.services?.mail ? "已配置" : "未配置"}
                        </p>
                      ) : (
                        <p>
                          数据库：{data.services?.database || "-"}
                          <br />
                          素材存储：{data.services?.storage || "-"}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        ) : (
          <Table
            rows={data || []}
            columns={columns[section] || []}
            filename={titles[section]}
            partial={paged && pagesQuery.hasNextPage}
          />
        )}
      </QueryState>
      {paged && <MoreRecords query={pagesQuery} />}
      <Modal
        title={
          section === "image-credentials"
            ? edit?.id
              ? "编辑图片渠道"
              : "添加图片渠道"
            : edit?.id
              ? "编辑"
              : "新建"
        }
        open={!!edit}
        onClose={() => setEdit(null)}
      >
        {edit && (
          <EditForm
            key={edit.id || "new"}
            fields={fields}
            initial={edit}
            busy={action.busy}
            onSubmit={save}
            preview={
              section === "announcements"
                ? (v) => (
                    <div className="markdown-preview">
                      <small>预览</small>
                      <Markdown source={String(v.body || "")} />
                    </div>
                  )
                : undefined
            }
          />
        )}
      </Modal>
      <Modal
        title={`余额操作 · ${balance?.display_name || ""}`}
        open={!!balance}
        onClose={() => setBalance(null)}
      >
        {balance && (
          <>
            <div className="notice">
              可用 {money(balance.available)} · 冻结 {money(balance.frozen)}
            </div>
            <EditForm
              initial={{ type: "recharge", amount: 100, idempotencyKey: uid() }}
              fields={[
                {
                  key: "type",
                  label: "操作",
                  options: [
                    ["recharge", "人工充值"],
                    ["deduction", "人工扣减"],
                    ["refund", "调用退款"],
                    ["withdrawal", "退还余额"],
                    ["reversal", "流水冲正"],
                  ],
                },
                {
                  key: "amount",
                  label: "金额（元）",
                  type: "number",
                  min: 0.000001,
                  required: true,
                },
                { key: "taskId", label: "原调用 ID（调用退款必填）" },
                { key: "relatedId", label: "原流水 ID（冲正必填）" },
                {
                  key: "reason",
                  label: "操作原因",
                  type: "textarea",
                  required: true,
                },
              ]}
              busy={action.busy}
              submit="确认入账"
              onSubmit={(v) =>
                action.run(async () => {
                  await post(`/admin/users/${balance.id}/balance`, {
                    ...v,
                    taskId: v.taskId || undefined,
                    relatedId: v.relatedId || undefined,
                  });
                  setBalance(null);
                }, "余额操作已入账")
              }
            />
          </>
        )}
      </Modal>
      <Modal
        title="用户权限与安全"
        open={!!userAction}
        onClose={() => setUserAction(null)}
      >
        {userAction && (
          <>
            <p>
              {userAction.operation === "discount_multiplier"
                ? `${userAction.username} 的最终模型价格 = 本站售价 × 专属倍率。0.8 为八折，1 为原价，0 为免费。已提交任务按原快照结算。`
                : `${userAction.username} 的现有登录会话将失效。`}
            </p>
            <EditForm
              initial={{
                role: userAction.role,
                disabled: !userAction.disabled,
                discount_multiplier: Number(
                  userAction.discount_multiplier ?? 1,
                ),
              }}
              fields={
                userAction.operation === "discount_multiplier"
                  ? [
                      {
                        key: "discount_multiplier",
                        label: "专属倍率",
                        type: "number",
                        min: 0,
                        max: 1,
                        step: 0.000001,
                        required: true,
                        hint: "输入 0 到 1，适用于本站所有模型的售价",
                      },
                    ]
                  : userAction.operation === "password"
                    ? [
                        {
                          key: "password",
                          label: "新密码（至少 8 位）",
                          type: "password",
                          required: true,
                        },
                      ]
                    : userAction.operation === "role"
                      ? [
                          {
                            key: "role",
                            label: "身份",
                            options: [
                              ["user", "用户"],
                              ["admin", "管理员"],
                            ],
                          },
                        ]
                      : [
                          {
                            key: "disabled",
                            label: "停用账号",
                            type: "checkbox",
                          },
                        ]
              }
              busy={action.busy}
              onSubmit={(v) =>
                action.run(async () => {
                  await patch(`/admin/users/${userAction.id}`, {
                    [userAction.operation]: v[userAction.operation],
                  });
                  setUserAction(null);
                }, "已更新")
              }
            />
          </>
        )}
      </Modal>
      <Modal
        title="任务核对"
        open={!!reconcile}
        onClose={() => setReconcile(null)}
      >
        {reconcile && (
          <>
            <p className="pre-wrap">
              {reconcile.id}
              <br />
              {reconcile.internal_error || reconcile.error}
            </p>
            <EditForm
              initial={{
                action: "query",
                upstreamId: reconcile.upstream_id || "",
              }}
              fields={[
                {
                  key: "action",
                  label: "操作",
                  options: [
                    ["query", "重新查询已核实的上游任务"],
                    ["release", "确认未产生费用并释放冻结"],
                    ["actual_cost", "记录官方账单实际成本"],
                    ["settle", "按已核实用量完成结算"],
                  ],
                },
                { key: "upstreamId", label: "上游任务 ID" },
                {
                  key: "actualCost",
                  label: "实际成本（元）",
                  type: "number",
                  min: 0,
                },
                {
                  key: "inputSeconds",
                  label: "核实输入视频秒数",
                  type: "number",
                  min: 0,
                  max: 15,
                },
                {
                  key: "outputSeconds",
                  label: "核实输出视频秒数",
                  type: "number",
                  min: 0.01,
                  max: 30,
                },
                {
                  key: "reason",
                  label: "核对依据",
                  type: "textarea",
                  required: true,
                },
              ]}
              busy={action.busy}
              submit="确认核对"
              onSubmit={(v) =>
                action.run(async () => {
                  await post(`/admin/usage/${reconcile.id}/reconcile`, {
                    ...v,
                    upstreamId: v.upstreamId || undefined,
                  });
                  setReconcile(null);
                }, "已记录核对结果")
              }
            />
          </>
        )}
      </Modal>
      <Modal
        title={`用户资金流水 · ${ledger?.display_name || ""}`}
        open={!!ledger}
        onClose={() => setLedger(null)}
        wide
      >
        {ledger && <UserLedger key={ledger.id} userId={ledger.id} />}
      </Modal>
    </>
  );
}

function PlansPage() {
  const q = useData<Row[]>("/admin/plans");
  const action = useAction();
  const [edit, setEdit] = useState<Row | null>(null);
  const create = () =>
    setEdit({
      name: "",
      description: "",
      price: 39,
      original_price: 39,
      quota_day: 0,
      quota_week: 0,
      quota_month: 0,
      valid_days: 30,
      valid_unit: "day",
      sort: 0,
      features: "",
      enabled: true,
    });
  const save = (value: Row) =>
    action.run(async () => {
      const features = Array.isArray(value.features)
        ? value.features
        : String(value.features || "")
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
      const body = {
        name: String(value.name || "").trim(),
        description: String(value.description || "").trim(),
        price: Number(value.price),
        original_price: Number(value.original_price || value.price),
        quota_day: Number(value.quota_day || 0),
        quota_week: Number(value.quota_week || 0),
        quota_month: Number(value.quota_month || 0),
        valid_days: Number(value.valid_days),
        valid_unit: value.valid_unit || "day",
        sort: Number(value.sort || 0),
        features,
        enabled: Boolean(value.enabled),
      };
      if (edit?.id) await patch(`/admin/plans/${edit.id}`, body);
      else await post("/admin/plans", body);
      setEdit(null);
    }, "套餐已保存");
  const toggle = (plan: Row) =>
    action.run(
      () =>
        patch(`/admin/plans/${plan.id}`, {
          name: plan.name,
          description: plan.description || "",
          price: Number(plan.price),
          original_price: Number(plan.original_price || plan.price),
          quota_day: Number(plan.quota_day || 0),
          quota_week: Number(plan.quota_week || 0),
          quota_month: Number(plan.quota_month || 0),
          valid_days: Number(plan.valid_days || plan.days || 30),
          valid_unit: plan.valid_unit || "day",
          sort: Number(plan.sort || 0),
          features: Array.isArray(plan.features) ? plan.features : [],
          enabled: !plan.enabled,
        }),
      plan.enabled ? "套餐已下架" : "套餐已上架",
    );
  return (
    <>
      <PageHead
        title="订阅套餐"
        subtitle="管理用户可购买的订阅权益与额度"
        actions={
          <button className="primary" onClick={create}>
            <Plus size={16} />
            创建套餐
          </button>
        }
      />
      <QueryState query={q}>
        <section className="admin-plans-page">
          <div className="admin-plans-toolbar">
            <span>{q.data?.length || 0} 个套餐</span>
            <button
              type="button"
              onClick={() => void q.refetch()}
              disabled={q.isFetching}
            >
              刷新
            </button>
          </div>
          {!q.data?.length ? (
            <div className="empty">
              <PackageOpen size={32} />
              <p>暂无订阅套餐</p>
            </div>
          ) : (
            <div className="table-wrap admin-plans-table-wrap">
              <table className="admin-plans-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>套餐名称</th>
                    <th>用量</th>
                    <th>价格</th>
                    <th>有效期</th>
                    <th>上架状态</th>
                    <th>排序</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.map((plan: Row, index: number) => {
                    const quota =
                      [
                        plan.quota_day ? `D ${plan.quota_day}` : "",
                        plan.quota_week ? `W ${plan.quota_week}` : "",
                        plan.quota_month ? `M ${plan.quota_month}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "不限额";
                    return (
                      <tr key={plan.id}>
                        <td>{index + 1}</td>
                        <td>
                          <strong>{plan.name}</strong>
                          <small>{plan.description}</small>
                        </td>
                        <td>
                          <span className="plan-quota">{quota}</span>
                        </td>
                        <td>
                          <strong>{money(plan.price)}</strong>
                          {Number(plan.original_price) > Number(plan.price) && (
                            <del>{money(plan.original_price)}</del>
                          )}
                        </td>
                        <td>
                          {plan.valid_days || plan.days}{" "}
                          {plan.valid_unit === "week"
                            ? "周"
                            : plan.valid_unit === "month"
                              ? "月"
                              : "天"}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={`plan-switch ${plan.enabled ? "on" : ""}`}
                            aria-label={plan.enabled ? "下架套餐" : "上架套餐"}
                            onClick={() => void toggle(plan)}
                          >
                            <i />
                          </button>
                        </td>
                        <td>{plan.sort ?? 0}</td>
                        <td>
                          <div className="actions">
                            <button
                              type="button"
                              onClick={() =>
                                setEdit({
                                  ...plan,
                                  features: Array.isArray(plan.features)
                                    ? plan.features.join("\n")
                                    : plan.features || "",
                                })
                              }
                            >
                              <Pencil size={14} />
                              编辑
                            </button>
                            <button
                              type="button"
                              className="danger-text"
                              onClick={() => {
                                if (window.confirm(`删除套餐“${plan.name}”？`))
                                  void action.run(
                                    () =>
                                      api(`/admin/plans/${plan.id}`, {
                                        method: "DELETE",
                                      }),
                                    "套餐已删除",
                                  );
                              }}
                            >
                              <Trash2 size={14} />
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </QueryState>
      <Modal
        title={edit?.id ? "编辑套餐" : "创建套餐"}
        open={!!edit}
        onClose={() => setEdit(null)}
        wide
      >
        {edit && (
          <EditForm
            key={edit.id || "new"}
            fields={planFields}
            initial={edit}
            busy={action.busy}
            onSubmit={save}
          />
        )}
      </Modal>
    </>
  );
}

function UserLedger({ userId }: { userId: string }) {
  const q = usePagedData(`/admin/users/${userId}/ledger`);
  const names: Row = {
    recharge: "人工充值",
    deduction: "人工扣减",
    refund: "调用退款",
    withdrawal: "退还余额",
    reversal: "流水冲正",
    reserve: "预占",
    release: "释放冻结",
    settle: "调用结算",
  };
  return (
    <QueryState query={q}>
      <Table
        rows={q.data || []}
        filename="用户资金流水"
        partial={q.hasNextPage}
        columns={[
          { key: "id", title: "流水 ID" },
          {
            key: "type",
            title: "类型",
            render: (r) => names[r.type] || r.type,
          },
          {
            key: "amount",
            title: "金额",
            render: (r) => money(r.amount / 1e6),
          },
          { key: "reason", title: "原因" },
          {
            key: "created_at",
            title: "时间",
            render: (r) => date(r.created_at),
          },
        ]}
      />
      <MoreRecords query={q} />
    </QueryState>
  );
}
