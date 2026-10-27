import { useRef, useState, useEffect } from "react";
import {
  Mic,
  MicOff,
  Play,
  Square,
  Send,
  Video,
  Volume2,
  MoveUp,
  MoveDown,
  MoveLeft,
  MoveRight,
  Pause,
  RefreshCw,
} from "lucide-react";
import { post, useData, type Row } from "./lib";

type Core = import("@happy-oyster/js-sdk-core").CoreTransport;
export function WorldPlayer({
  job,
  onRefresh,
}: {
  job: Row;
  onRefresh: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    rtc = useRef<Core | null>(null),
    live = useRef(false),
    seq = useRef(0),
    epoch = useRef(0),
    mounted = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mode, setMode] = useState(Number(job.output?.mode || 0));
  const entering = useRef(false);
  const [status, setStatus] = useState("世界已就绪，开始进入实时场景"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false),
    [instruct, setInstruct] = useState("");
  const cleanup = () => {
    epoch.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void rtc.current?.disconnect();
    rtc.current = null;
    if (live.current) {
      live.current = false;
      void fetch(`/api/v1/capabilities/${job.id}/world/control`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end" }),
        keepalive: true,
      });
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cleanup();
    };
  }, [job.id]);
  const enter = async () => {
    if (entering.current) return;
    entering.current = true;
    const version = ++epoch.current;
    const valid = () => mounted.current && version === epoch.current;
    setBusy(true);
    setError("");
    setStatus("正在建立RTC连接…");
    try {
      const data = await post(`/capabilities/${job.id}/world/start`);
      live.current = true;
      if (!valid()) {
        cleanup();
        return;
      }
      setMode(Number(data.mode));
      const { CoreTransport } = await import("@happy-oyster/js-sdk-core");
      if (!valid()) {
        cleanup();
        return;
      }
      const transport = new CoreTransport({
        log: () => {},
        warn: () => {},
        error: () => {},
      });
      rtc.current = transport;
      transport.setVideoElement(video.current!);
      transport.on("streamStart", () =>
        setStatus("已进入世界 · 使用方向键探索"),
      );
      transport.on("error", () => {
        setError("RTC连接异常，请结束会话后检查网络");
        cleanup();
        setConnected(false);
        onRefresh();
      });
      transport.on("bye", () => {
        live.current = false;
        setConnected(false);
        setStatus("世界会话已结束");
        onRefresh();
      });
      await transport.connect(data.rtcConfig, {
        enableDataChannel: true,
        enableDataWithoutMedia: true,
      });
      if (!valid()) {
        cleanup();
        return;
      }
      setConnected(true);
      timer.current = setTimeout(() => {
        if (live.current) {
          cleanup();
          setConnected(false);
          setStatus("体验时间结束");
          onRefresh();
        }
      }, data.maxSeconds * 1000);
    } catch (e) {
      if (valid()) setError(e instanceof Error ? e.message : "世界连接失败");
      cleanup();
    } finally {
      if (mounted.current) setBusy(false);
      entering.current = false;
    }
  };
  const command = (translation: string) => {
    rtc.current?.sendData(
      new TextEncoder().encode(
        JSON.stringify({
          type: "wander_control",
          seq: seq.current++ * 1000,
          cmd: { translation, rotation: "None", interaction: "None" },
        }),
      ).buffer,
      { kind: "control" },
    );
  };
  const control = async (action: string) => {
    try {
      await post(`/capabilities/${job.id}/world/control`, {
        action,
        prompt: instruct,
      });
      if (action === "end") {
        live.current = false;
        await rtc.current?.disconnect();
        setConnected(false);
        setStatus("体验已结束");
        onRefresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };
  return (
    <div className="world-player">
      <video
        ref={video}
        autoPlay
        playsInline
        controls
        className="world-video"
      />
      <div className="stream-state" role="status">
        {status}
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || connected || job.status !== "READY"}
          onClick={() => void enter()}
        >
          <Play size={15} />
          {busy ? "连接中…" : "进入世界"}
        </button>
        <button disabled={!connected} onClick={() => void control("end")}>
          <Square size={14} />
          结束体验
        </button>
      </div>
      {connected && mode === 1 && (
        <div
          className="world-navigation"
          tabIndex={0}
          aria-label="世界方向控制"
          onKeyDown={(e) => {
            const key = (
              {
                ArrowUp: "W",
                ArrowDown: "S",
                ArrowLeft: "A",
                ArrowRight: "D",
              } as Row
            )[e.key];
            if (key) {
              e.preventDefault();
              command(key);
            }
          }}
        >
          {[
            ["W", MoveUp, "向前"],
            ["A", MoveLeft, "向左"],
            ["S", MoveDown, "向后"],
            ["D", MoveRight, "向右"],
          ].map(([key, Icon, label]) => {
            const Symbol = Icon as typeof MoveUp;
            return (
              <button
                key={String(key)}
                aria-label={String(label)}
                onClick={() => command(String(key))}
              >
                <Symbol size={17} />
              </button>
            );
          })}
        </div>
      )}
      {connected && mode !== 1 && (
        <>
          <div className="inline-add">
            <input
              aria-label="世界导演指令"
              value={instruct}
              onChange={(e) => setInstruct(e.target.value)}
              placeholder="描述下一段场景或角色动作"
            />
            <button
              disabled={!instruct.trim()}
              onClick={() => void control("instruct")}
            >
              <Send size={14} />
              发送指令
            </button>
          </div>
          <div className="actions">
            <button onClick={() => void control("pause")}>
              <Pause size={14} />
              暂停
            </button>
            <button onClick={() => void control("resume")}>
              <Play size={14} />
              继续
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <small className="muted">
        RTC 凭证仅用于本次体验；长期 API Key
        不进入浏览器。离开此页面将结束会话。
      </small>
    </div>
  );
}
export function RealtimeSession({
  job,
  onRefresh,
}: {
  job: Row;
  onRefresh: () => void;
}) {
  const epoch = useRef(0),
    mounted = useRef(true),
    deviceBusy = useRef(false),
    connectBusy = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const socket = useRef<WebSocket | null>(null),
    capture = useRef<MediaStream | null>(null),
    context = useRef<AudioContext | null>(null),
    processor = useRef<ScriptProcessorNode | null>(null),
    camera = useRef<MediaStream | null>(null),
    cameraVideo = useRef<HTMLVideoElement>(null),
    cameraTimer = useRef<ReturnType<typeof setInterval> | null>(null),
    audioTime = useRef(0);
  const [state, setState] = useState("尚未连接"),
    [ready, setReady] = useState(false),
    [mic, setMic] = useState(false),
    [videoOn, setVideoOn] = useState(false),
    [message, setMessage] = useState(""),
    [transcript, setTranscript] = useState(""),
    [error, setError] = useState("");
  const inference = job.protocol === "bailian-inference",
    asr = job.parameters?.mode === "asr";
  const send = (event: Row) => {
    if (socket.current?.readyState === 1)
      socket.current.send(JSON.stringify(event));
  };
  const stopMic = () => {
    capture.current?.getTracks().forEach((t) => t.stop());
    capture.current = null;
    processor.current?.disconnect();
    processor.current = null;
    setMic(false);
  };
  const stopCamera = () => {
    camera.current?.getTracks().forEach((t) => t.stop());
    camera.current = null;
    if (cameraTimer.current) clearInterval(cameraTimer.current);
    cameraTimer.current = null;
    setVideoOn(false);
  };
  const end = () => {
    epoch.current++;
    connectBusy.current = false;
    setConnecting(false);
    stopMic();
    stopCamera();
    send({ type: "bridge.end" });
    if (socket.current?.readyState === 1) socket.current.close();
    socket.current = null;
    void context.current?.close();
    context.current = null;
    setReady(false);
    setState("会话已结束");
    onRefresh();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      capture.current?.getTracks().forEach((t) => t.stop());
      camera.current?.getTracks().forEach((t) => t.stop());
      processor.current?.disconnect();
      if (cameraTimer.current) clearInterval(cameraTimer.current);
      if (socket.current?.readyState === 1)
        socket.current.send(JSON.stringify({ type: "bridge.end" }));
      socket.current?.close();
      void context.current?.close();
    };
  }, [job.id]);
  const playPcm = async (base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    if (!bytes.length) return;
    const samples = new Int16Array(bytes.buffer);
    const ctx = context.current || new AudioContext();
    context.current = ctx;
    await ctx.resume();
    if (!mounted.current || !socket.current) {
      void ctx.close();
      return;
    }
    const buffer = ctx.createBuffer(1, samples.length, 24000);
    const floats = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const time = Math.max(ctx.currentTime + 0.02, audioTime.current);
    source.start(time);
    audioTime.current = time + buffer.duration;
  };
  const connect = async () => {
    if (
      connectBusy.current ||
      (socket.current && socket.current.readyState < 2)
    )
      return;
    connectBusy.current = true;
    setConnecting(true);
    const version = ++epoch.current;
    const valid = () => mounted.current && version === epoch.current;
    setError("");
    setTranscript("");
    setState("建立安全连接中…");
    try {
      const ticket = await post(`/capabilities/${job.id}/realtime-ticket`);
      if (!valid()) return;
      const url = new URL(ticket.path, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onmessage = (event) => {
        if (!valid() || socket.current !== ws) return;
        if (event.data instanceof ArrayBuffer) {
          const data = new Uint8Array(event.data);
          let binary = "";
          for (const byte of data) binary += String.fromCharCode(byte);
          void playPcm(btoa(binary));
          return;
        }
        const data = JSON.parse(event.data);
        if (data.type === "bridge.ready") {
          setState("已连接，初始化会话…");
          if (inference) send({ header: { action: "run-task" }, payload: {} });
          else send({ type: "session.update", session: {} });
        }
        if (
          data.type === "session.updated" ||
          data.header?.event === "task-started"
        ) {
          connectBusy.current = false;
          setConnecting(false);
          setReady(true);
          setState("会话就绪 · 可以发送文本或开启麦克风");
        }
        if (
          [
            "response.text.delta",
            "response.audio_transcript.delta",
            "response.output_text.delta",
          ].includes(data.type)
        )
          setTranscript((t) => t + data.delta);
        if (data.type === "response.audio.delta") void playPcm(data.delta);
        if (
          data.header?.event === "result-generated" &&
          data.payload?.output?.sentence?.text
        )
          setTranscript(data.payload.output.sentence.text);
        if (data.type === "bridge.warning" || data.type === "bridge.error")
          setError(data.message);
        if (data.type === "error")
          setError(String(data.error?.message || "上游返回错误"));
      };
      ws.onerror = () => {
        if (valid() && socket.current === ws)
          setError("实时连接失败，请检查渠道与网络");
      };
      ws.onclose = () => {
        if (!valid() || socket.current !== ws) return;
        socket.current = null;
        connectBusy.current = false;
        setConnecting(false);
        stopMic();
        stopCamera();
        setReady(false);
        setState("连接已结束");
        onRefresh();
      };
    } catch (e) {
      if (valid()) {
        setState("连接失败");
        setError(e instanceof Error ? e.message : "连接失败");
      }
    } finally {
      if (valid() && (!socket.current || socket.current.readyState >= 2)) {
        connectBusy.current = false;
        setConnecting(false);
      }
    }
  };
  const record = async () => {
    if (mic) {
      stopMic();
      if (!inference) {
        send({ type: "input_audio_buffer.commit" });
        send({ type: "response.create" });
      } else
        send({ header: { action: "finish-task" }, payload: { input: {} } });
      return;
    }
    if (deviceBusy.current) return;
    deviceBusy.current = true;
    const version = epoch.current;
    const currentSocket = socket.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (
        !mounted.current ||
        epoch.current !== version ||
        socket.current !== currentSocket ||
        currentSocket?.readyState !== 1
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      capture.current = stream;
      const ctx = context.current || new AudioContext();
      context.current = ctx;
      await ctx.resume();
      if (!mounted.current || epoch.current !== version) {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        return;
      }
      const input = ctx.createMediaStreamSource(stream),
        proc = ctx.createScriptProcessor(4096, 1, 1);
      processor.current = proc;
      proc.onaudioprocess = (e) => {
        if (socket.current?.readyState !== 1) return;
        const audio = e.inputBuffer.getChannelData(0),
          ratio = ctx.sampleRate / (inference && asr ? 16000 : 24000),
          pcm = new Int16Array(Math.floor(audio.length / ratio));
        for (let i = 0; i < pcm.length; i++)
          pcm[i] =
            Math.max(-1, Math.min(1, audio[Math.floor(i * ratio)])) * 32767;
        if (inference) socket.current.send(pcm.buffer);
        else {
          const bytes = new Uint8Array(pcm.buffer);
          let raw = "";
          for (const b of bytes) raw += String.fromCharCode(b);
          send({ type: "input_audio_buffer.append", audio: btoa(raw) });
        }
      };
      input.connect(proc);
      proc.connect(ctx.destination);
      setMic(true);
    } catch (e) {
      if (mounted.current)
        setError("无法使用麦克风，请检查浏览器授权和 HTTPS / localhost 环境");
    } finally {
      deviceBusy.current = false;
    }
  };
  const startCamera = async () => {
    if (videoOn) {
      stopCamera();
      return;
    }
    if (deviceBusy.current) return;
    deviceBusy.current = true;
    const version = epoch.current;
    const currentSocket = socket.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false,
      });
      if (
        !mounted.current ||
        version !== epoch.current ||
        socket.current !== currentSocket ||
        currentSocket?.readyState !== 1
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      camera.current = stream;
      const video = cameraVideo.current!;
      video.srcObject = stream;
      await video.play();
      if (!mounted.current || version !== epoch.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setVideoOn(true);
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      cameraTimer.current = setInterval(() => {
        if (video.readyState >= 2) {
          canvas.getContext("2d")!.drawImage(video, 0, 0, 640, 360);
          send({
            type: "input_image_buffer.append",
            image: canvas.toDataURL("image/jpeg", 0.5).split(",")[1],
          });
        }
      }, 1000);
    } catch {
      if (mounted.current)
        setError(
          "无法使用摄像头，请检查权限；仅支持图像输入的实时模型可使用此功能",
        );
    } finally {
      deviceBusy.current = false;
    }
  };
  const sendText = () => {
    if (!message.trim()) return;
    if (inference)
      send({
        header: { action: "continue-task" },
        payload: { input: { text: message } },
      });
    else {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message }],
        },
      });
      send({ type: "response.create" });
    }
    setMessage("");
  };
  return (
    <div className="realtime-panel">
      <div className="comparison-status" role="status">
        <span className="live-dot" />
        {state}
      </div>
      <div className="actions">
        <button
          className="primary"
          disabled={ready || connecting || job.status !== "READY"}
          onClick={() => void connect()}
        >
          <Play size={15} />
          {connecting ? "连接中…" : "连接实时会话"}
        </button>
        <button disabled={!ready} onClick={end}>
          <Square size={15} />
          结束
        </button>
        <button
          disabled={!ready}
          onClick={() => {
            const ctx = context.current || new AudioContext();
            context.current = ctx;
            void ctx.resume();
          }}
        >
          <Volume2 size={15} />
          允许播放声音
        </button>
        <span className="muted">
          最多 {job.parameters.max_seconds || 60} 秒
        </span>
      </div>
      <div className="realtime-transcript">
        {transcript || "模型的实时文字或转写会显示在这里，语音输出会同步播放。"}
      </div>
      <video
        className={videoOn ? "camera-preview" : "visually-hidden"}
        ref={cameraVideo}
        muted
        playsInline
      />
      <div className="actions">
        <button
          disabled={!ready || (inference && !asr)}
          className={mic ? "recording" : ""}
          onClick={() => void record()}
        >
          {mic ? <MicOff size={16} /> : <Mic size={16} />}{" "}
          {mic ? "停止并提交" : "开启麦克风"}
        </button>
        {!inference && (
          <button disabled={!ready} onClick={() => void startCamera()}>
            <Video size={16} />
            {videoOn ? "关闭摄像头" : "开启视频输入"}
          </button>
        )}
      </div>
      {!(inference && asr) && (
        <div className="inline-add">
          <input
            aria-label="实时消息"
            value={message}
            disabled={!ready}
            placeholder={inference ? "输入待合成文字" : "说说你的想法…"}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendText();
            }}
          />
          <button disabled={!ready || !message.trim()} onClick={sendText}>
            <Send size={15} />
            发送
          </button>
        </div>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <small className="muted">
        只有你点击开启后才会采集麦克风或摄像头；停止或离开时自动释放设备。长期密钥由服务端代理持有。
      </small>
    </div>
  );
}
