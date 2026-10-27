import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import { db, transaction, type Row } from "./db";
import { asyncRoute, ensure, hash, token } from "./security";
import {
  capabilityRouter,
  capabilityConnection,
  bailianJson,
  settleCapability,
  capabilityCost,
  publicCapability,
} from "./capabilities";
import { config } from "./config";
import { z } from "zod";

async function ownLive(id: string, userId: string, protocol?: string) {
  const [job] = await db.query(
    "SELECT * FROM capability_jobs WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  ensure(job, "任务不存在", 404);
  if (protocol) ensure(job.protocol === protocol, "会话协议不匹配");
  return job;
}
const maxDuration = (job: Row) =>
  Math.max(
    1,
    Math.min(
      120,
      Number(
        job.parameters.max_seconds ||
          (job.price_snapshot.unit === "second"
            ? job.price_snapshot.quantity
            : 60) ||
          60,
      ),
    ),
  );
capabilityRouter.post(
  "/:id/realtime-ticket",
  asyncRoute(async (req, res) => {
    const job = await ownLive(String(req.params.id), req.user.id);
    ensure(
      ["bailian-realtime", "bailian-inference"].includes(job.protocol),
      "模型不是实时协议",
    );
    ensure(job.status === "READY", "会话尚未就绪或已结束");
    const secret = token();
    await db.query(
      "UPDATE capability_jobs SET socket_token_hash=$2,socket_token_expires=now()+interval '1 minute' WHERE id=$1 AND status='READY'",
      [job.id, hash(secret)],
    );
    res.json({
      id: job.id,
      path: `/api/v1/realtime/socket/${job.id}?ticket=${encodeURIComponent(secret)}`,
      maxSeconds: maxDuration(job),
      protocol: job.protocol,
    });
  }),
);
export function setupRealtimeProxy(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://local");
    if (!url.pathname.startsWith("/api/v1/realtime/socket/")) return;
    const fail = () => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    };
    const origin = request.headers.origin;
    const allowed = new Set([
      config.origin,
      config.publicBase,
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
    ]);
    if (!config.production) {
      allowed.add("http://127.0.0.1:5173");
      allowed.add("http://localhost:5173");
    }
    if (!origin || !allowed.has(origin)) {
      fail();
      return;
    }
    void (async () => {
      try {
        const id = url.pathname.split("/").at(-1);
        ensure(z.string().uuid().safeParse(id).success, "会话无效");
        const sessionCookie = request.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("canvas_session="))
          ?.slice(15);
        ensure(sessionCookie, "请先登录");
        const [user] = await db.query(
          "SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND NOT u.disabled",
          [hash(decodeURIComponent(sessionCookie))],
        );
        ensure(user, "登录已过期");
        const [job] = await db.query(
          "UPDATE capability_jobs SET status='CONNECTING',socket_token_hash=NULL,started_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 AND status='READY' AND socket_token_hash=$3 AND socket_token_expires>now() RETURNING *",
          [id, user.id, hash(url.searchParams.get("ticket") || "")],
        );
        ensure(job, "连接凭证无效或已使用");
        wss.handleUpgrade(request, socket, head, (client) => {
          void bridge(client, job);
        });
      } catch {
        fail();
      }
    })();
  });
  server.once("close", () => wss.close());
}
async function bridge(client: WebSocket, job: Row) {
  let upstream: WebSocket | undefined,
    stopped = false,
    opened = false,
    closed = false;
  let usage: Row = {},
    text = "",
    totalBytes = 0,
    secondBytes = 0,
    second = Math.floor(Date.now() / 1000),
    ready = false;
  const taskId = randomUUID().replace(/-/g, "");
  const send = (data: Row) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };
  const finish = async (message?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (upstream && upstream.readyState < 2) upstream.close(1000);
    if (client.readyState < 2) client.close(1000);
    const duration = opened
      ? Math.min(
          maxDuration(job),
          Math.max(1, Math.ceil((Date.now() - started) / 1000)),
        )
      : 0;
    try {
      await settleCapability(
        job.id,
        opened ? capabilityCost(job, { ...usage, duration }, { text }) : 0,
        opened ? "SUCCEEDED" : "FAILED",
        { text },
        { ...usage, duration },
        message,
      );
    } catch {
      await db.query(
        "UPDATE capability_jobs SET status='RECONCILE',error='实时会话结算失败，请管理员核对' WHERE id=$1",
        [job.id],
      );
    }
  };
  const started = Date.now();
  const timeout = setTimeout(
    () => {
      send({ type: "bridge.closed", message: "已到达本次体验的时长上限" });
      void finish();
    },
    maxDuration(job) * 1000,
  );
  client.on("close", () => void finish());
  client.on("error", () => void finish("客户端连接中断"));
  try {
    const conn = await capabilityConnection(job),
      url = new URL(conn.root);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname =
      job.protocol === "bailian-inference"
        ? "/api-ws/v1/inference"
        : "/api-ws/v1/realtime";
    if (job.protocol !== "bailian-inference")
      url.searchParams.set("model", job.upstream_model);
    upstream = new WebSocket(url, {
      headers: { Authorization: `Bearer ${conn.key}` },
      handshakeTimeout: 20000,
      maxPayload: 5_000_000,
      followRedirects: false,
    });
    upstream.on("open", () => {
      opened = true;
      void db.query(
        "UPDATE capability_jobs SET status='LIVE',started_at=now(),updated_at=now() WHERE id=$1",
        [job.id],
      );
      send({
        type: "bridge.ready",
        protocol: job.protocol,
        maxSeconds: maxDuration(job),
      });
    });
    upstream.on("message", (data, binary) => {
      if (binary) {
        if (client.readyState === 1) client.send(data, { binary: true });
        return;
      }
      try {
        const event = JSON.parse(data.toString());
        if (
          event.type === "session.updated" ||
          event.header?.event === "task-started"
        )
          ready = true;
        if (
          event.type === "response.text.delta" ||
          event.type === "response.audio_transcript.delta" ||
          event.type === "response.output_text.delta"
        )
          text += String(event.delta || "");
        if (event.type === "response.done" && event.response?.usage)
          usage = event.response.usage;
        if (event.header?.event === "result-generated") {
          const sentence = event.payload?.output?.sentence?.text;
          if (sentence) text = sentence;
        }
        send(event);
        if (event.header?.event === "task-finished") void finish();
        if (event.header?.event === "task-failed" || event.type === "error")
          send({
            type: "bridge.warning",
            message: "上游返回错误，请检查模型、输入格式与参数",
          });
      } catch {
        send({ type: "bridge.warning", message: "收到无法解析的上游事件" });
      }
    });
    upstream.on("error", () => {
      send({
        type: "bridge.error",
        message: "上游实时连接失败，请检查地域、模型授权与网络",
      });
      void finish("上游连接失败");
    });
    upstream.on("close", () => void finish());
    client.on("message", (raw, binary) => {
      const now = Math.floor(Date.now() / 1000);
      if (now !== second) {
        second = now;
        secondBytes = 0;
      }
      const length = rawDataLength(raw);
      secondBytes += length;
      totalBytes += length;
      if (secondBytes > 512_000 || totalBytes > 20_000_000) {
        send({ type: "bridge.error", message: "实时输入超过速率或大小限制" });
        void finish();
        return;
      }
      if (!upstream || upstream.readyState !== 1) return;
      if (binary) {
        if (job.protocol === "bailian-inference" && ready)
          upstream.send(raw, { binary: true });
        return;
      }
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === "bridge.end") {
          if (job.protocol === "bailian-inference")
            upstream.send(
              JSON.stringify({
                header: {
                  action: "finish-task",
                  task_id: taskId,
                  streaming: "duplex",
                },
                payload: { input: {} },
              }),
            );
          else void finish();
          return;
        }
        if (job.protocol === "bailian-inference") {
          const action = event.header?.action;
          ensure(
            ["run-task", "continue-task", "finish-task"].includes(action),
            "事件无效",
          );
          event.header = { action, task_id: taskId, streaming: "duplex" };
          if (action === "run-task") {
            const asr = job.parameters.mode === "asr";
            event.payload = {
              task_group: "audio",
              task: asr ? "asr" : "tts",
              function: asr ? "recognition" : "SpeechSynthesizer",
              model: job.upstream_model,
              parameters: {
                format: "pcm",
                sample_rate: asr ? 16000 : 24000,
                ...(asr ? {} : { voice: job.parameters.voice || "longanyang" }),
              },
              input: {},
            };
          } else if (action === "continue-task")
            event.payload = {
              input: {
                text: String(event.payload?.input?.text || "").slice(0, 600),
              },
            };
          else event.payload = { input: {} };
        } else {
          const allow = [
            "session.update",
            "conversation.item.create",
            "input_audio_buffer.append",
            "input_audio_buffer.commit",
            "input_audio_buffer.clear",
            "input_image_buffer.append",
            "response.create",
            "response.cancel",
            "session.finish",
            "input_text_buffer.append",
            "input_text_buffer.commit",
          ];
          ensure(allow.includes(event.type), "事件类型无效");
          if (event.type === "session.update")
            event.session = {
              modalities: ["text", "audio"],
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              voice: job.parameters.voice || "Cherry",
              instructions: String(job.input.prompt || "你是一位创作助手。"),
              turn_detection:
                job.parameters.mode === "vad"
                  ? {
                      type: "server_vad",
                      threshold: 0.5,
                      silence_duration_ms: 700,
                    }
                  : null,
            };
          if (event.type === "response.create")
            event.response = {
              modalities: ["text", "audio"],
              max_output_tokens: 2048,
            };
          if (event.type === "conversation.item.create") {
            const content = event.item?.content || [];
            event.item = {
              type: "message",
              role: "user",
              content: content
                .filter((c: Row) => c.type === "input_text")
                .map((c: Row) => ({
                  type: "input_text",
                  text: String(c.text || "").slice(0, 4000),
                })),
            };
          }
        }
        upstream.send(JSON.stringify(event));
      } catch {
        send({ type: "bridge.warning", message: "输入事件未通过协议校验" });
      }
    });
  } catch {
    send({ type: "bridge.error", message: "会话初始化失败" });
    await finish("初始化失败");
  }
}
function rawDataLength(data: RawData) {
  return Array.isArray(data)
    ? data.reduce((sum, b) => sum + b.length, 0)
    : data.byteLength;
}

capabilityRouter.post(
  "/:id/world/start",
  asyncRoute(async (req, res) => {
    const job = await ownLive(
      String(req.params.id),
      req.user.id,
      "happyoyster",
    );
    const [claim] = await db.query(
      "UPDATE capability_jobs SET status='CONNECTING',updated_at=now() WHERE id=$1 AND status='READY' RETURNING *",
      [job.id],
    );
    ensure(claim, "世界尚未构建完毕或已进入会话");
    try {
      const conn = await capabilityConnection(job),
        base = `/api/v2/apps/${encodeURIComponent(job.upstream_model)}/openapi/v1`;
      const ticket = await bailianJson(
        conn,
        `${base}/worlds/get-travel-credential`,
        { encryptedWorldId: job.upstream_id },
      );
      ensure(ticket.data?.ticket, "上游未返回体验凭证");
      const data = await bailianJson(conn, `${base}/travels/enter-travel`, {
        ticket: ticket.data.ticket,
        maxExperienceTimeSec: maxDuration(job),
        userAgent: String(req.headers["user-agent"] || "InfiniteCanvas").slice(
          0,
          200,
        ),
      });
      ensure(
        data.data?.encryptedTravelId && data.data?.rtcConfig,
        "上游未返回RTC连接参数",
      );
      const output = {
        ...job.output,
        travelId: data.data.encryptedTravelId,
        mode: data.data.mode,
      };
      await db.query(
        "UPDATE capability_jobs SET status='LIVE',output=$2,started_at=now(),updated_at=now() WHERE id=$1",
        [job.id, output],
      );
      res.json({
        id: job.id,
        rtcConfig: data.data.rtcConfig,
        travelId: data.data.encryptedTravelId,
        mode: data.data.mode,
        maxSeconds: maxDuration(job),
      });
    } catch (error) {
      await db.query(
        "UPDATE capability_jobs SET status='UNKNOWN',error='世界进房结果待核实，请勿重复开始',updated_at=now() WHERE id=$1",
        [job.id],
      );
      throw error;
    }
  }),
);
capabilityRouter.post(
  "/:id/world/control",
  asyncRoute(async (req, res) => {
    const job = await ownLive(
      String(req.params.id),
      req.user.id,
      "happyoyster",
    );
    ensure(job.status === "LIVE", "世界会话未运行");
    const b = z
      .object({
        action: z.enum(["pause", "resume", "instruct", "rewind", "end"]),
        prompt: z.string().max(2000).optional(),
        second: z.number().min(0).max(120).optional(),
      })
      .parse(req.body);
    ensure(
      !(
        job.upstream_model.includes("adventure") &&
        ["pause", "resume", "rewind"].includes(b.action)
      ),
      "探索模式不支持此操作",
    );
    ensure(
      !(job.upstream_model.includes("acting") && b.action === "rewind"),
      "角色演绎不支持回溯",
    );
    const conn = await capabilityConnection(job),
      path = `/api/v2/apps/${encodeURIComponent(job.upstream_model)}/openapi/v1/travels/${b.action}`;
    const result = await bailianJson(conn, path, {
      encryptedTravelId: job.output.travelId,
      userAgent: String(req.headers["user-agent"] || "InfiniteCanvas"),
      ...(b.action === "instruct"
        ? { prompt: b.prompt, instruct: b.prompt }
        : {}),
      ...(b.action === "rewind" ? { second: b.second } : {}),
    });
    if (b.action === "end") {
      const duration = Math.min(
        maxDuration(job),
        Math.max(
          1,
          Math.ceil((Date.now() - new Date(job.started_at).getTime()) / 1000),
        ),
      );
      await settleCapability(
        job.id,
        capabilityCost(job, { duration }),
        "SUCCEEDED",
        job.output,
        { duration },
      );
    }
    res.json({ ok: true, data: result.data });
  }),
);
export async function expireLiveCapabilities() {
  const jobs = await db.query(
    "SELECT * FROM capability_jobs WHERE status IN ('LIVE','CONNECTING') AND protocol IN ('happyoyster','bailian-realtime','bailian-inference') AND COALESCE(started_at,updated_at) < now() - (LEAST(120,GREATEST(1,COALESCE((parameters->>'max_seconds')::numeric,60))) * interval '1 second')",
  );
  for (const job of jobs) {
    if (job.protocol === "happyoyster" && job.output.travelId) {
      try {
        const conn = await capabilityConnection(job);
        await bailianJson(
          conn,
          `/api/v2/apps/${encodeURIComponent(job.upstream_model)}/openapi/v1/travels/end`,
          {
            encryptedTravelId: job.output.travelId,
            userAgent: "InfiniteCanvas/Recovery",
          },
        );
      } catch {
        await db.query(
          "UPDATE capability_jobs SET status='RECONCILE',error='世界会话结束待核实' WHERE id=$1",
          [job.id],
        );
        continue;
      }
    }
    await settleCapability(
      job.id,
      capabilityCost(job, { duration: maxDuration(job) }),
      "SUCCEEDED",
      job.output,
      { duration: maxDuration(job), recovered: true },
    );
  }
}
