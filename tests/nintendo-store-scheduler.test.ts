import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  NintendoStoreScheduleStore,
  nintendoStoreSchedulerStateFile,
  nintendoStoreSyncIntervalSeconds,
  readNintendoStoreScheduleStatus,
  startNintendoStoreScheduler,
  syncNintendoStoreScheduled,
  withNintendoStoreConnectionChange,
} from "../lib/nintendo-store/scheduler";
import { NintendoStoreError, type StoreSyncResult } from "../lib/nintendo-store/service";

const directories: string[] = [];
const stoppers: Array<() => void> = [];

afterEach(async () => {
  stoppers.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureState() {
  const directory = await mkdtemp(join(tmpdir(), "gamenote-store-scheduler-"));
  directories.push(directory);
  return {
    directory,
    file: join(directory, "scheduler.sqlite"),
    environment: {
      NODE_ENV: "test",
      APP_DATABASE_FILE: join(directory, "ns2.sqlite"),
      NINTENDO_STORE_PROBE_DIR: join(directory, "credentials"),
    } satisfies NodeJS.ProcessEnv,
  };
}

const result: StoreSyncResult = {
  count: 2,
  skipped: 0,
  titleCount: 2,
  fetchedAt: "2026-09-14T04:00:00.000Z",
};

describe("Nintendo Store low-frequency scheduler", () => {
  it("persists the successful 24-hour due time across store instances", async () => {
    const { file } = await fixtureState();
    const first = new NintendoStoreScheduleStore(file);
    const second = new NintendoStoreScheduleStore(file);
    const now = Date.now();

    expect(first.claim("worker-one", now, true)).toBe(true);
    expect(first.finish("worker-one", now, null)).toBe(true);
    expect(second.read()).toMatchObject({
      next_run_at: now + nintendoStoreSyncIntervalSeconds * 1000,
      failure_count: 0,
      last_error: null,
      lease_owner: null,
    });
    expect(second.claim("worker-two", now + 60_000, true)).toBe(false);
    expect(second.claim("worker-two", now + nintendoStoreSyncIntervalSeconds * 1000, true)).toBe(
      true,
    );
  });

  it("recovers expired leases without allowing a stale worker to finish", async () => {
    const { file } = await fixtureState();
    const first = new NintendoStoreScheduleStore(file);
    const second = new NintendoStoreScheduleStore(file);
    const now = Date.now();

    expect(first.claim("dead-worker", now, false)).toBe(true);
    expect(second.claim("new-worker", now + 16 * 60_000, true)).toBe(true);
    expect(first.owns("dead-worker", now + 16 * 60_000)).toBe(false);
    expect(first.finish("dead-worker", now + 16 * 60_000, null)).toBe(false);
    expect(second.read()?.lease_owner).toBe("new-worker");
  });

  it("persists a redacted exponential backoff without consuming a success interval", async () => {
    const { file, environment } = await fixtureState();
    let now = Date.now();
    const syncer = vi.fn(async () => {
      throw new NintendoStoreError("store_http_503", 503);
    });

    await expect(
      syncNintendoStoreScheduled({
        environment,
        stateFile: file,
        clock: () => now,
        syncer,
      }),
    ).rejects.toMatchObject({ code: "store_http_503" });
    expect(new NintendoStoreScheduleStore(file).read()).toMatchObject({
      next_run_at: now + 15 * 60_000,
      last_success_at: null,
      last_error: "store_http_503",
      failure_count: 1,
      lease_owner: null,
    });

    await expect(
      syncNintendoStoreScheduled({
        environment,
        stateFile: file,
        clock: () => now + 1000,
        syncer,
      }),
    ).rejects.toMatchObject({ code: "store_sync_backoff", status: 429 });
    expect(syncer).toHaveBeenCalledTimes(1);

    now += 15 * 60_000;
    await expect(
      syncNintendoStoreScheduled({
        environment,
        stateFile: file,
        clock: () => now,
        syncer: async () => {
          throw new Error("private token and upstream response");
        },
      }),
    ).rejects.toThrow("private token");
    const row = new NintendoStoreScheduleStore(file).read();
    expect(row).toMatchObject({
      next_run_at: now + 60 * 60_000,
      last_error: "store_sync_failed",
      failure_count: 2,
    });
    expect(JSON.stringify(row)).not.toContain("private token");
  });

  it("backs off permanent credential rejection until reauthorization resets it", async () => {
    const { file, environment } = await fixtureState();
    const now = Date.now();
    await expect(
      syncNintendoStoreScheduled({
        environment,
        stateFile: file,
        clock: () => now,
        syncer: async () => {
          throw new NintendoStoreError("store_reauthorization_required", 400);
        },
      }),
    ).rejects.toMatchObject({ code: "store_reauthorization_required" });
    expect(new NintendoStoreScheduleStore(file).read()).toMatchObject({
      next_run_at: now + nintendoStoreSyncIntervalSeconds * 1000,
      last_error: "store_reauthorization_required",
      failure_count: 1,
    });

    new NintendoStoreScheduleStore(file).reset();
    expect(new NintendoStoreScheduleStore(file).read()).toMatchObject({
      next_run_at: 0,
      last_error: null,
      failure_count: 0,
    });
  });

  it("serializes connection changes and makes successful reauthorization immediately due", async () => {
    const { file, environment } = await fixtureState();
    const store = new NintendoStoreScheduleStore(file);
    const now = Date.now();
    store.claim("failed-sync", now, false);
    store.finish("failed-sync", now, "store_reauthorization_required");

    await expect(
      withNintendoStoreConnectionChange(async () => "connected", {
        ...environment,
        NINTENDO_STORE_SCHEDULER_STATE_FILE: file,
      }),
    ).resolves.toBe("connected");
    expect(store.read()).toMatchObject({
      next_run_at: 0,
      last_error: null,
      failure_count: 0,
      lease_owner: null,
    });
  });

  it("skips disconnected accounts without network calls or failure churn", async () => {
    const { file, environment } = await fixtureState();
    const syncer = vi.fn(async () => result);

    await expect(
      syncNintendoStoreScheduled({ automatic: true, environment, stateFile: file, syncer }),
    ).resolves.toBeNull();
    expect(syncer).not.toHaveBeenCalled();
    expect(new NintendoStoreScheduleStore(file).read()).toBeNull();
  });

  it("requires explicit persistent state only when automatic sync is enabled", async () => {
    const { directory, environment } = await fixtureState();
    expect(
      nintendoStoreSchedulerStateFile({ ...environment, NINTENDO_STORE_AUTO_SYNC_ENABLED: "0" }),
    ).toBe(join(directory, "nintendo-store-scheduler.sqlite"));
    expect(() =>
      nintendoStoreSchedulerStateFile({
        ...environment,
        NINTENDO_STORE_SCHEDULER_STATE_FILE: "relative.sqlite",
      }),
    ).toThrow("store_scheduler_not_configured");
    expect(() => new NintendoStoreScheduleStore(join(directory, "ns2.sqlite"))).toThrow(
      "store_scheduler_not_configured",
    );
    expect(() =>
      nintendoStoreSchedulerStateFile({
        ...environment,
        NINTENDO_STORE_AUTO_SYNC_ENABLED: "1",
      }),
    ).toThrow("store_scheduler_not_configured");
  });

  it("starts once per server across HMR and exposes persisted schedule status", async () => {
    const { file, environment } = await fixtureState();
    const run = vi.fn(async () => result);
    const enabledEnvironment = {
      ...environment,
      NEXT_RUNTIME: "nodejs",
      NINTENDO_STORE_AUTO_SYNC_ENABLED: "1",
      NINTENDO_STORE_SCHEDULER_STATE_FILE: file,
    };

    const first = startNintendoStoreScheduler(enabledEnvironment, run)!;
    stoppers.push(first.stop);
    expect(startNintendoStoreScheduler(enabledEnvironment, run)).toBe(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledExactlyOnceWith({
      automatic: true,
      environment: enabledEnvironment,
      stateFile: file,
    });
    expect(readNintendoStoreScheduleStatus(enabledEnvironment)).toMatchObject({
      scheduler: { enabled: true, intervalSeconds: 86_400 },
      nextSyncAt: null,
      syncing: false,
    });
  });

  it("does not start during builds, at the edge, or without explicit enablement", () => {
    expect(startNintendoStoreScheduler({ NODE_ENV: "test", NEXT_RUNTIME: "nodejs" })).toBeNull();
    expect(
      startNintendoStoreScheduler({
        NODE_ENV: "test",
        NINTENDO_STORE_AUTO_SYNC_ENABLED: "1",
        NEXT_PHASE: "phase-production-build",
      }),
    ).toBeNull();
    expect(
      startNintendoStoreScheduler({
        NODE_ENV: "test",
        NINTENDO_STORE_AUTO_SYNC_ENABLED: "1",
        NEXT_RUNTIME: "edge",
      }),
    ).toBeNull();
  });
});
