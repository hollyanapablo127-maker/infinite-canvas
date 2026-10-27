import { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  ArrowRight,
  Check,
  Square,
  LoaderCircle,
  Copy,
  ChevronDown,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, useData, money, streamPost, type Row } from "./lib";
import { REASONING_OPTIONS } from "../shared/catalog";

export function PromptOptimizer({
  nodeId,
  text,
  enabled,
  model,
  reasoning,
  onSettings,
  onText,
}: {
  nodeId: string;
  text: string;
  enabled: boolean;
  model?: string;
  reasoning?: string;
  onSettings: (value: Row) => void;
  onText: (text: string) => void;
}) {
  const query = useData<Row>("/models");
  const cache = useQueryClient();
  const models: Row[] = (query.data?.catalog || []).filter(
    (m: Row) =>
      m.type === "language" &&
      m.enabled &&
      m.channels.some((c: Row) => c.enabled),
  );
  const selected = models.find((m) => m.model === model) || models[0];
  const [open, setOpen] = useState(false),
    [before, setBefore] = useState(""),
    [after, setAfter] = useState(""),
    [thinking, setThinking] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [charged, setCharged] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  const session = useRef(0);
  useEffect(
    () => () => {
      session.current++;
      controller.current?.abort();
    },
    [nodeId],
  );
  const close = () => {
    controller.current?.abort();
    setOpen(false);
  };
  const optimize = async () => {
    if (!selected || !text.trim() || busy) return;
    const request = ++session.current;
    const active = new AbortController();
    controller.current = active;
    setBefore(text);
    setAfter("");
    setThinking("");
    setError("");
    setCharged(null);
    setBusy(true);
    setStatus("正在唤醒灵感…");
    setOpen(true);
    onSettings({
      optimizeModel: selected.model,
      optimizeReasoning: reasoning || "auto",
    });
    try {
      await streamPost(
        "/language/optimize",
        {
          model: selected.model,
          prompt: text,
          reasoning: reasoning || "auto",
          request_key: crypto.randomUUID(),
        },
        (type, data) => {
          if (request !== session.current) return;
          if (type === "start") setStatus("连接已建立，正在酝酿更好的表达…");
          if (type === "thinking") {
            setThinking((value) => value + data.text);
            setStatus("模型正在思考…");
          }
          if (type === "delta") {
            setAfter((value) => value + data.text);
            setStatus("提示词正在生长…");
          }
          if (type === "done") {
            setStatus(
              data.estimated
                ? "优化完成 · token 用量为文本估算"
                : "优化完成 · 由你决定保留哪一版",
            );
            setCharged(data.charged);
          }
          if (type === "error" && data.charged !== undefined)
            setCharged(data.charged);
        },
        active.signal,
      );
    } catch (e) {
      if (request === session.current) {
        setStatus(
          active.signal.aborted
            ? "已停止，已接收的内容仍可编辑"
            : "优化未完成，原文已保留",
        );
        if (!active.signal.aborted)
          setError(e instanceof Error ? e.message : "优化失败");
      }
    } finally {
      if (request === session.current) {
        setBusy(false);
        void cache.invalidateQueries({ queryKey: ["/wallet"] });
        void cache.invalidateQueries({ queryKey: ["/auth/me"] });
      }
    }
  };
  const choose = (value: string) => {
    controller.current?.abort();
    onText(value);
    setOpen(false);
    setAfter("");
  };
  return (
    <div className={`prompt-optimizer ${enabled ? "enabled" : ""}`}>
      <label className="optimizer-toggle">
        <input
          type="checkbox"
          aria-label="AI智能优化提示词设置"
          checked={enabled}
          onChange={(e) => onSettings({ optimizeEnabled: e.target.checked })}
        />
        <span className="toggle-track" />
        <Sparkles size={17} />
        <span>AI智能优化提示词</span>
        <span className="mini-badge">AI</span>
      </label>
      {enabled && (
        <div className="optimizer-settings">
          <p className="muted">
            让语言模型帮你打磨灵感。优化后先比较，再由你决定。
          </p>
          {query.isPending ? (
            <p role="status">正在载入语言模型…</p>
          ) : query.error ? (
            <div className="error-box" role="alert">
              语言模型加载失败{" "}
              <button onClick={() => void query.refetch()}>重试</button>
            </div>
          ) : models.length ? (
            <>
              <label className="field">
                优化模型
                <select
                  aria-label="提示词优化模型"
                  value={selected?.model || ""}
                  onChange={(e) =>
                    onSettings({ optimizeModel: e.target.value })
                  }
                >
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.display_name} ·{" "}
                      {m.channels.map((c: Row) => c.name).join(" / ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                思考强度
                <select
                  aria-label="提示词优化思考强度"
                  value={reasoning || "auto"}
                  onChange={(e) =>
                    onSettings({ optimizeReasoning: e.target.value })
                  }
                >
                  {REASONING_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <small>不同渠道支持的强度可能不同，自动模式兼容性最佳。</small>
              </label>
              <div className="optimizer-rate">
                输入 {money(selected?.prices[0]?.input_sale)} · 输出{" "}
                {money(selected?.prices[0]?.output_sale)} / 百万 token
              </div>
              <button
                className="primary optimize-start"
                disabled={busy || !text.trim()}
                onClick={() => void optimize()}
              >
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Sparkles size={17} />
                )}
                <span>{busy ? "灵感打磨中…" : "开始优化"}</span>
                <ArrowRight size={16} />
              </button>
              {!text.trim() && (
                <small className="muted">
                  先写下你的想法，即使只是一句话。
                </small>
              )}
            </>
          ) : (
            <div className="notice">
              还没有可用的语言模型。请联系管理员添加语言渠道，并在模型定价中发布关联的语言模型。
            </div>
          )}
        </div>
      )}
      <Modal title="让灵感，再向前一步" open={open} onClose={close} wide>
        <div className="prompt-comparison">
          <div className="comparison-status">
            <span className={busy ? "live-dot" : "completion-dot"} />
            <span role="status">{status}</span>
            {busy && (
              <button onClick={() => controller.current?.abort()}>
                <Square size={13} />
                停止生成
              </button>
            )}
          </div>
          <div className="comparison-columns">
            <section>
              <header>
                <span className="comparison-number">01</span>
                <div>
                  <h3>优化前</h3>
                  <small>保留最初的灵感</small>
                </div>
                <span>{before.length} 字符</span>
              </header>
              <textarea
                aria-label="优化前提示词"
                value={before}
                onChange={(e) => setBefore(e.target.value)}
                placeholder="你的原始提示词"
              />
              <button onClick={() => choose(before)}>
                <Check size={16} />
                保留优化前
              </button>
            </section>
            <section
              className={`optimized-column ${busy ? "is-streaming" : ""}`}
              aria-busy={busy}
            >
              <header>
                <span className="comparison-number">
                  <Sparkles size={18} />
                </span>
                <div>
                  <h3>优化后</h3>
                  <small>更细腻，也更接近你的想象</small>
                </div>
                <span>{after.length} 字符</span>
              </header>
              <div className="optimized-editor">
                <textarea
                  aria-label="优化后提示词"
                  value={after}
                  readOnly={busy}
                  onChange={(e) => setAfter(e.target.value)}
                  placeholder={
                    busy
                      ? "正在凝聚你的下一份灵感…"
                      : "优化后的提示词会出现在这里"
                  }
                />
                {busy && (
                  <span className="editor-stream-indicator">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
              <button
                className="primary"
                disabled={busy || !after.trim()}
                onClick={() => choose(after)}
              >
                <Check size={16} />
                保留优化后
                <ArrowRight size={15} />
              </button>
            </section>
          </div>
          {thinking && (
            <details className="thinking-details">
              <summary>查看模型思考过程</summary>
              <pre>{thinking}</pre>
            </details>
          )}
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          <footer>
            <span>两侧都可以编辑，点击保留后才会更新文本节点。</span>
            {charged !== null && <span>本次费用 {money(charged)}</span>}
          </footer>
        </div>
      </Modal>
    </div>
  );
}
