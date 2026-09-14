import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MoonScheduleStore,
  moonSchedulerStateFile,
  moonSyncIntervalSeconds,
  readMoonScheduleStatus,
  startMoonScheduler,
  syncMoonAndImport,
} from "../lib/moon/scheduler";
import { MoonSidecarClient, MoonSidecarError } from "../lib/moon/sidecar-client";
import type { MoonSnapshot, MoonStatus } from "../lib/moon/types";

const directories: string[] = [];
const stoppers: Array<() => void> = [];
afterEach(async () => {
  stoppers.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const snapshot: MoonSnapshot = {
  schema: "gamenote.moon.daily.v1",
  fetchedAt: "2026-09-12T00:00:00.000Z",
  accountScope: "fixture",
  devices: [],
  dailyReports: [],
};
const status: MoonStatus = {
  configured: true,
  linked: true,
  pendingAuthorization: false,
  lastSuccessAt: null,
  lastError: null,
  nextSyncAt: null,
  syncing: false,
  deviceCount: 0,
  reportCount: 0,
  latestReportDate: null,
  scheduler: { enabled: false, intervalSeconds: 21600 },
};
function fixtureClient() {
  return {
    status: vi.fn(async () => status),
    sync: vi.fn(async () => snapshot),
    snapshot: vi.fn(async () => snapshot),
  };
}
function fixtureImporter() {
  return vi.fn(async () => ({
    importedReports: 1,
    importedGames: 1,
    replayed: false,
    latestDate: "2026-09-12",
  }));
}
async function stateFile() {
  const directory = await mkdtemp(join(tmpdir(), "gamenote-moon-scheduler-"));
  directories.push(directory);
  return join(directory, "scheduler.sqlite");
}

describe("Moon server-side sync and import scheduler", () => {
  it("imports only the snapshot endpoint and persists the successful six-hour due time", async () => {
    const file = await stateFile();
    const client = fixtureClient();
    client.sync.mockResolvedValue({ ...snapshot, accountScope: "raw-sync-not-imported" });
    const importer = fixtureImporter();
    const now = Date.parse(snapshot.fetchedAt);
    await syncMoonAndImport({ client, importer, stateFile: file, now: () => now });
    expect(importer).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(client.sync.mock.invocationCallOrder[0]).toBeLessThan(
      client.snapshot.mock.invocationCallOrder[0],
    );
    const state = new MoonScheduleStore(file).read();
    expect(state).toMatchObject({
      next_run_at: now + moonSyncIntervalSeconds * 1000,
      last_error: null,
      lease_owner: null,
    });
    await expect(
      syncMoonAndImport({
        client,
        importer,
        stateFile: file,
        automatic: true,
        now: () => now + 1000,
      }),
    ).resolves.toBeNull();
    expect(client.sync).toHaveBeenCalledTimes(1);
    // A user can explicitly refresh a successful sync without a six-hour lockout.
    await syncMoonAndImport({ client, importer, stateFile: file, now: () => now + 1000 });
    expect(client.sync).toHaveBeenCalledTimes(2);
  });

  it("excludes competing workers and manual requests using a persistent lease", async () => {
    const file = await stateFile();
    const now = Date.now();
    const one = new MoonScheduleStore(file);
    const two = new MoonScheduleStore(file);
    expect(one.claim("worker-one", now, false)).toBe(true);
    expect(two.claim("worker-two", now, true)).toBe(false);
    expect(() => two.claim("manual", now, false)).toThrow(
      expect.objectContaining({ code: "moon_busy" }),
    );
    expect(two.renew("worker-two", now)).toBe(false);
    expect(one.renew("worker-one", now + 30_000)).toBe(true);
    one.finish("worker-one", now + 60_000, null);
    expect(two.claim("worker-two", now + 60_001, true)).toBe(false);
  });

  it("recovers an abandoned lease after a crash and fences its old owner", async () => {
    const file = await stateFile();
    const one = new MoonScheduleStore(file);
    const two = new MoonScheduleStore(file);
    const now = Date.now();
    one.claim("dead-worker", now, false);
    expect(two.claim("new-worker", now + 16 * 60_000, true)).toBe(true);
    expect(one.owns("dead-worker", now + 16 * 60_000)).toBe(false);
    one.finish("dead-worker", now + 16 * 60_000, null);
    expect(two.read()?.lease_owner).toBe("new-worker");
  });

  it("failed collection does not import or consume a six-hour success interval", async () => {
    const file = await stateFile();
    const client = fixtureClient();
    const importer = fixtureImporter();
    client.sync.mockRejectedValue(new MoonSidecarError(502, "moon_upstream_unavailable"));
    const now = Date.now();
    await expect(
      syncMoonAndImport({ client, importer, stateFile: file, now: () => now }),
    ).rejects.toThrow("moon_upstream_unavailable");
    expect(importer).not.toHaveBeenCalled();
    expect(new MoonScheduleStore(file).read()).toMatchObject({
      next_run_at: now + 5 * 60_000,
      last_success_at: null,
      last_error: "moon_upstream_unavailable",
      lease_owner: null,
    });
    await expect(
      syncMoonAndImport({ client, importer, stateFile: file, now: () => now + 1000 }),
    ).rejects.toMatchObject({
      code: "moon_sync_backoff",
      status: 429,
      retryAfter: 299,
    });
  });

  it("records import failures separately and retries the collector through the same normalized flow", async () => {
    const file = await stateFile();
    const client = fixtureClient();
    const importer = fixtureImporter();
    importer.mockRejectedValueOnce(new Error("fixture database path and payload"));
    const now = Date.now();
    await expect(
      syncMoonAndImport({ client, importer, stateFile: file, now: () => now }),
    ).rejects.toThrow();
    const row = new MoonScheduleStore(file).read();
    expect(row?.last_error).toBe("moon_import_failed");
    expect(JSON.stringify(row)).not.toContain("fixture database");
    await syncMoonAndImport({ client, importer, stateFile: file, now: () => now + 5 * 60_000 });
    expect(importer).toHaveBeenCalledTimes(2);
    expect(new MoonScheduleStore(file).read()?.last_error).toBeNull();
  });

  it("rejects a competing runtime-owned scheduler before fetching any data", async () => {
    const client = fixtureClient();
    client.status.mockResolvedValue({
      ...status,
      scheduler: { enabled: true, intervalSeconds: 21600 },
    });
    await expect(
      syncMoonAndImport({ client, importer: fixtureImporter(), stateFile: await stateFile() }),
    ).rejects.toMatchObject({ code: "scheduler_conflict" });
    expect(client.sync).not.toHaveBeenCalled();
  });

  it("requires an explicit absolute persistence file only when enabled and refuses app database targets", () => {
    expect(() => moonSchedulerStateFile({ NODE_ENV: "test", MOON_AUTO_SYNC_ENABLED: "1" })).toThrow(
      "scheduler_not_configured",
    );
    expect(() =>
      moonSchedulerStateFile({ NODE_ENV: "test", MOON_SCHEDULER_STATE_FILE: "relative.sqlite" }),
    ).toThrow();
    expect(() => new MoonScheduleStore("/tmp/ns2.sqlite")).toThrow();
    expect(
      moonSchedulerStateFile({ NODE_ENV: "test", APP_DATABASE_FILE: "/tmp/fixture/ns2.sqlite" }),
    ).toBe("/tmp/fixture/moon-scheduler.sqlite");
  });

  it("does not run during builds, at the edge, or without explicit enablement", () => {
    expect(startMoonScheduler({ NODE_ENV: "test", NEXT_RUNTIME: "nodejs" })).toBeNull();
    expect(
      startMoonScheduler({
        NODE_ENV: "test",
        MOON_AUTO_SYNC_ENABLED: "1",
        NEXT_PHASE: "phase-production-build",
      }),
    ).toBeNull();
    expect(
      startMoonScheduler({ NODE_ENV: "test", MOON_AUTO_SYNC_ENABLED: "1", NEXT_RUNTIME: "edge" }),
    ).toBeNull();
  });

  it("starts one server timer across HMR and preserves the due time across restarts", async () => {
    const file = await stateFile();
    const store = new MoonScheduleStore(file);
    const now = Date.now();
    store.claim("previous-process", now, false);
    store.finish("previous-process", now, null);
    const client = fixtureClient();
    vi.spyOn(MoonSidecarClient, "configured").mockResolvedValue(
      client as unknown as MoonSidecarClient,
    );
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      MOON_AUTO_SYNC_ENABLED: "1",
      MOON_SCHEDULER_STATE_FILE: file,
      NEXT_RUNTIME: "nodejs",
    };
    const first = startMoonScheduler(environment)!;
    stoppers.push(first.stop);
    expect(startMoonScheduler(environment)).toBe(first);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(client.sync).not.toHaveBeenCalled();
    expect(store.read()?.next_run_at).toBe(now + moonSyncIntervalSeconds * 1000);
    expect(readMoonScheduleStatus(environment).scheduler.enabled).toBe(true);
    expect(
      readMoonScheduleStatus({ ...environment, MOON_AUTO_SYNC_ENABLED: "0" }).nextSyncAt,
    ).toBeNull();
  });
});
