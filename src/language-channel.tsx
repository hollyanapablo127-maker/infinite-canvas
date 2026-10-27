import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Radio,
  RefreshCw,
  Sparkles,
  Square,
  Check,
  Trash2,
} from "lucide-react";
import { Modal, post, patch, useAction, streamPost, type Row } from "./lib";
import { REASONING_OPTIONS } from "../shared/catalog";

export function LanguageChannelDialog({
  initial,
  onClose,
}: {
  initial: Row;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Row>({
    name: "",
    key: "",
    models: [],
    model_mapping: {},
    enabled: true,
    priority: 0,
    ...initial,
    baseUrl: initial.base_url || initial.baseUrl || "",
  });
  const [custom, setCustom] = useState("");
  const [discovered, setDiscovered] = useState<string[]>(initial.models || []);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState("");
  const [testModel, setTestModel] = useState(initial.models?.[0] || "");
  const [prompt, setPrompt] = useState("Hi");
  const [reasoning, setReasoning] = useState("auto");
  const [output, setOutput] = useState("");
  const [thinking, setThinking] = useState("");
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState("");
  const action = useAction();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const connection = () => ({
    id: initial.id,
    baseUrl: form.baseUrl,
    key: form.key || undefined,
  });
  const fetchModels = async () => {
    setDiscovering(true);
    setError("");
    try {
      const result = await post(
        "/admin/language-channels/discover",
        connection(),
      );
      setDiscovered(Array.from(new Set([...discovered, ...result.models])));
      setForm((f: Row) => ({
        ...f,
        models: Array.from(new Set([...f.models, ...result.models])),
      }));
      if (!testModel) setTestModel(result.models[0] || "");
      if (!result.models.length)
        setError("渠道未列出模型，可以在下方自定义添加");
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取失败");
    } finally {
      setDiscovering(false);
    }
  };
  const addCustom = () => {
    const model = custom.trim();
    if (!model) return;
    setDiscovered(Array.from(new Set([...discovered, model])));
    setForm({ ...form, models: Array.from(new Set([...form.models, model])) });
    if (!testModel) setTestModel(model);
    setCustom("");
  };
  const test = async () => {
    setOutput("");
    setThinking("");
    setError("");
    setTesting(true);
    setTestStatus("正在建立流式连接…");
    const active = new AbortController();
    controller.current = active;
    try {
      await streamPost(
        "/admin/language-channels/test",
        {
          ...connection(),
          model: validModel,
          upstream_model: form.model_mapping[validModel] || validModel,
          prompt,
          reasoning,
        },
        (type, data) => {
          if (type === "start") setTestStatus("连接已建立，等待模型回复…");
          if (type === "delta") {
            setOutput((text) => text + data.text);
            setTestStatus("正在接收回复…");
          }
          if (type === "thinking") setThinking((text) => text + data.text);
          if (type === "done") setTestStatus("流式回复已完成");
        },
        active.signal,
      );
    } catch (e) {
      setTestStatus(active.signal.aborted ? "测试已停止" : "测试失败");
      if (!active.signal.aborted)
        setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setTesting(false);
    }
  };
  const validModel = form.models.includes(testModel)
    ? testModel
    : form.models[0] || "";
  return (
    <Modal
      title={initial.id ? "语言渠道 · 连接与模型映射" : "添加语言渠道"}
      open
      onClose={() => {
        controller.current?.abort();
        onClose();
      }}
      wide
    >
      <form
        className="form-stack language-channel-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const body = { ...form, key: form.key || undefined };
            if (initial.id)
              await patch(`/admin/language-channels/${initial.id}`, body);
            else await post("/admin/language-channels", body);
            onClose();
          }, "语言渠道已保存");
        }}
      >
        <div className="form-section-title">
          <Radio size={17} />
          <span>01 / 连接配置</span>
          <span className="badge teal">OpenAI 兼容 · SSE</span>
        </div>
        <label className="field">
          渠道名称
          <input
            aria-label="语言渠道名称"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <div className="two-fields">
          <label className="field">
            Base URL
            <input
              aria-label="语言渠道 Base URL"
              type="url"
              required
              placeholder="https://api.example.com/v1"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label className="field">
            API Key{initial.id ? "（留空保留）" : ""}
            <input
              aria-label="语言渠道 API Key"
              type="password"
              autoComplete="new-password"
              required={!initial.id}
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
          </label>
        </div>
        <div className="form-section-title">
          <Sparkles size={17} />
          <span>02 / 支持模型与映射</span>
          <button
            type="button"
            disabled={
              discovering || !form.baseUrl || (!form.key && !initial.id)
            }
            onClick={fetchModels}
          >
            <RefreshCw size={15} className={discovering ? "spin" : ""} />
            {discovering ? "获取中…" : "自动获取模型"}
          </button>
        </div>
        <div className="inline-add">
          <input
            aria-label="自定义语言模型"
            placeholder="输入自定义模型 ID"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustom();
              }
            }}
          />
          <button type="button" disabled={!custom.trim()} onClick={addCustom}>
            <Plus size={15} />
            添加模型
          </button>
        </div>
        {discovered.length > 0 ? (
          <div className="mapping-list">
            {discovered.map((model) => (
              <div className="mapping-row" key={model}>
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={form.models.includes(model)}
                    onChange={(e) => {
                      const selected = e.target.checked;
                      const map = { ...form.model_mapping };
                      if (!selected) delete map[model];
                      setForm({
                        ...form,
                        models: selected
                          ? [...form.models, model]
                          : form.models.filter((m: string) => m !== model),
                        model_mapping: map,
                      });
                      if (selected && !testModel) setTestModel(model);
                    }}
                  />
                  <span title={model}>{model}</span>
                </label>
                <span className="mapping-arrow">→</span>
                <input
                  aria-label={`${model} 的上游模型`}
                  placeholder="上游模型 ID（默认相同）"
                  disabled={!form.models.includes(model)}
                  value={form.model_mapping[model] || ""}
                  onChange={(e) => {
                    const map = { ...form.model_mapping };
                    if (e.target.value.trim())
                      map[model] = e.target.value.trim();
                    else delete map[model];
                    setForm({ ...form, model_mapping: map });
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">
            获取渠道模型列表，或手动添加。左侧为本站模型
            ID，右侧为实际请求的模型 ID。
          </p>
        )}
        <div className="two-fields">
          <label className="field">
            优先级
            <input
              aria-label="语言渠道优先级"
              type="number"
              min={-100}
              max={100}
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: Number(e.target.value) })
              }
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span>启用渠道</span>
          </label>
        </div>
        <div className="form-section-title">
          <Radio size={17} />
          <span>03 / 真实流式连接测试</span>
        </div>
        <div className="two-fields">
          <label className="field">
            测试模型
            <select
              aria-label="测试语言模型"
              value={validModel}
              onChange={(e) => setTestModel(e.target.value)}
            >
              <option value="" disabled>
                先添加支持的模型
              </option>
              {form.models.map((model: string) => (
                <option key={model}>{model}</option>
              ))}
            </select>
          </label>
          <label className="field">
            思考强度
            <select
              aria-label="测试思考强度"
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value)}
            >
              {REASONING_OPTIONS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          测试消息
          <input
            aria-label="测试消息"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={4000}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            disabled={testing || !validModel || !prompt.trim() || !form.baseUrl}
            onClick={() => {
              if (validModel !== testModel) setTestModel(validModel);
              void test();
            }}
          >
            <Radio size={16} className={testing ? "pulse" : ""} />
            {testing ? "接收流式回复…" : "测试连接"}
          </button>
          {testing && (
            <button type="button" onClick={() => controller.current?.abort()}>
              <Square size={14} />
              停止
            </button>
          )}
          <small className="muted">
            测试会发送真实请求，并可能产生上游费用。
          </small>
        </div>
        {(testStatus || output) && (
          <div className="stream-test-result" aria-busy={testing}>
            <span className="stream-state" role="status">
              {testStatus}
            </span>
            <pre>
              {output || (thinking ? "模型正在思考…" : "等待回复…")}
              {testing && <span className="stream-cursor" />}
            </pre>
            {thinking && (
              <details>
                <summary>模型返回的思考内容</summary>
                <pre>{thinking}</pre>
              </details>
            )}
          </div>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="muted">已选择 {form.models.length} 个模型</span>
          <button
            className="primary"
            disabled={action.busy || testing || !form.models.length}
          >
            <Check size={16} />
            {action.busy ? "保存中…" : "保存语言渠道"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
