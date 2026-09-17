import "server-only";

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { playDatabaseFilePath } from "@/lib/play-history/database-config";
import { importMoonSnapshot } from "./import";
import { MoonSidecarClient, MoonSidecarError, safeMoonErrorCode } from "./sidecar-client";
import type { MoonImportResult, MoonSnapshot } from "./types";

export const moonSyncIntervalSeconds = 6 * 60 * 60;
const retrySeconds = 5 * 60;
const leaseMs = 15 * 60_000;

type SchedulerRow = {
  last_success_at: string | null;
  last_attempt_at: string | null;
  next_run_at: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: number;
};

/** A separate, local SQLite lease serializes manual and scheduled work across workers. */
export class MoonScheduleStore {
  constructor(readonly file: string) {
    if (
      !isAbsolute(file) ||
      !file.endsWith(".sqlite") ||
      /(?:^|\/)(?:ns2|records)\.sqlite$/i.test(file)
    )
      throw new MoonSidecarError(503, "scheduler_not_configured");
  }

  private open() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    chmodSync(this.file, 0o600);
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS moon_scheduler (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_success_at TEXT, last_attempt_at TEXT,
        next_run_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO moon_scheduler(singleton) VALUES(1);`);
    return db;
  }

  initialize() {
    this.open().close();
  }

  read(): SchedulerRow | null {
    if (!existsSync(this.file)) return null;
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return (
        (db.prepare("SELECT * FROM moon_scheduler WHERE singleton = 1").get() as
          | SchedulerRow
          | undefined) ?? null
      );
    } finally {
      db.close();
    }
  }

  claim(owner: string, now: number, automatic: boolean, connectionChange = false) {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare("SELECT * FROM moon_scheduler WHERE singleton = 1")
        .get() as SchedulerRow;
      if (row.lease_owner && row.lease_until > now) {
        if (!automatic) throw new MoonSidecarError(409, "moon_busy");
        db.exec("COMMIT");
        return false;
      }
      if (!connectionChange && row.next_run_at > now && (automatic || row.last_error)) {
        if (!automatic)
          throw new MoonSidecarError(
            429,
            "moon_sync_backoff",
            Math.ceil((row.next_run_at - now) / 1000),
          );
        db.exec("COMMIT");
        return false;
      }
      db.prepare(
        "UPDATE moon_scheduler SET lease_owner = ?, lease_until = ?, last_attempt_at = ? WHERE singleton = 1",
      ).run(owner, now + leaseMs, new Date(now).toISOString());
      db.exec("COMMIT");
      return true;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  renew(owner: string, now: number) {
    const db = this.open();
    try {
      return (
        Number(
          db
            .prepare(
              "UPDATE moon_scheduler SET lease_until = ? WHERE singleton = 1 AND lease_owner = ? AND lease_until > ?",
            )
            .run(now + leaseMs, owner, now).changes,
        ) === 1
      );
    } finally {
      db.close();
    }
  }

  owns(owner: string, now: number) {
    const row = this.read();
    return row?.lease_owner === owner && row.lease_until > now;
  }

  finish(owner: string, now: number, error: string | null, retryAfter = retrySeconds) {
    const db = this.open();
    try {
      db.prepare(
        `UPDATE moon_scheduler SET lease_owner = NULL, lease_until = 0,
        next_run_at = ?, last_error = ?, last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END
        WHERE singleton = 1 AND lease_owner = ?`,
      ).run(
        now + (error ? retryAfter : moonSyncIntervalSeconds) * 1000,
        error,
        error,
        new Date(now).toISOString(),
        owner,
      );
    } finally {
      db.close();
    }
  }

  reset() {
    const db = this.open();
    try {
      // A successful login makes the next automatic tick eligible immediately.
      db.prepare(
        "UPDATE moon_scheduler SET next_run_at = 0, last_error = NULL WHERE singleton = 1 AND (lease_owner IS NULL OR lease_until <= ?)",
      ).run(Date.now());
    } finally {
      db.close();
    }
  }

  releaseConnection(owner: string, resetDue: boolean) {
    const db = this.open();
    try {
      db.prepare(
        `UPDATE moon_scheduler SET lease_owner = NULL, lease_until = 0,
        next_run_at = CASE WHEN ? THEN 0 ELSE next_run_at END,
        last_error = CASE WHEN ? THEN NULL ELSE last_error END
        WHERE singleton = 1 AND lease_owner = ?`,
      ).run(Number(resetDue), Number(resetDue), owner);
    } finally {
      db.close();
    }
  }
}

export function moonSchedulerStateFile(environment: NodeJS.ProcessEnv = process.env) {
  const file = environment.MOON_SCHEDULER_STATE_FILE?.trim();
  if (file) {
    if (!isAbsolute(file)) throw new MoonSidecarError(503, "scheduler_not_configured");
    return file;
  }
  // Enabled scheduling needs an explicit persistent location; manual sync still
  // gets a shared lease next to the explicitly selected application database.
  if (environment.MOON_AUTO_SYNC_ENABLED === "1")
    throw new MoonSidecarError(503, "scheduler_not_configured");
  return resolve(dirname(playDatabaseFilePath(environment)), "moon-scheduler.sqlite");
}

type MoonSyncClient = Pick<MoonSidecarClient, "status" | "sync" | "snapshot">;
export async function syncMoonAndImport(
  options: {
    automatic?: boolean;
    client?: MoonSyncClient;
    stateFile?: string;
    importer?: (snapshot: MoonSnapshot) => Promise<MoonImportResult>;
    now?: () => number;
  } = {},
): Promise<MoonImportResult | null> {
  const client = options.client ?? (await MoonSidecarClient.configured());
  const now = options.now ?? Date.now;
  const store = new MoonScheduleStore(options.stateFile ?? moonSchedulerStateFile());
  const owner = randomUUID();
  if (!store.claim(owner, now(), options.automatic ?? false)) return null;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!store.renew(owner, now())) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }, 30_000);
  heartbeat.unref();
  try {
    const status = await client.status();
    if (status.scheduler.enabled) throw new MoonSidecarError(409, "scheduler_conflict");
    if (!status.linked) throw new MoonSidecarError(409, "moon_unlinked");
    await client.sync();
    // Never let a raw sync response bypass the normalized snapshot boundary.
    const snapshot = await client.snapshot();
    if (leaseLost || !store.owns(owner, now())) throw new MoonSidecarError(409, "moon_lease_lost");
    const result = await (options.importer ?? importMoonSnapshot)(snapshot);
    store.finish(owner, now(), null);
    return result;
  } catch (error) {
    const code =
      error instanceof MoonSidecarError ? safeMoonErrorCode(error.code) : "moon_import_failed";
    const retryAfter =
      error instanceof MoonSidecarError && error.retryAfter
        ? Math.min(moonSyncIntervalSeconds, Math.max(retrySeconds, error.retryAfter))
        : retrySeconds;
    store.finish(owner, now(), code, retryAfter);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export function readMoonScheduleStatus(environment: NodeJS.ProcessEnv = process.env) {
  const row = new MoonScheduleStore(moonSchedulerStateFile(environment)).read();
  const enabled = environment.MOON_AUTO_SYNC_ENABLED === "1";
  return {
    scheduler: { enabled, intervalSeconds: moonSyncIntervalSeconds },
    nextSyncAt: enabled && row?.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    syncing: Boolean(row?.lease_owner && row.lease_until > Date.now()),
    lastError: row?.last_error ?? null,
  };
}

export function resetMoonSchedule() {
  new MoonScheduleStore(moonSchedulerStateFile()).reset();
}

export async function withMoonConnectionChange<T>(operation: () => Promise<T>) {
  const store = new MoonScheduleStore(moonSchedulerStateFile());
  const owner = randomUUID();
  store.claim(owner, Date.now(), false, true);
  let completed = false;
  try {
    const value = await operation();
    completed = true;
    return value;
  } finally {
    store.releaseConnection(owner, completed);
  }
}

type SchedulerHandle = { timer: ReturnType<typeof setInterval>; stop(): void };
const schedulerGlobal = globalThis as typeof globalThis & {
  __gamenoteMoonScheduler?: SchedulerHandle;
};

/** Runs without a browser tab. Opt-in only, long-lived Node deployments only. */
export function startMoonScheduler(environment: NodeJS.ProcessEnv = process.env) {
  if (
    environment.MOON_AUTO_SYNC_ENABLED !== "1" ||
    environment.NEXT_PHASE === "phase-production-build" ||
    environment.NEXT_RUNTIME === "edge"
  )
    return null;
  if (schedulerGlobal.__gamenoteMoonScheduler) return schedulerGlobal.__gamenoteMoonScheduler;
  const stateFile = moonSchedulerStateFile(environment);
  // Validate persistence before advertising a running scheduler at startup.
  new MoonScheduleStore(stateFile).initialize();
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await syncMoonAndImport({ automatic: true, stateFile });
    } catch {
      /* Redacted failure state is persisted and shown in authenticated status. */
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref();
  const handle: SchedulerHandle = {
    timer,
    stop() {
      clearInterval(timer);
      if (schedulerGlobal.__gamenoteMoonScheduler === handle)
        delete schedulerGlobal.__gamenoteMoonScheduler;
    },
  };
  schedulerGlobal.__gamenoteMoonScheduler = handle;
  // Do not block server readiness on an upstream request.
  void tick();
  return handle;
}
