import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const work = path.join(root, ".test-data", "live-acceptance");
const statePath = path.join(work, "state.json");
const base = "http://127.0.0.1:4023";
const limit = 30;
mkdirSync(work, { recursive: true });

const info = Object.fromEntries(
  readFileSync("C:/Users/10297/Desktop/info.txt", "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^([^:=：]+)\s*[:=：]\s*(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim()]),
);
for (const label of [
  "SMTP地址", "SMTP登录账号", "密码", "收件邮箱",
  "百炼业务空间ID/WorkspaceId", "百炼apikey",
]) {
  if (!info[label]) throw new Error(`配置缺少：${label}`);
}
if (info["API HOST"]?.replace(/^https?:\/\//, "").replace(/\/$/, "") !==
  `${info["百炼业务空间ID/WorkspaceId"]}.cn-beijing.maas.aliyuncs.com`)
  throw new Error("北京 API Host 与 WorkspaceId 不一致");

let state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {
      admin: `live_admin_${randomBytes(4).toString("hex")}`,
      adminPassword: randomBytes(24).toString("base64url"),
      user: `live_user_${randomBytes(4).toString("hex")}`,
      userPassword: randomBytes(24).toString("base64url"),
      cases: {},
    };
function save() {
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temporary, statePath);
}
save();

let child;
let log;
function stopChild() {
  if (child && !child.killed) child.kill();
  log?.end();
}
process.once("SIGINT", () => { stopChild(); process.exit(130); });
process.once("SIGTERM", () => { stopChild(); process.exit(143); });

async function health() {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).region === "cn-beijing";
  } catch { return false; }
}
async function startServer() {
  if (await health()) {
    console.log("Reusing isolated acceptance server on 4023");
    return;
  }
  log = createWriteStream(path.join(work, "server.log"), { flags: "a" });
  const env = { ...process.env,
    DATA_DIR: path.join(work, "data"), PORT: "4023", HOST: "127.0.0.1",
    APP_ORIGIN: base, NODE_ENV: "development", SMTP_HOST: info["SMTP地址"],
    SMTP_PORT: info["服务器端口（SSL加密）"] || "465", SMTP_SECURE: "true",
    SMTP_USER: info["SMTP登录账号"], SMTP_PASS: info["密码"],
    SMTP_FROM: info["SMTP登录账号"],
  };
  delete env.DATABASE_URL;
  delete env.PUBLIC_BASE_URL;
  child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  for (let i = 0; i < 90; i++) {
    if (await health()) return;
    if (child.exitCode !== null) throw new Error("验收服务启动失败，请检查 server.log");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("验收服务启动超时");
}

async function request(method, route, body, cookie) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${payload.message || payload.code || ""}`);
  return { payload, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function login(username, password) {
  return request("POST", "/api/v1/auth/login", { username, password });
}
async function setup() {
  const config = (await request("GET", "/api/v1/auth/config")).payload;
  let admin;
  if (config.setupRequired) {
    admin = await request("POST", "/api/v1/auth/setup", {
      username: state.admin, password: state.adminPassword, display_name: "真实验收管理员",
    });
  } else admin = await login(state.admin, state.adminPassword);
  const adminCookie = admin.cookie;
  const current = (await request("GET", "/api/v1/admin/credentials", null, adminCookie)).payload;
  if (!current.some((c) => c.id === state.credentialId)) {
    const created = await request("POST", "/api/v1/admin/credentials", {
      name: "北京真实验收", account_group: "live-acceptance",
      workspace: info["百炼业务空间ID/WorkspaceId"], key: info["百炼apikey"],
      enabled: true, models: ["wan3.0-video", "wan3.0-video-prime"],
      multiplier: 1, priority: 0, concurrency: 1, budget: limit,
    }, adminCookie);
    state.credentialId = created.payload.id;
    save();
  }
  let user;
  try { user = await login(state.user, state.userPassword); }
  catch {
    await request("POST", "/api/v1/admin/users", {
      username: state.user, password: state.userPassword,
      display_name: "真实验收用户", role: "user",
    }, adminCookie);
    user = await login(state.user, state.userPassword);
  }
  state.userId = user.payload.user.id;
  save();
  const wallet = (await request("GET", "/api/v1/wallet", null, user.cookie)).payload;
  if (!state.funded) {
    await request("POST", `/api/v1/admin/users/${state.userId}/balance`, {
      type: "recharge", amount: limit, reason: "首轮真实验收测试余额",
      idempotencyKey: "live-acceptance-initial-30-yuan",
    }, adminCookie);
    state.funded = true;
    save();
  }
  console.log(`Isolated account ready; wallet before run: ${wallet.available} yuan`);
  return { adminCookie, userCookie: user.cookie };
}

async function email(adminCookie) {
  if (state.emailAttempted) return;
  const current = (await request("GET", "/api/v1/admin/settings", null, adminCookie)).payload;
  const { services, ...settings } = current;
  await request("PATCH", "/api/v1/admin/settings", {
    ...settings, registrationOpen: true, emailVerification: true,
  }, adminCookie);
  state.emailAttempted = true;
  save();
  const result = await request("POST", "/api/v1/auth/email-code", {
    email: info["收件邮箱"], purpose: "register",
  });
  state.emailAccepted = result.payload.message === "如邮箱可用，将收到验证码";
  save();
  console.log(`Registration code SMTP handoff: ${state.emailAccepted ? "accepted" : "unconfirmed"}`);
}

const cases = [
  ...["wan3.0-video", "wan3.0-video-prime"].flatMap((model) =>
    ["480P", "720P", "1080P"].map((resolution) => ({
      id: `${model}-${resolution}-text`, model, resolution, mode: "text",
    }))),
  ...["wan3.0-video", "wan3.0-video-prime"].map((model) => ({
    id: `${model}-480P-first`, model, resolution: "480P", mode: "first",
  })),
  ...["frames", "reference_image", "reference_video", "edit", "extend", "file", "reference_audio"].map((kind) => ({
    id: `wan3.0-video-480P-${kind}`, model: "wan3.0-video",
    resolution: "480P", mode: ["reference_image", "reference_video", "reference_audio"].includes(kind) ? "reference" : kind,
    kind,
  })),
];
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN", "RECONCILE", "DELIVERY_FAILED"]);
function budgetUsed() {
  return Object.values(state.cases).reduce((total, c) =>
    total + (c.status === "SUCCEEDED" ? c.charged : c.reserved), 0);
}
async function uploadTemporary(model, bytes, extension = "png", mime = "image/png") {
  const response = await fetch(`https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=${model}`, {
    headers: { Authorization: `Bearer ${info["百炼apikey"]}` },
    signal: AbortSignal.timeout(20000),
  });
  const policy = await response.json();
  if (!response.ok || !policy.data?.upload_dir) throw new Error(`临时上传凭证失败：HTTP ${response.status} ${policy.code || ""}`);
  const p = policy.data;
  if (!new URL(p.upload_host).hostname.endsWith(".oss-cn-beijing.aliyuncs.com"))
    throw new Error("临时上传地址不是北京地域");
  const fileName = `wan-acceptance-${randomUUID()}.${extension}`;
  const key = `${p.upload_dir}/${fileName}`;
  if (!key.startsWith("dashscope-instant/")) throw new Error("临时上传目录异常");
  const form = new FormData();
  for (const [name, value] of Object.entries({
    OSSAccessKeyId: p.oss_access_key_id, Signature: p.signature,
    policy: p.policy, "x-oss-object-acl": p.x_oss_object_acl,
    "x-oss-forbid-overwrite": p.x_oss_forbid_overwrite,
    key, success_action_status: "200",
  })) form.append(name, value);
  form.append("file", new Blob([bytes], { type: mime }), fileName);
  const uploaded = await fetch(p.upload_host, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
  if (!uploaded.ok) throw new Error(`临时素材上传失败：HTTP ${uploaded.status}`);
  return `oss://${key}`;
}

const firstImage = () => readFileSync(path.join(root, "public/samples/wan-first-frame.png"));
const binding = (model) => ({ credential_id: state.credentialId, model });
async function mediaFor(spec) {
  if (spec.mode === "text") return [];
  if (spec.mode === "first") return [{ type: "first_frame",
    url: await uploadTemporary(spec.model, firstImage()), binding: binding(spec.model) }];
  const first = state.cases["wan3.0-video-480P-first"]?.input.input.media[0].url;
  if (!first) throw new Error("首帧素材尚未完成");
  if (spec.kind === "frames") {
    const last = await sharp(firstImage()).flop().modulate({ brightness: 1.08 }).png().toBuffer();
    return [
      { type: "first_frame", url: first, binding: binding(spec.model) },
      { type: "last_frame", url: await uploadTemporary(spec.model, last), binding: binding(spec.model) },
    ];
  }
  if (spec.kind === "reference_image")
    return [{ type: "reference_image", url: first, binding: binding(spec.model) }];
  if (["reference_video", "edit", "extend"].includes(spec.kind)) {
    if (!state.referenceVideoUrl) {
      const id = state.cases["wan3.0-video-480P-text"]?.assetId;
      if (!id) throw new Error("参考视频尚未生成");
      const file = path.join(work, "data", "objects", state.userId, id, `Wan-${id.slice(0, 8)}.mp4`);
      state.referenceVideoUrl = await uploadTemporary(spec.model, readFileSync(file), "mp4", "video/mp4");
      save();
    }
    return [{ type: "reference_video", url: state.referenceVideoUrl, binding: binding(spec.model) }];
  }
  if (spec.kind === "file") {
    const story = "一只白色纸鹤放在明亮的木桌上。镜头慢慢靠近，纸鹤轻轻转动。背景保持简洁。";
    return [{ type: "file", url: await uploadTemporary(spec.model, Buffer.from(story), "txt", "text/plain"),
      binding: binding(spec.model) }];
  }
  if (spec.kind === "reference_audio") {
    const file = path.join(work, "reference-tone.wav");
    if (!existsSync(file)) {
      const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=16000", "-t", "2", "-c:a", "pcm_s16le", file],
      { windowsHide: true });
      if (generated.status !== 0) throw new Error("测试音频生成失败");
    }
    return [{ type: "reference_audio", url: await uploadTemporary(spec.model,
      readFileSync(file), "wav", "audio/wav"), binding: binding(spec.model) }];
  }
  throw new Error(`未知素材测试：${spec.kind}`);
}

async function runCase(spec, cookie) {
  let record = state.cases[spec.id];
  if (record?.status === "SUCCEEDED" || record?.status === "FAILED") return record;
  if (!record) {
    const media = await mediaFor(spec);
    const prompts = {
      first: "以这张图片为首帧，画面中的场景缓慢向前推进，保持原有构图和色彩。",
      frames: "从首帧平滑过渡到尾帧，场景自然移动，保持原有风格。",
      reference_image: "参考图1的构图与颜色，纸鹤缓慢转动，镜头稳定。",
      reference_video: "参考视频1的主体和节奏，生成纸鹤缓慢转动的新镜头。",
      edit: "保留视频1的纸鹤与镜头运动，将背景改为浅蓝色。",
      extend: "延续视频1的镜头，纸鹤继续缓慢转动。",
      file: "根据文件中的故事生成一个连贯的短镜头。",
      reference_audio: "参考音频1的音调，纸鹤在桌面上轻轻转动，保持画面简洁。",
    };
    const input = {
      model: spec.model, mode: spec.mode,
      input: { prompt: prompts[spec.kind || spec.mode] ||
        "一只白色纸鹤在明亮的桌面上缓缓转动，镜头稳定，背景简洁。", media },
      parameters: { resolution: spec.resolution, ratio: "adaptive", duration: 2,
        audio: false, seed: -1, prompt_extend: true, watermark: false },
    };
    if (spec.kind === "reference_audio") Object.assign(input.parameters, {
      ratio: "1:1", audio: true, seed: 12345, prompt_extend: false, watermark: true,
    });
    const quote = (await request("POST", "/api/v1/quotes", input, cookie)).payload;
    if (budgetUsed() + quote.reserved > limit + 1e-7) {
      console.log(`Budget guard stopped before ${spec.id}: ${budgetUsed()} + ${quote.reserved} > ${limit}`);
      return null;
    }
    record = { input, idempotencyKey: randomUUID(), reserved: quote.reserved,
      status: "INTENT", createdAt: new Date().toISOString() };
    state.cases[spec.id] = record;
    save();
  }
  if (!record.taskId) {
    const quote = (await request("POST", "/api/v1/quotes", record.input, cookie)).payload;
    if (quote.reserved !== record.reserved) throw new Error(`${spec.id}: 报价已变化`);
    const result = await fetch(`${base}/api/v1/generations`, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "application/json",
        "idempotency-key": record.idempotencyKey },
      body: JSON.stringify({ input: record.input, quoteToken: quote.token }),
      signal: AbortSignal.timeout(120000),
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(`${spec.id}: 提交失败 HTTP ${result.status} ${payload.message || ""}`);
    record.taskId = payload.id;
    record.status = payload.status;
    save();
    console.log(`Submitted ${spec.id}; task ${record.taskId}; reserved ${record.reserved} yuan`);
  }
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const task = (await request("GET", `/api/v1/generations/${record.taskId}`, null, cookie)).payload;
    if (task.status !== record.status) {
      record.status = task.status;
      record.charged = task.charged;
      record.usage = task.usage;
      record.assetId = task.result_asset_id;
      record.error = task.error;
      save();
      console.log(`${spec.id}: ${record.status}; charged ${record.charged} yuan`);
    }
    if (terminal.has(task.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`${spec.id}: 超过 12 分钟仍未完成；停止新增任务，稍后续跑`);
}

async function verifyDelivery(cookie) {
  for (const [id, record] of Object.entries(state.cases)) {
    if (record.status !== "SUCCEEDED" || !record.assetId) continue;
    const response = await fetch(`${base}/api/v1/assets/${record.assetId}/content`, {
      headers: { cookie, range: "bytes=0-1023" },
      signal: AbortSignal.timeout(30000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status !== 206 || bytes.length !== 1024 ||
      !response.headers.get("content-type")?.startsWith("video/mp4") ||
      bytes.toString("ascii", 4, 8) !== "ftyp")
      throw new Error(`${id}: 视频分段下载校验失败`);
    record.deliveryVerified = true;
    save();
  }
  const one = Object.values(state.cases).find((c) => c.assetId);
  if (one) {
    const anonymous = await fetch(`${base}/api/v1/assets/${one.assetId}/content`, {
      signal: AbortSignal.timeout(30000),
    });
    if (anonymous.status !== 401) throw new Error("资产匿名访问未被拒绝");
    state.anonymousDenied = true;
    save();
  }
}

try {
  await startServer();
  const { adminCookie, userCookie } = await setup();
  await email(adminCookie);
  for (const spec of cases) {
    const result = await runCase(spec, userCookie);
    if (!result || result.status !== "SUCCEEDED") {
      console.log(`Stopped after ${spec.id}: ${result?.status || "budget limit"}`);
      break;
    }
  }
  await verifyDelivery(userCookie);
  const wallet = (await request("GET", "/api/v1/wallet", null, userCookie)).payload;
  console.log(JSON.stringify({ emailAccepted: state.emailAccepted,
    budgetCounted: budgetUsed(), walletAvailable: wallet.available,
    anonymousDenied: state.anonymousDenied,
    cases: Object.entries(state.cases).map(([id, c]) => ({ id, taskId: c.taskId,
      status: c.status, reserved: c.reserved, charged: c.charged,
      assetSaved: !!c.assetId, deliveryVerified: !!c.deliveryVerified })) }, null, 2));
} catch (error) {
  console.error(`Acceptance paused: ${error.message}`);
  process.exitCode = 1;
} finally { stopChild(); }
