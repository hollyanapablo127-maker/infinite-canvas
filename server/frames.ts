import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getOwnedAsset, saveAsset } from "./assets";
import { db } from "./db";
import { ensure } from "./security";
import { readObject } from "./storage";

const exec = promisify(execFile);
export type FramePosition = "first_frame" | "last_frame";

export async function extractVideoFrame(
  video: Buffer,
  position: FramePosition,
) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "canvas-workflow-frame-"),
  );
  const input = path.join(dir, "source.mp4");
  const output = path.join(dir, "frame.jpg");
  try {
    await fs.writeFile(input, video);
    // Overwrite one JPEG as frames decode, keeping the actual last frame with bounded memory.
    // A longer audio track can place the tail seek past the video; retry from the start then.
    // A fine encoder timebase prevents adjacent VFR timestamps from collapsing together.
    const seeks = position === "last_frame" ? [["-sseof", "-3"], []] : [[]];
    for (const seek of seeks) {
      try {
        await exec(
          process.env.FFMPEG_PATH || "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "1",
            ...seek,
            "-i",
            input,
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            ...(position === "last_frame"
              ? [
                  "-fps_mode",
                  "passthrough",
                  "-enc_time_base",
                  "1:1000000",
                  "-update",
                  "1",
                ]
              : ["-frames:v", "1"]),
            "-threads",
            "1",
            "-q:v",
            "2",
            "-y",
            output,
          ],
          { timeout: 120000, maxBuffer: 1_000_000, windowsHide: true },
        );
      } catch (error) {
        if (!seek.length || (error as { killed?: boolean }).killed) throw error;
        continue;
      }
      const frame = await fs
        .readFile(output)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (frame?.length) return frame;
    }
    throw new Error("No decoded video frame");
  } catch {
    throw new Error(
      `视频${position === "first_frame" ? "首帧" : "尾帧"}提取失败，请检查视频素材和 FFmpeg 配置`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function frameAssetFor(
  videoAssetId: string,
  userId: string,
  position: FramePosition,
) {
  const source = await getOwnedAsset(videoAssetId, userId);
  ensure(
    source.kind === "video" && source.object_key,
    "上游任务没有可截帧的视频结果",
  );
  const name = position === "first_frame" ? "首帧.jpg" : "尾帧.jpg";
  const [cached] = await db.query(
    "SELECT * FROM assets WHERE user_id=$1 AND parent_id=$2 AND name=$3 AND deleted_at IS NULL AND purged_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
    [userId, source.id, name],
  );
  if (cached) return cached;
  const frame = await extractVideoFrame(
    await readObject(source.object_key, source.storage),
    position,
  );
  return saveAsset(userId, frame, name, undefined, source);
}
