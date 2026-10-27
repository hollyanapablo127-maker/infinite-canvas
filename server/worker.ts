import { processCapabilityJobs, cleanupCapabilityFiles } from "./capabilities";
import { expireLiveCapabilities } from "./live-capabilities";
import { randomUUID } from "node:crypto";
import { db, settings } from "./db";
import { dispatchOne, pollTasks, saveResults } from "./generations";
import { dispatchImageTask, pollImageTasks, saveImageResults } from "./images";
import { cleanupAssets, processExports } from "./assets";
import { runWorkflows } from "./workflows";

import { refreshModelAdapters } from "./catalog";

export function startWorker() {
  const owner = randomUUID();
  let stopped = false,
    busy = false,
    lastCleanup = 0,
    hasLock = false;
  let recovered = false,
    capabilityBusy = false;
  const heartbeat = setInterval(async () => {
    if (!hasLock) return;
    try {
      await db.query(
        "UPDATE worker_locks SET expires_at=now()+interval '2 minutes' WHERE name='main' AND owner=$1",
        [owner],
      );
    } catch (e) {
      console.error("Worker heartbeat:", e);
    }
  }, 15000);
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const lock = await db.query(
        "INSERT INTO worker_locks(name,owner,expires_at) VALUES('main',$1,now()+interval '2 minutes') ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at WHERE worker_locks.owner=$1 OR worker_locks.expires_at<now() RETURNING owner",
        [owner],
      );
      hasLock = lock.length > 0;
      if (!hasLock) return;
      await refreshModelAdapters();
      if (!recovered) {
        await db.query(
          "UPDATE export_jobs SET status='QUEUED' WHERE status='RUNNING'",
        );
        await db.query(
          "UPDATE image_tasks SET status='SUCCEEDED',lease_until=NULL,updated_at=now() WHERE status='SAVING' AND lease_until<now() AND settlement='reserved'",
        );
        recovered = true;
      }
      await db.query(
        "UPDATE tasks SET status='UNKNOWN',error='提交期间服务中断，等待人工核实',updated_at=now() WHERE status='SUBMITTING' AND lease_until<now()",
      );
      await expireLiveCapabilities();
      if (!capabilityBusy) {
        capabilityBusy = true;
        void processCapabilityJobs()
          .catch((e) =>
            console.error(
              "Capability worker:",
              e instanceof Error ? e.message : "failed",
            ),
          )
          .finally(() => {
            capabilityBusy = false;
          });
      }
      await runWorkflows();
      await dispatchOne();
      await dispatchImageTask();
      await db.query(
        "UPDATE image_tasks SET status='UNKNOWN',error='提交期间服务中断，等待人工核实',lease_until=NULL,next_poll_at=NULL,updated_at=now() WHERE status='SUBMITTING' AND lease_until<now()",
      );
      await pollImageTasks();
      await pollTasks();
      await saveResults();
      await saveImageResults();
      await processExports();
      if (Date.now() - lastCleanup > 60000) {
        await cleanupAssets();
        await cleanupCapabilityFiles();
        await db.query("DELETE FROM sessions WHERE expires_at<now()");
        await db.query(
          "DELETE FROM email_codes WHERE expires_at<now()-interval '1 day'",
        );
        const pending = await db.query(
          "SELECT id,user_id FROM tasks WHERE status IN ('UNKNOWN','RECONCILE') AND updated_at<now()-$1::interval",
          [`${(await settings()).unknownAlertHours} hours`],
        );
        for (const t of pending)
          await db.query(
            "INSERT INTO notifications(id,user_id,title,body,resource_id,unique_key) VALUES($1,$2,'任务需要核实','请联系管理员核对任务状态，避免重复提交',$3,$4) ON CONFLICT DO NOTHING",
            [randomUUID(), t.user_id, t.id, `unknown:${t.id}`],
          );
        lastCleanup = Date.now();
      }
    } catch (e) {
      console.error("Worker:", e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 1200);
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    if (!busy)
      await db.query(
        "DELETE FROM worker_locks WHERE name='main' AND owner=$1",
        [owner],
      );
  };
}
