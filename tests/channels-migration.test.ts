import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
test("legacy channels merge only with proven shared creation, preserving credential history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "channel-migration-"));
  process.env.DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  delete process.env.NODE_ENV;
  const { db, migrate, closeDb } = await import("../server/db");
  const { encrypt } = await import("../server/security");
  const { migrateProviderChannels, providerChannelList } =
    await import("../server/channels");
  try {
    await migrate();
    const vid = randomUUID(),
      img = randomUUID(),
      standalone = randomUUID(),
      key = encrypt("isolated-key");
    await db.query(
      "INSERT INTO credentials(id,name,account_group,workspace,secret,models) VALUES($1,'相同名称','test-account','test-space',$2,$3)",
      [vid, key, JSON.stringify(["wan3.0-video"])],
    );
    await db.query(
      "INSERT INTO credential_versions(credential_id,version,secret,workspace) VALUES($1,1,$2,'test-space')",
      [vid, key],
    );
    for (const id of [img, standalone]) {
      await db.query(
        "INSERT INTO image_credentials(id,provider,name,workspace,encrypted_key,key_version,metadata) VALUES($1,'qwen','相同名称','test-space',$2,1,$3)",
        [
          id,
          id === img ? key : encrypt("different-key"),
          { models: ["qwen-image-3.0"] },
        ],
      );
      await db.query(
        "INSERT INTO image_credential_versions(credential_id,version,encrypted_key,workspace) VALUES($1,1,$2,'test-space')",
        [id, id === img ? key : encrypt("different-key")],
      );
    }
    await db.query(
      "INSERT INTO audit_logs(id,action,target,detail) VALUES($1,'create_channel',$2,$3)",
      [randomUUID(), vid, { provider: "bailian", videoId: vid, imageId: img }],
    );
    await migrateProviderChannels();
    const list = await providerChannelList();
    assert.equal(list.length, 2);
    const group = list.find((c) => c.video_id === vid)!;
    assert.equal(group.image_id, img);
    assert.equal(list.find((c) => c.id === standalone)?.image_id, standalone);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM credential_versions WHERE credential_id=$1",
          [vid],
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM image_credential_versions WHERE credential_id=$1",
          [img],
        )
      ).length,
      1,
    );
    await migrateProviderChannels();
    assert.equal((await providerChannelList()).length, 2);
  } finally {
    await closeDb();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
