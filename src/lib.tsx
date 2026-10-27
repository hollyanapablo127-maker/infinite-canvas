import {
  createContext,
  Fragment,
  useContext,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import {
  useQuery,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  LoaderCircle,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Plus,
} from "lucide-react";

import { registerModelAdapters } from "../shared/catalog";

export type Row = Record<string, any>;
let reauthenticate: (() => Promise<void>) | undefined;
export function setReauthenticationHandler(handler?: () => Promise<void>) {
  reauthenticate = handler;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({ message: "服务暂不可用" }));
  if (response.status === 428 && reauthenticate) {
    await reauthenticate();
    return api<T>(path, options);
  }
  if (!response.ok)
    throw new ApiError(body.message || "请求失败", response.status);
  if (
    (path === "/models" && Array.isArray(body.catalog)) ||
    (path === "/admin/models" && Array.isArray(body))
  )
    registerModelAdapters(
      path === "/models" ? body.adapters || body.catalog : body,
    );
  return body;
}
export const post = (path: string, body: any = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const patch = (path: string, body: any) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const useData = <T = any,>(
  path: string,
  interval?: number,
  enabled = true,
) =>
  useQuery<T>({
    queryKey: [path],
    queryFn: () => api<T>(path),
    refetchInterval: interval,
    retry: 1,
    enabled,
  });
export function usePagedData(path: string, interval?: number, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [`${path}:paged`],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<Row[]>(`${path}?limit=200&offset=${pageParam}`),
    getNextPageParam: (last, pages) =>
      last.length === 200 ? pages.length * 200 : undefined,
    enabled,
    refetchInterval: interval,
  });
  return { ...q, data: q.data?.pages.flat() };
}
export function MoreRecords({ query }: { query: any }) {
  return query.hasNextPage ? (
    <div className="pagination">
      <button
        disabled={query.isFetchingNextPage}
        onClick={() => query.fetchNextPage()}
      >
        {query.isFetchingNextPage ? "加载中" : "加载更多记录"}
      </button>
    </div>
  ) : null;
}
export const money = (value: any) =>
  `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 6, minimumFractionDigits: 2 })}`;
export const date = (value: any) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
export const bytes = (value: any) =>
  Number(value) > 1e9
    ? `${(Number(value) / 1e9).toFixed(2)} GB`
    : `${(Number(value || 0) / 1e6).toFixed(1)} MB`;
export const uid = () => crypto.randomUUID();
export const NotifyContext = createContext<
  (message: string, error?: boolean) => void
>(() => {});
export function useAction() {
  const notify = useContext(NotifyContext);
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async <T,>(
      fn: () => Promise<T>,
      success?: string,
    ): Promise<T | undefined> => {
      setBusy(true);
      try {
        const value = await fn();
        await cache.invalidateQueries();
        if (success) notify(success);
        return value;
      } catch (e) {
        notify(e instanceof Error ? e.message : "操作失败", true);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
  };
}
export function IconButton({
  title,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      className="icon-button"
      aria-label={title}
      title={title}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}
export function Loading() {
  return (
    <div className="empty" role="status">
      <LoaderCircle className="spin" />
      正在加载
    </div>
  );
}
export function Empty({
  text = "暂无记录",
  children,
}: {
  text?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={32} />
      <p>{text}</p>
      {children}
    </div>
  );
}
export function QueryState({
  query,
  children,
}: {
  query: any;
  children: ReactNode;
}) {
  return query.isPending ? (
    <Loading />
  ) : query.error ? (
    <div className="error-box" role="alert">
      {query.error.message}
      <button onClick={() => query.refetch()}>重试</button>
    </div>
  ) : (
    <>{children}</>
  );
}
function markdownInline(value: string): ReactNode[] {
  const token =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\))/g;
  return value.split(token).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (
      (part.startsWith("**") && part.endsWith("**")) ||
      (part.startsWith("__") && part.endsWith("__"))
    )
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    )
      return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)$/);
    if (link)
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    return <Fragment key={index}>{part}</Fragment>;
  });
}
export function Markdown({ source }: { source: string }) {
  const lines = String(source || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(
      <p key={`p-${blocks.length}`}>{markdownInline(paragraph.join(" "))}</p>,
    );
    paragraph = [];
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```(?:[\w-]+)?\s*$/);
    if (fence) {
      if (code) {
        blocks.push(
          <pre key={`code-${blocks.length}`}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      } else {
        flushParagraph();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const Tag = `h${heading[1].length}` as ElementType;
      blocks.push(
        <Tag key={`h-${blocks.length}`}>{markdownInline(heading[2])}</Tag>,
      );
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          <li>{markdownInline(bullet[1])}</li>
        </ul>,
      );
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          <li>{markdownInline(ordered[1])}</li>
        </ol>,
      );
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          {markdownInline(quote[1])}
        </blockquote>,
      );
      continue;
    }
    paragraph.push(line);
  }
  if (code) {
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }
  flushParagraph();
  return <div className="markdown">{blocks}</div>;
}
export function PageHead({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="actions">{actions}</div>
    </header>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Modal({
  title,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`modal ${wide ? "wide" : ""}`}
        >
          <div className="modal-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton title="关闭">
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export type Field = {
  key: string;
  label: string;
  type?: string;
  options?: [string, string][];
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  allowCustom?: boolean;
};
export function EditForm({
  fields,
  initial = {},
  onSubmit,
  submit = "保存",
  busy = false,
  preview,
}: {
  fields: Field[];
  initial?: Row;
  onSubmit: (value: Row) => void;
  submit?: string;
  busy?: boolean;
  preview?: (value: Row) => ReactNode;
}) {
  const [value, setValue] = useState(initial);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
      className="form-stack"
    >
      {fields.map((f) => {
        const FieldContainer = f.type === "multiselect" ? "div" : "label";
        return (
          <FieldContainer
            key={f.key}
            className={f.type === "checkbox" ? "check-field" : "field"}
          >
            {f.type === "multiselect" ? (
              <>
                <span>
                  {f.label}
                  {f.required && <i aria-hidden="true"> *</i>}
                </span>
                <div
                  className="api-model-picker"
                  role="group"
                  aria-label={f.label}
                >
                  <label className="check-field api-model-unlimited">
                    <input
                      type="checkbox"
                      aria-label="不限模型"
                      checked={
                        Array.isArray(value[f.key]) &&
                        value[f.key].includes("*")
                      }
                      onChange={(e) =>
                        setValue({
                          ...value,
                          [f.key]: e.target.checked ? ["*"] : [],
                        })
                      }
                    />
                    <span>不限模型</span>
                    <small>包含现在和以后新增的所有模型</small>
                  </label>
                  <div className="api-model-list">
                    {(f.options || []).map(([id, name]) => (
                      <label key={id} className="check-field">
                        <input
                          type="checkbox"
                          aria-label={`API 模型 ${id}`}
                          disabled={(value[f.key] || []).includes("*")}
                          checked={(value[f.key] || []).includes(id)}
                          onChange={(e) => {
                            const selected = value[f.key] || [];
                            setValue({
                              ...value,
                              [f.key]: e.target.checked
                                ? [...selected, id]
                                : selected.filter((v: string) => v !== id),
                            });
                          }}
                        />
                        <span>{name}</span>
                      </label>
                    ))}
                  </div>
                  {(value[f.key] || []).some(
                    (id: string) =>
                      id !== "*" &&
                      !f.options?.some(([option]) => option === id),
                  ) && (
                    <ul
                      className="api-custom-models"
                      aria-label="已选自定义模型"
                    >
                      {(value[f.key] || [])
                        .filter(
                          (id: string) =>
                            id !== "*" &&
                            !f.options?.some(([option]) => option === id),
                        )
                        .map((id: string) => (
                          <li key={id}>
                            <code>{id}</code>
                            <IconButton
                              title={`移除模型 ${id}`}
                              onClick={() =>
                                setValue({
                                  ...value,
                                  [f.key]: value[f.key].filter(
                                    (model: string) => model !== id,
                                  ),
                                })
                              }
                            >
                              <X size={14} />
                            </IconButton>
                          </li>
                        ))}
                    </ul>
                  )}
                  {f.allowCustom && (
                    <div className="inline-add">
                      <input
                        aria-label="自定义 API 模型"
                        placeholder="输入其他模型 ID"
                        maxLength={150}
                        disabled={(value[f.key] || []).includes("*")}
                        value={customValues[f.key] || ""}
                        onChange={(e) =>
                          setCustomValues({
                            ...customValues,
                            [f.key]: e.target.value,
                          })
                        }
                      />
                      <button
                        type="button"
                        disabled={
                          !customValues[f.key]?.trim() ||
                          (value[f.key] || []).includes("*")
                        }
                        onClick={() => {
                          const custom = customValues[f.key].trim();
                          setValue({
                            ...value,
                            [f.key]: Array.from(
                              new Set([...(value[f.key] || []), custom]),
                            ),
                          });
                          setCustomValues({ ...customValues, [f.key]: "" });
                        }}
                      >
                        <Plus size={14} aria-hidden="true" />
                        添加
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : f.type === "checkbox" ? (
              <>
                <input
                  type="checkbox"
                  checked={!!value[f.key]}
                  onChange={(e) =>
                    setValue({ ...value, [f.key]: e.target.checked })
                  }
                />
                <span>{f.label}</span>
              </>
            ) : (
              <>
                <span>
                  {f.label}
                  {f.required && <i aria-hidden="true"> *</i>}
                </span>
                {f.options ? (
                  <select
                    aria-label={f.label}
                    value={value[f.key] ?? ""}
                    onChange={(e) =>
                      setValue({ ...value, [f.key]: e.target.value })
                    }
                  >
                    {f.options.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea
                    aria-label={f.label}
                    required={f.required}
                    rows={5}
                    value={value[f.key] ?? ""}
                    onChange={(e) =>
                      setValue({ ...value, [f.key]: e.target.value })
                    }
                  />
                ) : (
                  <input
                    aria-label={f.label}
                    type={f.type || "text"}
                    required={f.required}
                    min={f.min}
                    max={f.max}
                    step={f.step ?? (f.type === "number" ? "any" : undefined)}
                    autoComplete={
                      f.type === "password" ? "new-password" : undefined
                    }
                    value={value[f.key] ?? ""}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        [f.key]:
                          f.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                )}
              </>
            )}
            {f.hint && <small>{f.hint}</small>}
          </FieldContainer>
        );
      })}
      {preview?.(value)}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? <LoaderCircle size={16} className="spin" /> : null}
        {submit}
      </button>
    </form>
  );
}
export function exportCsv(name: string, rows: Row[]) {
  const keys = Object.keys(rows[0] || {});
  const escape = (v: any) =>
    `"${String(typeof v === "object" ? JSON.stringify(v) : (v ?? ""))
      .replace(/^[=+@-]/, "\t$&")
      .replaceAll('"', '""')}"`;
  const csv =
    "\ufeff" +
    [keys, ...rows.map((r) => keys.map((k) => r[k]))]
      .map((r) => r.map(escape).join(","))
      .join("\r\n");
  downloadBlob(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
    name + ".csv",
  );
}
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export function Table({
  rows,
  columns,
  filename,
  filters,
  partial = false,
}: {
  rows: Row[];
  columns: { key: string; title: string; render?: (r: Row) => ReactNode }[];
  filename?: string;
  filters?: ReactNode;
  partial?: boolean;
}) {
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const filtered = rows.filter((r) =>
    JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 15));
  const current = Math.min(page, pages - 1);
  return (
    <>
      <div className="table-tools">
        <label className="search">
          <Search size={17} />
          <input
            aria-label={partial ? "搜索已加载记录" : "搜索记录"}
            placeholder={partial ? "搜索已加载记录" : "搜索"}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        {filters}
        <span className="grow" />
        {filename && (
          <button onClick={() => exportCsv(filename, filtered)}>
            <Download size={16} />
            {partial ? "导出已加载记录" : "导出"}
          </button>
        )}
      </div>
      {!filtered.length ? (
        <Empty />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key}>{c.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(current * 15, current * 15 + 15).map((r, i) => (
                <tr key={r.id || i}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      {c.render ? c.render(r) : String(r[c.key] ?? "-")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>
          {partial ? "已加载中匹配" : "共"} {filtered.length} 条
        </span>
        <IconButton
          title="上一页"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          <ChevronLeft size={18} />
        </IconButton>
        <span>
          {current + 1} / {pages}
        </span>
        <IconButton
          title="下一页"
          disabled={current >= pages - 1}
          onClick={() => setPage(current + 1)}
        >
          <ChevronRight size={18} />
        </IconButton>
      </div>
    </>
  );
}

export async function streamPost(
  path: string,
  body: Row,
  onEvent: (type: string, data: Row) => void,
  signal: AbortSignal,
) {
  let response = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 428 && reauthenticate) {
    await reauthenticate();
    response = await fetch(`/api/v1${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `请求失败（${response.status}）`);
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    throw new Error("服务未返回流式内容");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    completed = false;
  const parse = (block: string) => {
    const type =
      block
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() || "message";
    const text = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!text) return;
    let data: Row;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("流式数据格式无效");
    }
    if (type === "done" || type === "error") completed = true;
    onEvent(type, data);
    if (type === "error") throw new Error(data.message || "请求失败");
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parse(buffer);
    if (!completed) throw new Error("连接已中断，请重试");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
