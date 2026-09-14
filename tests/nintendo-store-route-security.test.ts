import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authorizeNintendoStore,
  callbackNintendoStore,
  disconnectNintendoStore,
  getAccessIdentity,
  readNintendoStoreScheduleStatus,
  readNintendoStoreStatus,
  syncNintendoStore,
  syncNintendoStoreScheduled,
  withNintendoStoreConnectionChange,
} = vi.hoisted(() => {
  const syncNintendoStore = vi.fn();
  return {
    authorizeNintendoStore: vi.fn(),
    callbackNintendoStore: vi.fn(),
    disconnectNintendoStore: vi.fn(),
    getAccessIdentity: vi.fn(),
    readNintendoStoreScheduleStatus: vi.fn(),
    readNintendoStoreStatus: vi.fn(),
    syncNintendoStore,
    syncNintendoStoreScheduled: vi.fn((...args: unknown[]) => syncNintendoStore(...args)),
    withNintendoStoreConnectionChange: vi.fn((operation: () => Promise<unknown>) => operation()),
  };
});

vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/nintendo-store/service", () => ({
  authorizeNintendoStore,
  callbackNintendoStore,
  disconnectNintendoStore,
  readNintendoStoreStatus,
  syncNintendoStore,
  NintendoStoreError: class NintendoStoreError extends Error {
    constructor(
      readonly code: string,
      readonly status = 502,
    ) {
      super(code);
    }
  },
}));
vi.mock("../lib/nintendo-store/scheduler", () => ({
  readNintendoStoreScheduleStatus,
  syncNintendoStoreScheduled,
  withNintendoStoreConnectionChange,
}));

import { POST as authorize } from "../app/api/nintendo-store/authorize/route";
import { POST as callback } from "../app/api/nintendo-store/callback/route";
import { POST as disconnect } from "../app/api/nintendo-store/disconnect/route";
import { GET as status } from "../app/api/nintendo-store/status/route";
import { POST as sync } from "../app/api/nintendo-store/sync/route";
import { NintendoStoreError } from "../lib/nintendo-store/service";
import { StoreAuthError } from "../services/nintendo-store/auth.mjs";

function post(path: string, options: { origin?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`https://games.example/api/nintendo-store/${path}`, {
    method: "POST",
    headers,
    body: options.body,
  });
}

const writes = [
  ["authorize", authorize],
  ["callback", callback],
  ["disconnect", disconnect],
  ["sync", sync],
] as const;

let identitySequence = 0;

beforeEach(() => {
  vi.clearAllMocks();
  getAccessIdentity.mockResolvedValue({
    id: `store-admin-${++identitySequence}`,
    username: "admin",
    sessionVersion: 1,
  });
  authorizeNintendoStore.mockResolvedValue({
    authorizationUrl: "https://accounts.nintendo.com/connect/1.0.0/authorize?fixture=1",
    expiresAt: 1_800_000_000_000,
  });
  callbackNintendoStore.mockResolvedValue({ authentication: "fixture" });
  disconnectNintendoStore.mockResolvedValue(undefined);
  readNintendoStoreStatus.mockResolvedValue({
    configured: true,
    connected: true,
    credentialStatus: "connected",
    credentialInvalid: false,
    pendingAuthorization: false,
    titleCount: 29,
    lastSyncedAt: "2026-09-14T00:00:00.000Z",
  });
  readNintendoStoreScheduleStatus.mockReturnValue({
    scheduler: { enabled: true, intervalSeconds: 86_400 },
    nextSyncAt: "2026-09-15T00:00:00.000Z",
    syncing: false,
    lastSchedulerAttemptAt: "2026-09-14T00:00:00.000Z",
    lastSchedulerSuccessAt: "2026-09-14T00:00:00.000Z",
    lastSchedulerError: null,
    reauthorizationRequired: false,
  });
  syncNintendoStore.mockResolvedValue({
    count: 29,
    skipped: 0,
    titleCount: 29,
    dailyCount: 4,
    skippedDaily: 1,
    fetchedAt: "2026-09-14T00:00:00.000Z",
    snapshotId: "internal-snapshot-id",
    authentication: "access_token",
  });
});

describe("Nintendo Store administrator API boundary", () => {
  it.each(writes)("requires a registered administrator before %s", async (path, handler) => {
    getAccessIdentity.mockResolvedValue(null);
    const response = await handler(post(path, { origin: "https://games.example" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(authorizeNintendoStore).not.toHaveBeenCalled();
    expect(callbackNintendoStore).not.toHaveBeenCalled();
    expect(disconnectNintendoStore).not.toHaveBeenCalled();
    expect(syncNintendoStore).not.toHaveBeenCalled();
  });

  it("requires a registered administrator before reading local status", async () => {
    getAccessIdentity.mockResolvedValue(null);
    const response = await status(
      new NextRequest("https://games.example/api/nintendo-store/status"),
    );
    expect(response.status).toBe(401);
    expect(readNintendoStoreStatus).not.toHaveBeenCalled();
  });

  it.each(writes)("rejects cross-origin and missing-Origin browser %s", async (path, handler) => {
    for (const origin of ["https://evil.example", undefined]) {
      const response = await handler(post(path, { origin }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect(authorizeNintendoStore).not.toHaveBeenCalled();
    expect(callbackNintendoStore).not.toHaveBeenCalled();
    expect(disconnectNintendoStore).not.toHaveBeenCalled();
    expect(syncNintendoStore).not.toHaveBeenCalled();
  });

  it("accepts callback material only in a one-field bounded JSON body", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    for (const [path, body, expected, code] of [
      [
        "callback?callbackUrl=private",
        '{"callbackUrl":"private"}',
        400,
        "callback_query_forbidden",
      ],
      ["callback", '{"callbackUrl":"private","extra":true}', 400, "invalid_callback"],
      ["callback", JSON.stringify({ callbackUrl: "x".repeat(4097) }), 400, "invalid_callback"],
      ["callback", JSON.stringify({ callbackUrl: "x".repeat(9000) }), 413, "request_too_large"],
    ] as const) {
      const response = await callback(post(path, { origin: "https://games.example", body }));
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ error: code });
    }
    expect(callbackNintendoStore).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("forwards a valid callback once without echoing service results", async () => {
    const callbackUrl = "npf5c38e31cd085304b://auth#session_token_code=fixture&state=fixture";
    const response = await callback(
      post("callback", {
        origin: "https://games.example",
        body: JSON.stringify({ callbackUrl }),
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(callbackNintendoStore).toHaveBeenCalledExactlyOnceWith(callbackUrl);
    expect(withNintendoStoreConnectionChange).toHaveBeenCalledOnce();
  });

  it.each([
    ["authorize", authorize],
    ["disconnect", disconnect],
    ["sync", sync],
  ] as const)("rejects nonempty and oversized %s control bodies", async (path, handler) => {
    const invalid = await handler(
      post(path, { origin: "https://games.example", body: '{"private":true}' }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_request" });

    const oversized = await handler(
      post(path, {
        origin: "https://games.example",
        body: JSON.stringify({ private: "x".repeat(9000) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
  });

  it("returns no-store responses for the normal status and control flow", async () => {
    const statusResponse = await status(
      new NextRequest("https://games.example/api/nintendo-store/status"),
    );
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.headers.get("cache-control")).toBe("no-store");
    expect(await statusResponse.json()).toMatchObject({ connected: true, titleCount: 29 });

    expect((await authorize(post("authorize", { origin: "https://games.example" }))).status).toBe(
      201,
    );
    const syncResponse = await sync(post("sync", { origin: "https://games.example" }));
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({
      count: 29,
      skipped: 0,
      titleCount: 29,
      dailyCount: 4,
      skippedDaily: 1,
      fetchedAt: "2026-09-14T00:00:00.000Z",
    });
    expect(syncNintendoStoreScheduled).toHaveBeenCalledOnce();
    expect((await disconnect(post("disconnect", { origin: "https://games.example" }))).status).toBe(
      204,
    );
    expect(withNintendoStoreConnectionChange).toHaveBeenCalledOnce();
  });

  it("maps known and unexpected service failures without exposing messages", async () => {
    syncNintendoStore.mockRejectedValueOnce(new NintendoStoreError("store_sync_busy", 409));
    const busy = await sync(post("sync", { origin: "https://games.example" }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: "store_sync_busy" });

    readNintendoStoreStatus.mockRejectedValueOnce(new Error("private filesystem path"));
    const unavailable = await status(
      new NextRequest("https://games.example/api/nintendo-store/status"),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "store_unavailable" });

    readNintendoStoreStatus.mockRejectedValueOnce(new StoreAuthError("not_configured", 503));
    const notConfigured = await status(
      new NextRequest("https://games.example/api/nintendo-store/status"),
    );
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toEqual({ error: "not_configured" });
  });

  it("surfaces a persisted reauthorization requirement", async () => {
    readNintendoStoreScheduleStatus.mockReturnValueOnce({
      scheduler: { enabled: true, intervalSeconds: 86_400 },
      nextSyncAt: null,
      syncing: false,
      lastSchedulerAttemptAt: "2026-09-14T00:00:00.000Z",
      lastSchedulerSuccessAt: null,
      lastSchedulerError: "store_reauthorization_required",
      reauthorizationRequired: true,
    });
    const response = await status(
      new NextRequest("https://games.example/api/nintendo-store/status"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reauthorizationRequired: true,
      lastSchedulerError: "store_reauthorization_required",
    });
  });
});
