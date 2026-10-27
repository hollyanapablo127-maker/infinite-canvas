import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  PanelsTopLeft,
  LayoutDashboard,
  Users,
  Wallet,
  KeyRound,
  SlidersHorizontal,
  Megaphone,
  ShieldCheck,
  Video,
  Grid2X2,
  Image,
  History,
  Settings,
  LogOut,
  Menu,
  Bell,
  X,
  Check,
  Infinity as InfinityIcon,
  CircleDollarSign,
  ArrowRight,
  PackageOpen,
  Boxes,
} from "lucide-react";
import {
  api,
  post,
  useData,
  useAction,
  NotifyContext,
  QueryState,
  Loading,
  EditForm,
  money,
  Modal,
  Markdown,
  setReauthenticationHandler,
  type Field,
  type Row,
} from "./lib";
import {
  Projects,
  Models,
  Assets,
  Usage,
  Keys,
  WalletPage,
  News,
  Account,
} from "./pages";
import { AdminPage } from "./admin";
import { CapabilityWorkbench } from "./capability-workbench";
import { CanvasPage } from "./canvas";
import { LiquidGlassAtmosphere } from "./liquid-glass";
import "./style.css";
import "./liquid.css";
import "./ios-glass.css";

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10000, refetchOnWindowFocus: false },
  },
});
function Auth() {
  const [termsOpen, setTermsOpen] = useState(false);
  const config = useData("/auth/config");
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const action = useAction();
  const cache = useQueryClient();
  const [pendingRegistration, setPendingRegistration] = useState<{
    email: string;
    password: string;
    confirm_password: string;
  } | null>(null);
  const setup = config.data?.setupRequired;
  const actual = setup ? "setup" : mode;
  const fields: Field[] =
    actual === "reset"
      ? [
          { key: "email", label: "邮箱", type: "email", required: true },
          { key: "code", label: "验证码", required: true },
          {
            key: "password",
            label: "新密码（至少 8 位）",
            type: "password",
            required: true,
          },
        ]
      : actual === "verify"
        ? [{ key: "code", label: "邮箱验证码", required: true }]
        : actual === "register"
          ? [
              { key: "email", label: "邮箱", type: "email", required: true },
              {
                key: "password",
                label: "密码（至少 8 位）",
                type: "password",
                required: true,
              },
              {
                key: "confirm_password",
                label: "确认密码",
                type: "password",
                required: true,
              },
            ]
          : [
              {
                key: "username",
                label: actual === "login" ? "邮箱或账号" : "账号",
                required: true,
              },
              {
                key: "password",
                label: actual === "login" ? "密码" : "密码（至少 8 位）",
                type: "password",
                required: true,
              },
              ...(actual === "setup"
                ? [
                    { key: "display_name", label: "显示名称", required: true },
                    { key: "email", label: "邮箱", type: "email" },
                  ]
                : []),
            ];
  const [email, setEmail] = useState("");
  const finishSignIn = async () => {
    await cache.cancelQueries();
    cache.clear();
    await cache.fetchQuery({
      queryKey: ["/auth/me"],
      queryFn: () => api("/auth/me"),
    });
    navigate("/projects");
  };
  if (setup && config.data?.setupTokenRequired)
    fields.push({
      key: "setupToken",
      label: "初始化令牌",
      type: "password",
      required: true,
    });
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <InfinityIcon size={34} />
        <strong>{config.data?.siteName || "无限画布"}</strong>
      </div>
      <section className="auth-form">
        <span className="eyebrow">WAN 3.0 · BEIJING</span>
        <h1>
          {setup
            ? "创建管理员账号"
            : actual === "login"
              ? "登录工作空间"
              : actual === "register"
                ? "创建账号"
                : actual === "verify"
                  ? "验证邮箱"
                  : "重置密码"}
        </h1>
        <QueryState query={config}>
          {actual === "verify" && pendingRegistration && (
            <p className="muted">验证码已发送至 {pendingRegistration.email}</p>
          )}
          <EditForm
            key={actual}
            fields={fields}
            initial={actual === "register" ? pendingRegistration || {} : {}}
            busy={action.busy}
            submit={
              setup
                ? "初始化并进入"
                : actual === "login"
                  ? "登录"
                  : actual === "reset"
                    ? "重置密码"
                    : actual === "verify"
                      ? "继续"
                      : "注册"
            }
            onSubmit={(v) =>
              action.run(async () => {
                if (actual === "register") {
                  if (
                    String(v.password).length < 8 ||
                    String(v.password).length > 128
                  )
                    throw new Error("密码长度需为 8 到 128 位");
                  if (v.password !== v.confirm_password)
                    throw new Error("两次输入的密码不一致");
                  const registration = {
                    email: String(v.email).trim().toLowerCase(),
                    password: String(v.password),
                    confirm_password: String(v.confirm_password),
                  };
                  if (config.data?.emailVerification) {
                    await post("/auth/email-code", {
                      email: registration.email,
                      purpose: "register",
                    });
                    setPendingRegistration(registration);
                    setMode("verify");
                    return;
                  }
                  await post("/auth/register", {
                    email: registration.email,
                    password: registration.password,
                  });
                  await finishSignIn();
                  return;
                }
                if (actual === "verify") {
                  if (!pendingRegistration)
                    throw new Error("请重新填写注册信息");
                  await post("/auth/register", {
                    email: pendingRegistration.email,
                    password: pendingRegistration.password,
                    code: String(v.code).trim(),
                  });
                  setPendingRegistration(null);
                  await finishSignIn();
                  return;
                }
                await post(
                  `/auth/${actual === "reset" ? "reset-password" : actual}`,
                  v,
                );
                if (actual === "reset") {
                  setMode("login");
                  return;
                }
                await finishSignIn();
              })
            }
          />
          {actual === "verify" && pendingRegistration && (
            <div className="code-request">
              <button
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () =>
                      post("/auth/email-code", {
                        email: pendingRegistration.email,
                        purpose: "register",
                      }),
                    "验证码请求已发送",
                  )
                }
              >
                重新发送验证码
              </button>
            </div>
          )}
          {actual === "reset" && (
            <div className="code-request">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="接收验证码的邮箱"
                aria-label="接收验证码的邮箱"
              />
              <button
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () =>
                      post("/auth/email-code", {
                        email,
                        purpose: "reset",
                      }),
                    "验证码请求已发送",
                  )
                }
              >
                发送验证码
              </button>
            </div>
          )}
          {!setup && (
            <div className="auth-links">
              {actual === "login" ? (
                <>
                  <button
                    className="text-button"
                    onClick={() => setMode("reset")}
                  >
                    忘记密码
                  </button>
                  {config.data?.registrationOpen && (
                    <button
                      className="text-button"
                      onClick={() => setMode("register")}
                    >
                      注册账号 <ArrowRight size={15} />
                    </button>
                  )}
                </>
              ) : actual === "verify" ? (
                <>
                  <button
                    className="text-button"
                    onClick={() => setMode("register")}
                  >
                    修改邮箱
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setPendingRegistration(null);
                      setMode("login");
                    }}
                  >
                    返回登录
                  </button>
                </>
              ) : (
                <button
                  className="text-button"
                  onClick={() => {
                    setPendingRegistration(null);
                    setMode("login");
                  }}
                >
                  返回登录
                </button>
              )}
            </div>
          )}
        </QueryState>
      </section>
      <footer>
        {config.data?.terms && (
          <button className="text-button" onClick={() => setTermsOpen(true)}>
            服务说明
          </button>
        )}
        {config.data?.supportEmail && (
          <a href={`mailto:${config.data.supportEmail}`}>联系支持</a>
        )}
        <span>无限画布 · 多模态创作</span>
      </footer>
      <Modal
        title="站点服务说明"
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
      >
        <Markdown source={config.data?.terms || ""} />
      </Modal>
    </main>
  );
}
const personal = [
  ["/projects", "我的画布", PanelsTopLeft],
  ["/models", "模型广场", Grid2X2],
  ["/studio", "多模态工作台", Boxes],
  ["/assets", "资产库", Image],
  ["/usage", "使用记录", History],
  ["/keys", "API 密钥", KeyRound],
  ["/wallet", "充值和订阅", Wallet],
  ["/news", "公告与通知", Bell],
  ["/account", "账号设置", Settings],
] as const;
const admin = [
  ["dashboard", "仪表盘", LayoutDashboard],
  ["prices", "模型定价", CircleDollarSign],
  ["plans", "订阅套餐", PackageOpen],
  ["users", "用户管理", Users],
  ["channels", "渠道管理", KeyRound],
  ["usage", "全站记录", History],
  ["capabilities", "多模态任务", Boxes],
  ["announcements", "公告管理", Megaphone],
  ["settings", "系统设置", SlidersHorizontal],
  ["audit", "操作审计", ShieldCheck],
] as const;
function Shell() {
  const me = useData("/auth/me", 30000);
  const config = useData("/auth/config");
  const announcements = useData<Row[]>("/announcements", 30000);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<Row | null>(null);
  const [announcementDismissal, setAnnouncementDismissal] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const action = useAction();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    const handle = () => client.invalidateQueries();
    window.addEventListener("online", handle);
    return () => window.removeEventListener("online", handle);
  }, []);
  useEffect(() => {
    const unread = (announcements.data || []).find(
      (item) =>
        item.read_version !== item.version &&
        item.display_mode !== "silent" &&
        !sessionStorage.getItem(
          `announcement:${me.data?.user?.id}:${item.id}:${item.version}`,
        ),
    );
    setAnnouncement((current) => {
      if (!unread) return null;
      return current?.id === unread.id ? unread : current || unread;
    });
  }, [announcements.data, announcementDismissal, me.data?.user?.id]);
  if (me.isPending) return <Loading />;
  if (me.error) return <Auth />;
  const user = me.data.user;
  const isCanvas = location.pathname.startsWith("/canvas/");
  return (
    <div className={`app-shell ${isCanvas ? "canvas-shell" : ""}`}>
      <div className="mobile-bar">
        <button
          className="icon-button"
          aria-label="导航菜单"
          onClick={() => setOpen(!open)}
        >
          <Menu />
        </button>
        <strong>{config.data?.siteName || "无限画布"}</strong>
      </div>
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <NavLink className="brand" to="/projects">
          <InfinityIcon size={30} />
          <span>{config.data?.siteName || "无限画布"}</span>
        </NavLink>
        <div className="workspace-label">
          <span className="status-dot" />
          华北2（北京）<span>WAN 3.0</span>
        </div>
        <nav
          onClick={(event) => {
            if ((event.target as Element).closest("a")) setOpen(false);
          }}
        >
          {user.role === "admin" && (
            <>
              <div className="nav-label">管理员</div>
              {admin.map(([path, label, Icon]) => (
                <NavLink key={path} to={`/admin/${path}`}>
                  <Icon size={18} />
                  {label}
                </NavLink>
              ))}
            </>
          )}
          <div className="nav-label">个人账号</div>
          {personal.map(([path, label, Icon]) => (
            <NavLink
              key={path}
              to={path}
              aria-label={path === "/wallet" ? "余额与账单" : undefined}
            >
              <Icon size={18} />
              {label}
              {path === "/wallet" && (
                <span className="visually-hidden">余额与账单</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink to="/wallet">
            <span>可用余额</span>
            <strong>{money(Number(me.data.wallet.available) / 1e6)}</strong>
          </NavLink>
          <div className="user-row">
            <span className="avatar">{user.display_name.slice(0, 1)}</span>
            <div>
              <strong>{user.display_name}</strong>
              <small>{user.role === "admin" ? "管理员" : "用户"}</small>
            </div>
            <button
              title="退出登录"
              aria-label="退出登录"
              className="icon-button"
              onClick={() =>
                action.run(async () => {
                  await post("/auth/logout");
                  client.clear();
                  navigate("/login");
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className={isCanvas ? "canvas-main" : "main-content"}>
        {config.data?.maintenance && (
          <div className="notice warning">系统维护中，新生成任务暂不可用</div>
        )}
        <Routes>
          <Route path="/projects" element={<Projects />} />
          <Route path="/canvas/:id" element={<CanvasPage />} />
          <Route path="/models" element={<Models />} />
          <Route path="/studio" element={<CapabilityWorkbench />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/news" element={<News />} />
          <Route path="/account" element={<Account user={user} />} />
          <Route
            path="/admin/:section"
            element={
              user.role === "admin" ? (
                <AdminPage />
              ) : (
                <Navigate to="/projects" />
              )
            }
          />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </main>
      {announcement && (
        <aside
          className="announcement-popover"
          role="dialog"
          aria-label="未读公告"
        >
          <div className="announcement-popover-head">
            <span>
              <Bell size={16} />
              新公告
            </span>
            <button
              className="icon-button"
              aria-label="稍后处理"
              title="稍后处理"
              onClick={() => {
                sessionStorage.setItem(
                  `announcement:${user.id}:${announcement.id}:${announcement.version}`,
                  "dismissed",
                );
                setAnnouncement(null);
                setAnnouncementDismissal((n) => n + 1);
              }}
            >
              <X size={16} />
            </button>
          </div>
          <h2>{announcement.title}</h2>
          <Markdown source={announcement.body} />
          <div className="announcement-popover-actions">
            <NavLink to="/news">查看全部</NavLink>
            <button
              className="primary"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await post(`/announcements/${announcement.id}/read`);
                  setAnnouncement(null);
                }, "公告已读")
              }
            >
              <Check size={15} />
              已读
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
function App() {
  const [reauth, setReauth] = useState<{
    resolve: () => void;
    reject: (e: Error) => void;
  } | null>(null);
  const [reauthError, setReauthError] = useState("");
  useEffect(() => {
    let pending: Promise<void> | null = null;
    setReauthenticationHandler(() => {
      if (!pending)
        pending = new Promise<void>((resolve, reject) =>
          setReauth({
            resolve: () => {
              pending = null;
              setReauth(null);
              resolve();
            },
            reject: (e) => {
              pending = null;
              setReauth(null);
              reject(e);
            },
          }),
        );
      return pending;
    });
    return () => setReauthenticationHandler();
  }, []);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  return (
    <NotifyContext.Provider
      value={(message, error) => setToast({ message, error })}
    >
      <LiquidGlassAtmosphere />
      {!online && (
        <div className="offline-banner">网络连接已断开，画布更改暂存于本机</div>
      )}
      <Routes>
        <Route path="/login" element={<Auth />} />
        <Route path="*" element={<Shell />} />
      </Routes>
      <Modal
        title="验证管理员身份"
        open={!!reauth}
        onClose={() => reauth?.reject(new Error("已取消验证"))}
      >
        <EditForm
          fields={[
            {
              key: "password",
              label: "当前密码",
              type: "password",
              required: true,
            },
          ]}
          submit="验证并继续"
          onSubmit={async (v) => {
            try {
              await post("/auth/reauth", v);
              setReauthError("");
              reauth?.resolve();
            } catch (e: any) {
              setReauthError(e.message);
            }
          }}
        />
        {reauthError && <p className="error-text">{reauthError}</p>}
      </Modal>
      {toast && (
        <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
          <span>{toast.message}</span>
          <button aria-label="关闭消息" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </NotifyContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
