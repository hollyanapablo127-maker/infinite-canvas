import OSS from "ali-oss";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { ensure, sign } from "./security";

if (process.env.OSS_REGION && process.env.OSS_REGION !== "oss-cn-beijing")
  throw new Error("本站仅支持华北2（北京）OSS");
export const oss =
  process.env.OSS_BUCKET &&
  process.env.OSS_ACCESS_KEY_ID &&
  process.env.OSS_ACCESS_KEY_SECRET
    ? new OSS({
        region: process.env.OSS_REGION || "oss-cn-beijing",
        bucket: process.env.OSS_BUCKET,
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        secure: true,
        timeout: 120000,
      })
    : null;
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
) {
  if (oss) {
    await oss.put(key, body, {
      headers: { "Content-Type": contentType, "x-oss-object-acl": "private" },
    });
    return "oss";
  }
  const file = localPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return "local";
}
export function localPath(key: string) {
  const root = path.join(config.dataDir, "objects");
  const file = path.resolve(root, key);
  ensure(file.startsWith(root + path.sep), "文件路径无效");
  return file;
}
export async function readObject(key: string, storage: string) {
  return storage === "oss" && oss
    ? Buffer.from((await oss.get(key)).content as Buffer)
    : fs.readFile(localPath(key));
}
export async function deleteObject(key: string, storage: string) {
  if (storage === "oss") {
    ensure(oss, "OSS 未配置");
    await oss.delete(key);
  } else await fs.rm(localPath(key), { force: true });
}
export function localSignedUrl(id: string, expires: number) {
  return `/api/v1/media/${id}?expires=${expires}&signature=${sign(`${id}:${expires}`)}`;
}
export async function inputAssetUrl(asset: any) {
  const seconds = Math.min(
    86400,
    Math.floor((new Date(asset.expires_at).getTime() - Date.now()) / 1000),
  );
  ensure(seconds > 1800, "素材即将到期，请重新上传后生成");
  if (asset.storage === "oss") {
    ensure(oss, "OSS 未配置");
    return oss.signatureUrl(asset.object_key, { expires: seconds });
  }
  ensure(
    config.publicBase.startsWith("https://"),
    "生成前请配置北京 OSS，或设置可公开访问的 HTTPS 站点地址",
    503,
  );
  return (
    config.publicBase + localSignedUrl(asset.id, Date.now() + seconds * 1000)
  );
}
