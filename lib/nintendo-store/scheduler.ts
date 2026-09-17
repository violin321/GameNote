import "server-only";

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasStoreSession } from "../../scripts/nintendo-store-probe/auth.mjs";
import { playDatabaseFilePath } from "../play-history/database-config";
import {
  NintendoStoreError,
  syncNintendoStore,
  type StoreServiceOptions,
  type StoreSyncResult,
} from "./service";

export const nintendoStoreSyncIntervalSeconds = 24 * 60 * 60;
const schedulerPollMilliseconds = 60_000;
const leaseMilliseconds = 15 * 60_000;
const retryDelaysSeconds = [15 * 60, 60 * 60, 6 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60];

type SchedulerRow = {
  last_success_at: string | null;
  last_attempt_at: string | null;
  next_run_at: number;
  last_error: string | null;
  failure_count: number;
  lease_owner: string | null;
  lease_until: number;
};

/** A Store-only SQLite lease prevents duplicate scheduled collection across workers. */
export class NintendoStoreScheduleStore {
  constructor(readonly file: string) {
    if (
      !isAbsolute(file) ||
      !file.endsWith(".sqlite") ||
      /(?:^|\/)(?:ns2|records)\.sqlite$/i.test(file)
    )
      throw new NintendoStoreError("store_scheduler_not_configured", 503);
  }

  private open() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    chmodSync(this.file, 0o600);
    db.exec(`PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS nintendo_store_scheduler (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        last_success_at TEXT,
        last_attempt_at TEXT,
        next_run_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO nintendo_store_scheduler(singleton) VALUES(1);`);
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
        (db.prepare("SELECT * FROM nintendo_store_scheduler WHERE singleton = 1").get() as
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
        .prepare("SELECT * FROM nintendo_store_scheduler WHERE singleton = 1")
        .get() as SchedulerRow;
      if (row.lease_owner && row.lease_until > now) {
        if (!automatic) throw new NintendoStoreError("store_sync_busy", 409);
        db.exec("COMMIT");
        return false;
      }
      if (!connectionChange && row.next_run_at > now && (automatic || row.last_error)) {
        if (!automatic) throw new NintendoStoreError("store_sync_backoff", 429);
        db.exec("COMMIT");
        return false;
      }
      db.prepare(
        `UPDATE nintendo_store_scheduler
         SET lease_owner = ?, lease_until = ?, last_attempt_at = ?
         WHERE singleton = 1`,
      ).run(owner, now + leaseMilliseconds, new Date(now).toISOString());
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
              `UPDATE nintendo_store_scheduler SET lease_until = ?
               WHERE singleton = 1 AND lease_owner = ? AND lease_until > ?`,
            )
            .run(now + leaseMilliseconds, owner, now).changes,
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

  finish(owner: string, now: number, error: string | null) {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare(
          "SELECT failure_count FROM nintendo_store_scheduler WHERE singleton = 1 AND lease_owner = ?",
        )
        .get(owner) as { failure_count: number } | undefined;
      if (!row) {
        db.exec("COMMIT");
        return false;
      }
      const failures = error ? row.failure_count + 1 : 0;
      const delay = error
        ? error === "store_reauthorization_required"
          ? nintendoStoreSyncIntervalSeconds
          : retryDelaysSeconds[Math.min(failures - 1, retryDelaysSeconds.length - 1)]
        : nintendoStoreSyncIntervalSeconds;
      db.prepare(
        `UPDATE nintendo_store_scheduler
         SET lease_owner = NULL,
             lease_until = 0,
             next_run_at = ?,
             last_error = ?,
             failure_count = ?,
             last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END
         WHERE singleton = 1 AND lease_owner = ?`,
      ).run(now + delay * 1000, error, failures, error, new Date(now).toISOString(), owner);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }

  reset() {
    const db = this.open();
    try {
      db.prepare(
        `UPDATE nintendo_store_scheduler
         SET next_run_at = 0, last_error = NULL, failure_count = 0
         WHERE singleton = 1 AND (lease_owner IS NULL OR lease_until <= ?)`,
      ).run(Date.now());
    } finally {
      db.close();
    }
  }

  releaseConnection(owner: string, resetDue: boolean) {
    const db = this.open();
    try {
      db.prepare(
        `UPDATE nintendo_store_scheduler
         SET lease_owner = NULL,
             lease_until = 0,
             next_run_at = CASE WHEN ? THEN 0 ELSE next_run_at END,
             last_error = CASE WHEN ? THEN NULL ELSE last_error END,
             failure_count = CASE WHEN ? THEN 0 ELSE failure_count END
         WHERE singleton = 1 AND lease_owner = ?`,
      ).run(Number(resetDue), Number(resetDue), Number(resetDue), owner);
    } finally {
      db.close();
    }
  }
}

export function nintendoStoreSchedulerStateFile(environment: NodeJS.ProcessEnv = process.env) {
  const file = environment.NINTENDO_STORE_SCHEDULER_STATE_FILE?.trim();
  if (file) {
    if (!isAbsolute(file)) throw new NintendoStoreError("store_scheduler_not_configured", 503);
    return file;
  }
  if (environment.NINTENDO_STORE_AUTO_SYNC_ENABLED === "1")
    throw new NintendoStoreError("store_scheduler_not_configured", 503);
  return resolve(dirname(playDatabaseFilePath(environment)), "nintendo-store-scheduler.sqlite");
}

type ScheduledSyncOptions = StoreServiceOptions & {
  automatic?: boolean;
  stateFile?: string;
  clock?: () => number;
  syncer?: (options: StoreServiceOptions) => Promise<StoreSyncResult>;
};

export async function syncNintendoStoreScheduled(
  options: ScheduledSyncOptions = {},
): Promise<StoreSyncResult | null> {
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? Date.now;
  const store = new NintendoStoreScheduleStore(
    options.stateFile ?? nintendoStoreSchedulerStateFile(environment),
  );
  if (options.automatic && !(await hasStoreSession(environment))) return null;
  const owner = randomUUID();
  if (!store.claim(owner, clock(), options.automatic ?? false)) return null;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!store.renew(owner, clock())) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await (options.syncer ?? syncNintendoStore)({
      environment,
      client: options.client,
      signal: options.signal,
      now: options.now,
    });
    if (leaseLost || !store.owns(owner, clock()))
      throw new NintendoStoreError("store_sync_lease_lost", 409);
    store.finish(owner, clock(), null);
    return result;
  } catch (error) {
    store.finish(owner, clock(), safeSchedulerErrorCode(error));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export function readNintendoStoreScheduleStatus(environment: NodeJS.ProcessEnv = process.env) {
  const row = new NintendoStoreScheduleStore(nintendoStoreSchedulerStateFile(environment)).read();
  const enabled = environment.NINTENDO_STORE_AUTO_SYNC_ENABLED === "1";
  return {
    scheduler: { enabled, intervalSeconds: nintendoStoreSyncIntervalSeconds },
    nextSyncAt: enabled && row?.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    syncing: Boolean(row?.lease_owner && row.lease_until > Date.now()),
    lastSchedulerAttemptAt: row?.last_attempt_at ?? null,
    lastSchedulerSuccessAt: row?.last_success_at ?? null,
    lastSchedulerError: row?.last_error ?? null,
  };
}

export function resetNintendoStoreSchedule(environment: NodeJS.ProcessEnv = process.env) {
  new NintendoStoreScheduleStore(nintendoStoreSchedulerStateFile(environment)).reset();
}

export async function withNintendoStoreConnectionChange<T>(
  operation: () => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const store = new NintendoStoreScheduleStore(nintendoStoreSchedulerStateFile(environment));
  const owner = randomUUID();
  store.claim(owner, Date.now(), false, true);
  let completed = false;
  try {
    const value = await operation();
    completed = true;
    return value;
  } finally {
    // A successful callback is immediately eligible; a successful disconnect
    // remains idle because automatic ticks first verify a credential exists.
    store.releaseConnection(owner, completed);
  }
}

type SchedulerHandle = { timer: ReturnType<typeof setInterval>; stop(): void };
const schedulerGlobal = globalThis as typeof globalThis & {
  __gamenoteNintendoStoreScheduler?: SchedulerHandle;
};

/** Runs without a browser tab. Opt-in only, for long-lived Node deployments. */
export function startNintendoStoreScheduler(
  environment: NodeJS.ProcessEnv = process.env,
  run: typeof syncNintendoStoreScheduled = syncNintendoStoreScheduled,
) {
  if (
    environment.NINTENDO_STORE_AUTO_SYNC_ENABLED !== "1" ||
    environment.NEXT_PHASE === "phase-production-build" ||
    environment.NEXT_RUNTIME === "edge"
  )
    return null;
  if (schedulerGlobal.__gamenoteNintendoStoreScheduler)
    return schedulerGlobal.__gamenoteNintendoStoreScheduler;
  const stateFile = nintendoStoreSchedulerStateFile(environment);
  new NintendoStoreScheduleStore(stateFile).initialize();
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await run({ automatic: true, environment, stateFile });
    } catch {
      /* Only a fixed error code is persisted; the authenticated status surface may show it. */
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, schedulerPollMilliseconds);
  timer.unref();
  const handle: SchedulerHandle = {
    timer,
    stop() {
      clearInterval(timer);
      if (schedulerGlobal.__gamenoteNintendoStoreScheduler === handle)
        delete schedulerGlobal.__gamenoteNintendoStoreScheduler;
    },
  };
  schedulerGlobal.__gamenoteNintendoStoreScheduler = handle;
  void tick();
  return handle;
}

function safeSchedulerErrorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^store_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(code)
    ? code
    : "store_sync_failed";
}
