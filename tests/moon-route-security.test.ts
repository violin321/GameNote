import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAccessIdentity,
  readMoonImportStatus,
  syncMoonAndImport,
  withMoonConnectionChange,
  readMoonScheduleStatus,
} = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  readMoonImportStatus: vi.fn(),
  syncMoonAndImport: vi.fn(),
  withMoonConnectionChange: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  readMoonScheduleStatus: vi.fn(),
}));
vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/moon/import", () => ({
  readMoonImportStatus,
  MoonSnapshotError: class extends Error {},
}));
vi.mock("../lib/moon/scheduler", () => ({
  syncMoonAndImport,
  withMoonConnectionChange,
  readMoonScheduleStatus,
  moonSyncIntervalSeconds: 21600,
}));

import { POST as authorize } from "../app/api/moon-connector/authorize/route";
import { POST as callback } from "../app/api/moon-connector/callback/route";
import { POST as disconnect } from "../app/api/moon-connector/disconnect/route";
import { POST as sync } from "../app/api/moon-connector/sync/route";
import { GET as status } from "../app/api/moon-connector/status/route";
import { MoonSidecarClient, MoonSidecarError } from "../lib/moon/sidecar-client";

function post(path: string, origin = "https://games.example", body = "{}") {
  return new NextRequest(`https://games.example/api/moon-connector/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body,
  });
}
const writes = [
  ["authorize", authorize],
  ["callback", callback],
  ["disconnect", disconnect],
  ["sync", sync],
] as const;
let ownerId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  getAccessIdentity.mockResolvedValue({
    id: `admin-${++ownerId}`,
    username: "admin",
    sessionVersion: 1,
  });
  readMoonImportStatus.mockResolvedValue({
    reportCount: 0,
    latestDate: null,
    lastImportedAt: null,
  });
  readMoonScheduleStatus.mockReturnValue({
    scheduler: { enabled: false, intervalSeconds: 21600 },
    nextSyncAt: null,
    syncing: false,
    lastError: null,
  });
});

describe("Moon administrator API boundary", () => {
  it("accepts bodyless browser controls but rejects nonempty untyped streams", async () => {
    vi.spyOn(MoonSidecarClient, "configured").mockResolvedValue({
      authorize: async () => ({ authorizationUrl: "fixture", expiresAt: 1 }),
    } as unknown as MoonSidecarClient);
    const emptyStream = new NextRequest("https://games.example/api/moon-connector/authorize", {
      method: "POST",
      headers: { origin: "https://games.example" },
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      duplex: "half",
    });
    expect((await authorize(emptyStream)).status).toBe(201);
    const untypedStream = new NextRequest("https://games.example/api/moon-connector/authorize", {
      method: "POST",
      headers: { origin: "https://games.example" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      duplex: "half",
    });
    expect((await authorize(untypedStream)).status).toBe(415);
  });
  it.each(writes)("requires a registered administrator before %s", async (path, handler) => {
    getAccessIdentity.mockResolvedValue(null);
    const client = vi.spyOn(MoonSidecarClient, "configured");
    const response = await handler(post(path));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(client).not.toHaveBeenCalled();
    expect(syncMoonAndImport).not.toHaveBeenCalled();
  });

  it("requires an administrator to view connection and import metadata", async () => {
    getAccessIdentity.mockResolvedValue(null);
    const response = await status(
      new NextRequest("https://games.example/api/moon-connector/status"),
    );
    expect(response.status).toBe(401);
    expect(readMoonImportStatus).not.toHaveBeenCalled();
  });

  it.each(writes)("rejects cross-origin and missing-Origin browser %s", async (path, handler) => {
    for (const origin of ["https://evil.example", ""]) {
      const response = await handler(post(path, origin));
      expect(response.status).toBe(403);
    }
    expect(syncMoonAndImport).not.toHaveBeenCalled();
  });

  it("accepts callback secrets only in a single-field bounded POST body, never query strings", async () => {
    const client = vi.spyOn(MoonSidecarClient, "configured");
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    for (const [path, body, expected] of [
      ["callback?callbackUrl=private", '{"callbackUrl":"private"}', 400],
      ["callback", '{"callbackUrl":"private","extra":true}', 400],
      ["callback", JSON.stringify({ callbackUrl: "x".repeat(4097) }), 400],
      ["callback", JSON.stringify({ callbackUrl: "x".repeat(9000) }), 413],
    ] as const) {
      const response = await callback(post(path, "https://games.example", body));
      expect(response.status).toBe(expected);
      expect(JSON.stringify(await response.json())).not.toContain("private");
    }
    expect(client).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["authorize", authorize],
    ["sync", sync],
    ["disconnect", disconnect],
  ] as const)("bounds unexpected %s request bodies", async (path, handler) => {
    const response = await handler(
      post(path, "https://games.example", JSON.stringify({ private: "x".repeat(9000) })),
    );
    expect(response.status).toBe(413);
  });

  it("forwards a callback without echoing it and wakes the actual scheduler", async () => {
    const handler = vi.fn(async () => undefined);
    vi.spyOn(MoonSidecarClient, "configured").mockResolvedValue({
      callback: handler,
    } as unknown as MoonSidecarClient);
    const callbackUrl = "npf54789befb391a838://auth#session_token_code=fixture&state=fixture";
    const response = await callback(
      post("callback", "https://games.example", JSON.stringify({ callbackUrl })),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(handler).toHaveBeenCalledExactlyOnceWith(callbackUrl);
    expect(withMoonConnectionChange).toHaveBeenCalledOnce();
  });

  it("exposes import freshness separately from collector freshness and real scheduler state", async () => {
    vi.spyOn(MoonSidecarClient, "configured").mockResolvedValue({
      status: async () => ({
        configured: true,
        linked: true,
        reportCount: 18,
        latestReportDate: "2026-09-12",
        lastSuccessAt: "2026-09-12T00:00:00.000Z",
        syncing: false,
        scheduler: { enabled: false, intervalSeconds: 21600 },
        lastError: null,
      }),
    } as unknown as MoonSidecarClient);
    readMoonImportStatus.mockResolvedValue({
      reportCount: 6,
      latestDate: "2026-08-31",
      lastImportedAt: "2026-08-31T00:00:00.000Z",
    });
    readMoonScheduleStatus.mockReturnValue({
      scheduler: { enabled: true, intervalSeconds: 21600 },
      nextSyncAt: "2026-09-12T06:00:00.000Z",
      syncing: false,
      lastError: "moon_import_failed",
    });
    const response = await status(
      new NextRequest("https://games.example/api/moon-connector/status"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reportCount: 18,
      importState: { reportCount: 6, latestDate: "2026-08-31" },
      lastError: "moon_import_failed",
      scheduler: { enabled: true },
      nextSyncAt: "2026-09-12T06:00:00.000Z",
    });
  });

  it("returns a usable configured:false status when no sidecar is installed", async () => {
    vi.spyOn(MoonSidecarClient, "configured").mockRejectedValue(
      new MoonSidecarError(503, "sidecar_not_configured"),
    );
    const response = await status(
      new NextRequest("https://games.example/api/moon-connector/status"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      linked: false,
      scheduler: { enabled: false },
    });
  });

  it("rate-limits administrator writes before starting additional work", async () => {
    syncMoonAndImport.mockResolvedValue({
      importedReports: 1,
      importedGames: 1,
      replayed: false,
      latestDate: "2026-09-12",
    });
    for (let i = 0; i < 10; i++) expect((await sync(post("sync"))).status).toBe(200);
    const response = await sync(post("sync"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(syncMoonAndImport).toHaveBeenCalledTimes(10);
  });
});
