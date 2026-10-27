import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { PDFDocument } from "pdf-lib";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import archiver from "archiver";
import { z } from "zod";
import { db, settings, transaction, type Row } from "./db";
import { asyncRoute, ensure, hash, sign, pagination } from "./security";
import { config } from "./config";
import { fetchPublic, resolvePublic } from "./network";
import {
  putObject,
  readObject,
  deleteObject,
  localSignedUrl,
  oss,
} from "./storage";
import { FILE_EXTENSIONS } from "../shared/wan";

const exec = promisify(execFile);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100_000_000, files: 1 },
});
const imageExtensions = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "gif",
];
const videoExtensions = ["mp4", "mov"];
const audioExtensions = ["mp3", "wav"];
async function decodableImage(buffer: Buffer) {
  if (buffer.subarray(0, 2).toString() !== "BM") return buffer;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-bmp-"));
  try {
    const input = path.join(dir, "input.bmp"),
      output = path.join(dir, "output.png");
    await fs.writeFile(input, buffer);
    await exec(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "1",
        "-i",
        input,
        "-frames:v",
        "1",
        "-y",
        output,
      ],
      { timeout: 30000, maxBuffer: 1_000_000, windowsHide: true },
    );
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
export async function inspect(buffer: Buffer, name: string) {
  const extension = path.extname(name).slice(1).toLowerCase();
  const actual = await fileTypeFromBuffer(buffer);
  let kind = "file";
  let metadata: Record<string, any> = {
    extension,
    mime: actual?.mime || "application/octet-stream",
  };
  if (imageExtensions.includes(extension)) {
    ensure(
      actual &&
        ["jpg", "png", "webp", "bmp", "tif", "gif"].includes(actual.ext),
      "图片真实格式与文件扩展名不符",
    );
    kind = "image";
    ensure(buffer.length <= 20_000_000, "图片不能超过 20MB");
    const m = await sharp(await decodableImage(buffer), {
      limitInputPixels: 64_000_000,
    }).metadata();
    metadata = {
      ...metadata,
      width: m.width,
      height: m.height,
      hasAlpha: m.hasAlpha,
    };
  } else if (
    videoExtensions.includes(extension) ||
    audioExtensions.includes(extension)
  ) {
    kind = videoExtensions.includes(extension) ? "video" : "audio";
    ensure(
      actual &&
        (kind === "video" ? ["mp4", "mov", "m4v"] : ["mp3", "wav"]).includes(
          actual.ext,
        ),
      "媒体格式不受支持",
    );
    if (kind === "audio")
      ensure(buffer.length <= 15_000_000, "音频不能超过 15MB");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-probe-"));
    const file = path.join(dir, `source.${extension}`);
    try {
      await fs.writeFile(file, buffer);
      const { stdout } = await exec(
        process.env.FFPROBE_PATH || "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
        { timeout: 30000, maxBuffer: 4_000_000, windowsHide: true },
      );
      const probe = JSON.parse(stdout);
      const v = probe.streams.find((s: any) => s.codec_type === "video");
      const a = probe.streams.find((s: any) => s.codec_type === "audio");
      ensure(kind === "video" ? v : a, "文件没有可识别的媒体轨道");
      const [num, den] = String(v?.avg_frame_rate || "0/1")
        .split("/")
        .map(Number);
      metadata = {
        ...metadata,
        duration: Number(probe.format.duration),
        width: v?.width,
        height: v?.height,
        fps: den ? num / den : 0,
        hasAudio: !!a,
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } else {
    ensure(
      FILE_EXTENSIONS.includes(extension),
      "支持图片、视频、音频及 Wan 文档格式",
    );
    if (["pdf"].includes(extension)) {
      ensure(actual?.ext === "pdf", "PDF 格式无效");
      metadata.pages = (
        await PDFDocument.load(buffer, { ignoreEncryption: false })
      ).getPageCount();
    }
    if (["doc", "xls", "ppt"].includes(extension))
      ensure(
        buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")),
        "Office 文件格式无效",
      );
    if (["docx", "xlsx", "pptx", "key", "pages", "numbers"].includes(extension))
      ensure(buffer.subarray(0, 2).toString() === "PK", "文档压缩结构无效");
    if (["docx", "pptx"].includes(extension)) {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      ensure(entries.length < 10000, "文档结构过大");
      if (extension === "pptx")
        metadata.pages = entries.filter((e) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName),
        ).length;
      else {
        const props = zip.getEntry("docProps/app.xml");
        if (props) {
          ensure(props.header.size < 1_000_000, "文档属性过大");
          const parsed = new XMLParser({ ignoreAttributes: true }).parse(
            props.getData().toString("utf8"),
          );
          const pages = Number(parsed.Properties?.Pages);
          if (Number.isFinite(pages) && pages > 0) metadata.pages = pages;
        }
      }
    }
    if (
      ["doc", "docx", "ppt", "key", "pages"].includes(extension) &&
      !metadata.pages
    )
      metadata.pageValidation = "provider";
    if (["txt", "md"].includes(extension)) {
      ensure(!buffer.includes(0), "文本文件编码无效");
      metadata.mime = "text/plain";
    }
    ensure(!metadata.pages || metadata.pages <= 50, "文档不能超过 50 页");
  }
  return {
    kind,
    metadata: {
      ...metadata,
      kind,
      size: buffer.length,
      checksum: hash(buffer.toString("base64")),
    } as Record<string, any>,
  };
}
export async function saveAsset(
  userId: string,
  buffer: Buffer,
  name: string,
  sourceUrl?: string,
  parent?: Row,
  resultTaskId?: string,
) {
  if (resultTaskId) {
    const [existing] = await db.query(
      "SELECT * FROM assets WHERE id=$1 AND user_id=$2",
      [resultTaskId, userId],
    );
    if (existing) return existing;
  }
  const { kind, metadata } = await inspect(buffer, name);
  const id = resultTaskId || randomUUID();
  const key = `${userId}/${id}/${path.basename(name).replace(/[^\p{L}\p{N}_.-]/gu, "_")}`;
  const storage = await putObject(key, buffer, metadata.mime);
  try {
    return await transaction(async (tx) => {
      await tx.query(
        "SELECT user_id FROM wallets WHERE user_id=$1 FOR UPDATE",
        [userId],
      );
      const [{ size }] = await tx.query(
        "SELECT COALESCE(sum(size),0) AS size FROM assets WHERE user_id=$1 AND purged_at IS NULL",
        [userId],
      );
      const s = (await tx.query("SELECT value FROM settings WHERE id=1"))[0]
        .value;
      const [{ pending }] = await tx.query(
        "SELECT count(*)::int AS pending FROM tasks WHERE user_id=$1 AND result_asset_id IS NULL AND (settlement='reserved' OR status='SAVING') AND ($2::uuid IS NULL OR id<>$2)",
        [userId, resultTaskId || null],
      );
      ensure(
        Number(size) + buffer.length + pending * 300_000_000 <=
          Number(s.storageLimitGB || 5) * 1_000_000_000,
        "临时资产空间已满，请先清理不需要的素材",
      );
      const expires = parent
        ? parent.expires_at
        : new Date(Date.now() + 30 * 86400000).toISOString();
      return (
        await tx.query(
          "INSERT INTO assets(id,user_id,name,kind,object_key,storage,source_url,metadata,size,expires_at,parent_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
          [
            id,
            userId,
            path.basename(name),
            kind,
            key,
            storage,
            sourceUrl || null,
            JSON.stringify(metadata),
            buffer.length,
            expires,
            parent?.id || null,
          ],
        )
      )[0];
    });
  } catch (e) {
    await deleteObject(key, storage).catch(() => {});
    throw e;
  }
}
export function assetView(a: Row) {
  const expired = new Date(a.expires_at).getTime() <= Date.now();
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    size: Number(a.size),
    metadata: a.metadata,
    tags: a.tags,
    created_at: a.created_at,
    expires_at: a.expires_at,
    deleted_at: a.deleted_at,
    parent_id: a.parent_id,
    expired,
    url:
      !expired && !a.deleted_at && !a.purged_at && a.object_key
        ? `/api/v1/assets/${a.id}/content`
        : undefined,
    source_url: a.kind === "link" ? a.source_url : undefined,
  };
}
export async function getOwnedAsset(id: string, userId: string, active = true) {
  const [a] = await db.query(
    `SELECT * FROM assets WHERE id=$1 AND user_id=$2${active ? " AND deleted_at IS NULL AND purged_at IS NULL AND expires_at>now()" : ""}`,
    [id, userId],
  );
  ensure(a, "素材不存在或已到期", 404);
  return a;
}
export async function importAsset(userId: string, url: string) {
  if (url.startsWith("data:")) {
    const match = url.match(
      /^data:image\/(png|jpeg|webp|bmp|tiff?|gif);base64,([a-zA-Z0-9+/=\s]+)$/,
    );
    ensure(match, "Base64 仅支持图片格式");
    return saveAsset(
      userId,
      Buffer.from(match[2], "base64"),
      `粘贴图片.${match[1] === "jpeg" ? "jpg" : match[1]}`,
    );
  }
  const [existing] = await db.query(
    "SELECT * FROM assets WHERE user_id=$1 AND source_url=$2 AND deleted_at IS NULL AND purged_at IS NULL AND expires_at>now() LIMIT 1",
    [userId, url],
  );
  if (existing) return existing;
  const result = await fetchPublic(url);
  let name = decodeURIComponent(
    new URL(result.url).pathname.split("/").pop() || "素材",
  );
  if (!path.extname(name)) {
    const type = await fileTypeFromBuffer(result.buffer);
    ensure(type, "无法识别素材，请上传本地文件");
    name += `.${type.ext}`;
  }
  return saveAsset(userId, result.buffer, name, url);
}
function referencesAsset(value: unknown, assetId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => referencesAsset(item, assetId));
  const fields = value as Record<string, unknown>;
  return (
    fields.asset_id === assetId ||
    Object.values(fields).some((item) => referencesAsset(item, assetId))
  );
}
async function ensureAssetNotInProgress(assetId: string, userId: string) {
  const active = await db.query(
    "SELECT id FROM tasks WHERE user_id=$1 AND status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','CANCELING','UNKNOWN') AND prepared_media @> $2::jsonb LIMIT 1",
    [userId, JSON.stringify([{ asset_id: assetId }])],
  );
  ensure(!active.length, "素材被未完成任务引用，暂不能删除");
  const activeImages = await db.query(
    "SELECT id FROM image_tasks WHERE user_id=$1 AND status IN ('QUEUED','SUBMITTING','PENDING','RUNNING','SAVING','UNKNOWN') AND input_images::jsonb @> $2::jsonb LIMIT 1",
    [userId, JSON.stringify([{ asset_id: assetId }])],
  );
  ensure(!activeImages.length, "图片素材被未完成任务引用，暂不能删除");
  const runs = await db.query(
    "SELECT steps FROM workflow_runs WHERE user_id=$1 AND status='RUNNING' AND steps::text LIKE $2",
    [userId, `%${assetId}%`],
  );
  ensure(
    !runs.some((run) => referencesAsset(run.steps, assetId)),
    "素材被运行中的工作流引用，暂不能删除",
  );
}
async function removeAssetFromProjects(
  tx: {
    query: <T extends Row = Row>(text: string, params?: any[]) => Promise<T[]>;
  },
  userId: string,
  assetId: string,
) {
  const projects = await tx.query(
    "SELECT id,version,content FROM projects WHERE user_id=$1 FOR UPDATE",
    [userId],
  );
  for (const project of projects) {
    const content =
      typeof project.content === "string"
        ? JSON.parse(project.content)
        : project.content || {};
    const nodes = Array.isArray(content.nodes) ? content.nodes : [];
    const removed = new Set<string>();
    const nextNodes = nodes
      .filter((node: any) => {
        const remove =
          node?.type === "asset" && node?.data?.asset_id === assetId;
        if (remove && node.id) removed.add(node.id);
        return !remove;
      })
      .map((node: any) => {
        if (node?.type !== "generation" || !Array.isArray(node.data?.media))
          return node;
        const media = node.data.media.filter(
          (item: any) => item?.asset_id !== assetId,
        );
        return media.length === node.data.media.length
          ? node
          : { ...node, data: { ...node.data, media } };
      });
    const nextEdges = (
      Array.isArray(content.edges) ? content.edges : []
    ).filter(
      (edge: any) => !removed.has(edge?.source) && !removed.has(edge?.target),
    );
    if (
      nextNodes.length === nodes.length &&
      nextEdges.length === (content.edges || []).length
    )
      continue;
    const nextContent = { ...content, nodes: nextNodes, edges: nextEdges };
    await tx.query(
      "INSERT INTO project_revisions(id,project_id,version,content) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [
        randomUUID(),
        project.id,
        project.version,
        JSON.stringify(project.content),
      ],
    );
    await tx.query(
      "UPDATE projects SET content=$2,version=version+1,updated_at=now() WHERE id=$1",
      [project.id, JSON.stringify(nextContent)],
    );
  }
}
export const assetRouter = Router();
assetRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const a = await getOwnedAsset(
      z.string().uuid().parse(req.params.id),
      req.user.id,
      false,
    );
    ensure(!a.purged_at, "素材已永久删除", 404);
    ensure(a.deleted_at, "请先移入回收站");
    await ensureAssetNotInProgress(a.id, req.user.id);
    if (a.object_key) await deleteObject(a.object_key, a.storage);
    await deleteObject(`thumbnails/${a.id}.jpg`, "local");
    await transaction(async (tx) => {
      const [locked] = await tx.query(
        "SELECT id FROM assets WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [a.id, req.user.id],
      );
      ensure(locked, "素材不存在", 404);
      await removeAssetFromProjects(tx, req.user.id, a.id);
      await tx.query(
        "UPDATE assets SET deleted_at=COALESCE(deleted_at,now()),purged_at=now(),expires_at=LEAST(expires_at,now()) WHERE id=$1",
        [a.id],
      );
    });
    res.json({ ok: true });
  }),
);
assetRouter.get(
  "/:id/thumbnail",
  asyncRoute(async (req, res) => {
    const a = await getOwnedAsset(
      z.string().uuid().parse(req.params.id),
      req.user.id,
    );
    ensure(["image", "video"].includes(a.kind), "此素材没有缩略图", 404);
    const { localPath } = await import("./storage");
    const cache = localPath(`thumbnails/${a.id}.jpg`);
    let image: Buffer;
    try {
      image = await fs.readFile(cache);
    } catch {
      const buffer = await readObject(a.object_key, a.storage);
      if (a.kind === "image")
        image = await sharp(await decodableImage(buffer))
          .resize(480, 320, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#edf2ee" })
          .jpeg({ quality: 75 })
          .toBuffer();
      else {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-thumb-"));
        try {
          const input = path.join(dir, "source.mp4"),
            output = path.join(dir, "thumb.jpg");
          await fs.writeFile(input, buffer);
          await exec(
            process.env.FFMPEG_PATH || "ffmpeg",
            [
              "-v",
              "error",
              "-threads",
              "1",
              "-i",
              input,
              "-frames:v",
              "1",
              "-vf",
              "scale=480:-2",
              "-y",
              output,
            ],
            { timeout: 30000, maxBuffer: 1_000_000, windowsHide: true },
          );
          image = await fs.readFile(output);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
      await fs.mkdir(path.dirname(cache), { recursive: true });
      await fs.writeFile(cache, image);
    }
    res
      .type("image/jpeg")
      .set("Cache-Control", "private, max-age=120")
      .send(image);
  }),
);
assetRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const rows = await db.query(
      "SELECT * FROM assets WHERE user_id=$1 AND purged_at IS NULL ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
      [req.user.id, ...pagination(req)],
    );
    res.json(rows.map(assetView));
  }),
);
assetRouter.post(
  "/upload",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    ensure(req.file, "请选择文件");
    const decoded = Buffer.from(req.file.originalname, "latin1").toString(
      "utf8",
    );
    if (!decoded.includes("\ufffd")) req.file.originalname = decoded;
    res
      .status(201)
      .json(
        assetView(
          await saveAsset(req.user.id, req.file.buffer, req.file.originalname),
        ),
      );
  }),
);
assetRouter.post(
  "/import",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        url: z.string().max(30_000_000),
        kind: z.enum(["media", "link"]).default("media"),
      })
      .parse(req.body);
    if (b.kind === "link") {
      await resolvePublic(b.url);
      const [a] = await db.query(
        "INSERT INTO assets(id,user_id,name,kind,storage,source_url,metadata,expires_at) VALUES($1,$2,$3,'link','external',$4,'{}',now()+interval '30 days') RETURNING *",
        [randomUUID(), req.user.id, new URL(b.url).hostname, b.url],
      );
      res.status(201).json(assetView(a));
    } else
      res.status(201).json(assetView(await importAsset(req.user.id, b.url)));
  }),
);
assetRouter.get(
  "/:id/content",
  asyncRoute(async (req, res) => {
    const a = await getOwnedAsset(
      z.string().uuid().parse(req.params.id),
      req.user.id,
    );
    ensure(a.object_key, "网页没有可下载文件");
    res.setHeader("Cache-Control", "private, no-store");
    res.type(a.metadata.mime || "application/octet-stream");
    if (req.query.download === "1")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      );
    const buffer = await readObject(a.object_key, a.storage);
    const range = req.headers.range;
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/);
      ensure(match, "Range 无效", 416);
      const start = Number(match[1]),
        end = match[2]
          ? Math.min(Number(match[2]), buffer.length - 1)
          : buffer.length - 1;
      ensure(start <= end && start < buffer.length, "Range 无效", 416);
      res
        .status(206)
        .set({
          "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(end - start + 1),
        })
        .send(buffer.subarray(start, end + 1));
    } else res.set("Accept-Ranges", "bytes").send(buffer);
  }),
);
assetRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1).max(150).optional(),
        tags: z.array(z.string().max(30)).max(20).optional(),
        deleted: z.boolean().optional(),
      })
      .parse(req.body);
    const a = await getOwnedAsset(req.params.id, req.user.id, false);
    ensure(!a.purged_at, "素材已经清理，无法恢复");
    if (b.deleted && !a.deleted_at)
      await ensureAssetNotInProgress(a.id, req.user.id);
    if (b.deleted && !a.deleted_at) {
      await transaction(async (tx) => {
        const [locked] = await tx.query(
          "SELECT id FROM assets WHERE id=$1 AND user_id=$2 FOR UPDATE",
          [a.id, req.user.id],
        );
        ensure(locked, "素材不存在", 404);
        await removeAssetFromProjects(tx, req.user.id, a.id);
        await tx.query(
          "UPDATE assets SET name=$2,tags=$3,deleted_at=now() WHERE id=$1",
          [a.id, b.name || a.name, JSON.stringify(b.tags || a.tags)],
        );
      });
    } else {
      await db.query(
        "UPDATE assets SET name=$2,tags=$3,deleted_at=$4 WHERE id=$1",
        [
          a.id,
          b.name || a.name,
          JSON.stringify(b.tags || a.tags),
          b.deleted === undefined
            ? a.deleted_at
            : b.deleted
              ? new Date().toISOString()
              : null,
        ],
      );
    }
    res.json({ ok: true });
  }),
);
assetRouter.post(
  "/:id/derive",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        operation: z.enum([
          "trim",
          "frame",
          "frame_first",
          "frame_last",
          "flatten",
        ]),
        start: z.number().min(0).default(0),
        duration: z.number().min(1).max(15).default(5),
        background: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default("#ffffff"),
      })
      .parse(req.body);
    const a = await getOwnedAsset(req.params.id, req.user.id);
    const buffer = await readObject(a.object_key, a.storage);
    let result: Buffer;
    let name: string;
    if (b.operation === "flatten") {
      ensure(a.kind === "image", "请选择图片");
      result = await sharp(await decodableImage(buffer))
        .flatten({ background: b.background })
        .jpeg({ quality: 95 })
        .toBuffer();
      name = `${path.parse(a.name).name}-无透明.jpg`;
    } else if (b.operation === "frame_first" || b.operation === "frame_last") {
      ensure(a.kind === "video", "仅视频可提取首尾帧");
      const { extractVideoFrame } = await import("./frames");
      const first = b.operation === "frame_first";
      result = await extractVideoFrame(
        buffer,
        first ? "first_frame" : "last_frame",
      );
      name = `${path.parse(a.name).name}-${first ? "首帧" : "尾帧"}.jpg`;
    } else {
      ensure(["video", "audio"].includes(a.kind), "请选择视频或音频");
      const frameOperation = b.operation === "frame";
      ensure(!frameOperation || a.kind === "video", "仅视频可截帧");
      const duration = Number(a.metadata.duration);
      ensure(b.start < duration, "起点超过素材时长");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-edit-"));
      const input = path.join(dir, `input.${a.metadata.extension}`);
      const ext = frameOperation ? "jpg" : a.kind === "video" ? "mp4" : "mp3";
      const output = path.join(dir, `output.${ext}`);
      try {
        await fs.writeFile(input, buffer);
        const args = [
          "-v",
          "error",
          "-threads",
          "2",
          "-ss",
          String(b.start),
          "-i",
          input,
        ];
        if (frameOperation) args.push("-frames:v", "1");
        else
          args.push(
            "-t",
            String(b.duration),
            ...(a.kind === "video"
              ? [
                  "-c:v",
                  "libx264",
                  "-preset",
                  "fast",
                  "-pix_fmt",
                  "yuv420p",
                  "-r",
                  "30",
                  "-c:a",
                  "aac",
                ]
              : ["-c:a", "libmp3lame"]),
          );
        await exec(
          process.env.FFMPEG_PATH || "ffmpeg",
          [...args, "-y", output],
          { timeout: 120000, maxBuffer: 2_000_000, windowsHide: true },
        );
        result = await fs.readFile(output);
        name = `${path.parse(a.name).name}-${frameOperation ? "截帧" : "片段"}.${ext}`;
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    res.json(
      assetView(await saveAsset(req.user.id, result, name, undefined, a)),
    );
  }),
);
assetRouter.get(
  "/exports/list",
  asyncRoute(async (req, res) => {
    res.json(
      await db.query(
        "SELECT id,status,error,expires_at,created_at FROM export_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",
        [req.user.id],
      ),
    );
  }),
);
assetRouter.post(
  "/exports",
  asyncRoute(async (req, res) => {
    const ids = z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .parse(req.body.asset_ids);
    const assets = await Promise.all(
      ids.map((id) => getOwnedAsset(id, req.user.id)),
    );
    ensure(
      assets.every((a) => a.object_key),
      "网页不能打包下载",
    );
    ensure(
      assets.reduce((s, a) => s + Number(a.size), 0) <= 500_000_000,
      "单个下载包不能超过 500MB，请分批选择",
    );
    const expires = new Date(
      Math.min(
        Date.now() + 24 * 3600000,
        ...assets.map((a) => new Date(a.expires_at).getTime()),
      ),
    ).toISOString();
    const id = randomUUID();
    await db.query(
      "INSERT INTO export_jobs(id,user_id,asset_ids,expires_at) VALUES($1,$2,$3,$4)",
      [id, req.user.id, JSON.stringify(ids), expires],
    );
    res.status(202).json({ id });
  }),
);
assetRouter.get(
  "/exports/:id/download",
  asyncRoute(async (req, res) => {
    const [job] = await db.query(
      "SELECT * FROM export_jobs WHERE id=$1 AND user_id=$2 AND status='SUCCEEDED' AND expires_at>now()",
      [req.params.id, req.user.id],
    );
    ensure(job, "下载包尚未完成或已过期", 404);
    res
      .set("Cache-Control", "no-store")
      .attachment("canvas-assets.zip")
      .send(await readObject(job.object_key, "local"));
  }),
);

export async function processExports() {
  const jobs = await db.query(
    "SELECT * FROM export_jobs WHERE status='QUEUED' ORDER BY created_at LIMIT 1",
  );
  for (const job of jobs) {
    await db.query("UPDATE export_jobs SET status='RUNNING' WHERE id=$1", [
      job.id,
    ]);
    try {
      const archive = archiver("zip", { zlib: { level: 1 } });
      const chunks: Buffer[] = [];
      const done = new Promise<Buffer>((resolve, reject) => {
        archive.on("data", (c) => chunks.push(c));
        archive.on("end", () => resolve(Buffer.concat(chunks)));
        archive.on("error", reject);
      });
      for (const [i, id] of job.asset_ids.entries()) {
        const a = await getOwnedAsset(id, job.user_id);
        archive.append(await readObject(a.object_key, a.storage), {
          name: `${i + 1}-${path.basename(a.name)}`,
        });
      }
      await archive.finalize();
      const buffer = await done;
      const key = `exports/${job.id}.zip`;
      const { localPath } = await import("./storage");
      const file = localPath(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buffer);
      await db.query(
        "UPDATE export_jobs SET status='SUCCEEDED',object_key=$2 WHERE id=$1",
        [job.id, key],
      );
    } catch (e) {
      await db.query(
        "UPDATE export_jobs SET status='FAILED',error=$2 WHERE id=$1",
        [job.id, e instanceof Error ? e.message : "打包失败"],
      );
    }
  }
}
export async function cleanupAssets() {
  const expired = await db.query(
    "SELECT * FROM assets WHERE expires_at<=now() AND purged_at IS NULL LIMIT 100",
  );
  for (const a of expired) {
    try {
      if (a.object_key) await deleteObject(a.object_key, a.storage);
      await deleteObject(`thumbnails/${a.id}.jpg`, "local");
      await db.query("UPDATE assets SET purged_at=now() WHERE id=$1", [a.id]);
    } catch {
      /* Retain the row for the next cleanup retry. */
    }
  }
  const exports = await db.query(
    "SELECT * FROM export_jobs WHERE expires_at<=now() AND object_key IS NOT NULL",
  );
  for (const e of exports) {
    await deleteObject(e.object_key, "local");
    await db.query("UPDATE export_jobs SET object_key=NULL WHERE id=$1", [
      e.id,
    ]);
  }
  for (const days of [7, 3, 1]) {
    const soon = await db.query(
      "SELECT * FROM assets WHERE expires_at>now() AND expires_at<=now()+$1::interval AND deleted_at IS NULL",
      [`${days} days`],
    );
    for (const a of soon) {
      await db.query(
        "INSERT INTO notifications(id,user_id,title,body,resource_id,unique_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          a.user_id,
          "素材即将到期",
          `${a.name} 将在 ${days} 天内到期，请及时下载`,
          a.id,
          `expiry:${a.id}:${days}`,
        ],
      );
    }
  }
}
export const mediaRouter = Router();
mediaRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const expires = Number(req.query.expires);
    ensure(
      Number.isFinite(expires) &&
        expires > Date.now() &&
        String(req.query.signature) === sign(`${id}:${expires}`),
      "链接已过期",
      403,
    );
    const [a] = await db.query(
      "SELECT * FROM assets WHERE id=$1 AND expires_at>now() AND deleted_at IS NULL AND purged_at IS NULL",
      [id],
    );
    ensure(a?.object_key, "文件不存在", 404);
    res
      .set("Cache-Control", "no-store")
      .type(a.metadata.mime)
      .send(await readObject(a.object_key, a.storage));
  }),
);
