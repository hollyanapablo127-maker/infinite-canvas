import { useState } from "react";
import { RefreshCw, ShieldCheck, Eye } from "lucide-react";
import {
  useData,
  useAction,
  post,
  money,
  date,
  PageHead,
  Table,
  Badge,
  Modal,
  EditForm,
  QueryState,
  type Row,
} from "./lib";
import { CapabilityOutput } from "./capability-workbench";
export function CapabilityAdministration() {
  const query = useData<Row[]>("/admin/capability-jobs", 5000),
    action = useAction();
  const [selected, setSelected] = useState<Row | null>(null);
  return (
    <>
      <PageHead
        title="多模态任务"
        subtitle="查看百炼任务、实时会话和需要核实的账单"
        actions={
          <button onClick={() => void query.refetch()}>
            <RefreshCw size={16} />
            刷新
          </button>
        }
      />
      <QueryState query={query}>
        <Table
          rows={query.data || []}
          filename="多模态任务"
          columns={[
            {
              key: "created_at",
              title: "时间",
              render: (r: Row) => date(r.created_at),
            },
            { key: "username", title: "用户" },
            { key: "model", title: "模型" },
            { key: "protocol", title: "协议" },
            {
              key: "status",
              title: "状态",
              render: (r: Row) => (
                <Badge
                  tone={
                    ["UNKNOWN", "RECONCILE"].includes(r.status)
                      ? "red"
                      : "neutral"
                  }
                >
                  {r.status}
                </Badge>
              ),
            },
            {
              key: "reserved",
              title: "冻结",
              render: (r: Row) => money(r.reserved),
            },
            {
              key: "charged",
              title: "消费",
              render: (r: Row) => money(r.charged),
            },
            {
              key: "action",
              title: "操作",
              render: (r: Row) => (
                <button onClick={() => setSelected(r)}>
                  {["UNKNOWN", "RECONCILE"].includes(r.status) ? (
                    <ShieldCheck size={14} />
                  ) : (
                    <Eye size={14} />
                  )}
                  查看 / 核对
                </button>
              ),
            },
          ]}
        />
      </QueryState>
      <Modal
        title="任务详情与核对"
        open={!!selected}
        onClose={() => setSelected(null)}
        wide
      >
        {selected && (
          <>
            <p>
              <strong>{selected.model}</strong>
              <br />
              <small>
                {selected.id} · {selected.protocol}
              </small>
            </p>
            <p className="pre-wrap">{selected.prompt}</p>
            {selected.error && <p className="error-box">{selected.error}</p>}
            {["UNKNOWN", "RECONCILE"].includes(selected.status) && (
              <EditForm
                initial={{ action: "query", amount: 0, reason: "" }}
                fields={[
                  {
                    key: "action",
                    label: "核对操作",
                    options: [
                      ["query", "按已知任务ID重新查询"],
                      ["release", "确认未产生费用，释放预算"],
                      ["settle", "按核实费用结算"],
                    ],
                  },
                  {
                    key: "amount",
                    label: "核实消费金额（元）",
                    type: "number",
                    min: 0,
                    max: selected.reserved,
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
                    await post(
                      `/admin/capability-jobs/${selected.id}/reconcile`,
                      v,
                    );
                    setSelected(null);
                  }, "任务核对已记录")
                }
              />
            )}
          </>
        )}
      </Modal>
    </>
  );
}
