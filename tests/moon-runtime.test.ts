import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMoonSnapshot } from "../services/moon-sidecar/normalize.mjs";
import {
  assertAllowedRequest,
  createNintendoClient,
  MOON_CLIENT_ID,
  MOON_PROFILE,
} from "../services/moon-sidecar/nintendo.mjs";
import {
  createAuthorization,
  createMoonRuntime,
  validateCallback,
} from "../services/moon-sidecar/runtime.mjs";
import {
  createEncryptedStore,
  initializeDirectory,
  loadInstallation,
  MoonError,
} from "../services/moon-sidecar/security.mjs";
import { createMoonServer, listenUnix } from "../services/moon-sidecar/server.mjs";

const directories: string[] = [];
const runtimes: Array<{ stop: () => void }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const now = Date.parse("2026-09-12T04:40:00Z");
const titleId = "0100F2C0115B6000";
function report() {
  return {
    deviceId: "device-fixture",
    date: "2026-09-12",
    result: "CALCULATING",
    playingTime: 1800,
    timeZoneUtcOffsetSeconds: 28800,
    updatedAt: now / 1000,
    playedApps: [
      {
        applicationId: titleId,
        title: "Fixture Game",
        imageUri: { medium: "https://cdn.nintendo.net/game.png" },
        shopUri: "https://www.nintendo.com/store/products/fixture/",
      },
    ],
    devicePlayers: [
      {
        playerId: "private-player",
        nickname: "Private nickname",
        playingTime: 1200,
        playedApps: [{ applicationId: titleId, playingTime: 1200 }],
      },
    ],
    anonymousPlayer: {
      playingTime: 300,
      playedApps: [{ applicationId: titleId, playingTime: 300 }],
    },
  };
}
function raw() {
  return {
    accountId: "private-account",
    devices: [{ deviceId: "device-fixture", reports: [report()] }],
  };
}
function token(audience = MOON_CLIENT_ID) {
  return `e30.${Buffer.from(JSON.stringify({ aud: audience, iss: "https://accounts.nintendo.com", exp: now / 1000 + 3600 })).toString("base64url")}.fixture-signature`;
}
function callback(authorizationUrl: string, code = "fixture-code") {
  const state = new URL(authorizationUrl).searchParams.get("state");
  return `npf${MOON_CLIENT_ID}://auth#state=${state}&session_token_code=${code}`;
}
async function testRuntime(
  options: {
    schedulerEnabled?: boolean;
    collect?: () => Promise<ReturnType<typeof raw>>;
    exchange?: () => Promise<string>;
  } = {},
) {
  let saved: unknown = null;
  let current = now;
  const store = {
    async load() {
      return structuredClone(saved);
    },
    async save(value: unknown) {
      saved = structuredClone(value);
    },
  };
  const client = {
    exchangeCode: vi.fn(options.exchange || (async () => token())),
    account: vi.fn(async () => ({
      accountId: "private-account",
      accessToken: "private-access-token",
    })),
    collect: vi.fn(options.collect || (async () => raw())),
  };
  const runtime = await createMoonRuntime({
    store,
    installationKey: Buffer.alloc(32, 1),
    client,
    now: () => current,
    schedulerEnabled: options.schedulerEnabled || false,
  });
  runtimes.push(runtime);
  return {
    runtime,
    store,
    client,
    advance(ms: number) {
      current += ms;
    },
  };
}
async function linkedRuntime(options: Parameters<typeof testRuntime>[0] = {}) {
  const result = await testRuntime(options);
  const auth = await result.runtime.authorize();
  await result.runtime.callback(callback(auth.authorizationUrl));
  return result;
}

describe("Moon runtime normalization", () => {
  it("preserves official dates, seconds and result without exposing account/device/player identifiers", () => {
    const snapshot = normalizeMoonSnapshot(raw(), Buffer.alloc(32, 1), new Date(now).toISOString());
    expect(snapshot.dailyReports[0]).toMatchObject({
      date: "2026-09-12",
      timeZoneOffsetSeconds: 28800,
      result: "CALCULATING",
      totalSeconds: 1800,
      updatedAt: new Date(now).toISOString(),
    });
    expect(snapshot.dailyReports[0].games[0]).toMatchObject({
      externalId: "moon:0100f2c0115b6000",
      titleId: "0100f2c0115b6000",
      totalSeconds: 1500,
    });
    const json = JSON.stringify(snapshot);
    for (const secret of [
      "private-account",
      "device-fixture",
      "private-player",
      "Private nickname",
    ])
      expect(json).not.toContain(secret);
    expect(normalizeMoonSnapshot(raw(), Buffer.alloc(32, 2)).accountScope).not.toBe(
      snapshot.accountScope,
    );
    expect(normalizeMoonSnapshot(raw(), Buffer.alloc(32, 1)).devices).toEqual(snapshot.devices);
  });

  it("rejects malformed dates and detached title durations instead of silently dropping daily data", () => {
    const invalidDate = raw();
    invalidDate.devices[0].reports[0].date = "2026-02-30";
    expect(() => normalizeMoonSnapshot(invalidDate, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
    const missingTitle = raw();
    missingTitle.devices[0].reports[0].playedApps = [];
    expect(() => normalizeMoonSnapshot(missingTitle, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
    const duplicate = raw();
    duplicate.devices[0].reports.push(report());
    expect(() => normalizeMoonSnapshot(duplicate, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
    const duplicatePlayer = raw();
    const daily = duplicatePlayer.devices[0].reports[0];
    daily.devicePlayers.push(structuredClone(daily.devicePlayers[0]));
    expect(() => normalizeMoonSnapshot(duplicatePlayer, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
  });

  it("keeps zero-playing-time days and unknown results explicit without inventing per-game duration", () => {
    const input = raw();
    const daily = input.devices[0].reports[0];
    daily.playingTime = 0;
    daily.result = "FUTURE_UPSTREAM_RESULT";
    daily.devicePlayers = [];
    daily.anonymousPlayer.playedApps = [];
    daily.playedApps = [];
    daily.updatedAt = now;
    expect(normalizeMoonSnapshot(input, Buffer.alloc(32)).dailyReports[0]).toMatchObject({
      totalSeconds: 0,
      result: "UNKNOWN",
      updatedAt: new Date(now).toISOString(),
      games: [],
    });
    Object.assign(daily, { playingTime: null });
    expect(() => normalizeMoonSnapshot(input, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
  });

  it("rejects a known played title with missing duration instead of treating unknown time as zero", () => {
    const input = raw();
    input.devices[0].reports[0].devicePlayers = [];
    input.devices[0].reports[0].anonymousPlayer.playedApps = [];
    expect(() => normalizeMoonSnapshot(input, Buffer.alloc(32))).toThrow(
      "moon_invalid_upstream_data",
    );
  });

  it("bounds display titles and excludes untrusted image/shop destinations", () => {
    const input = raw();
    const game = input.devices[0].reports[0].playedApps[0];
    game.title = "x".repeat(300);
    game.shopUri = "https://nintendo.com.evil.test/fixture";
    for (const value of [
      "http://cdn.nintendo.net/fixture",
      "https://127.0.0.1/fixture",
      "https://cdn.nintendo.net.evil.test/fixture",
      "https://user:pass@cdn.nintendo.net/fixture",
      "javascript:alert(1)",
    ]) {
      game.imageUri.medium = value;
      const normalized = normalizeMoonSnapshot(input, Buffer.alloc(32)).dailyReports[0].games[0];
      expect(normalized).toMatchObject({ title: "x".repeat(200), officialUrl: "", imageUrl: "" });
    }
    game.imageUri.medium = "https://cdn.nintendo.net/fixture";
    expect(normalizeMoonSnapshot(input, Buffer.alloc(32)).dailyReports[0].games[0].imageUrl).toBe(
      game.imageUri.medium,
    );
  });
});

describe("Moon PKCE authorization", () => {
  it("uses the official Moon audience and a real S256 PKCE challenge", () => {
    const pending = createAuthorization(now);
    const url = new URL(pending.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.nintendo.com/connect/1.0.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(MOON_CLIENT_ID);
    expect(url.searchParams.get("session_token_code_challenge")).toBe(
      createHash("sha256").update(pending.verifier).digest("base64url"),
    );
    expect(url.searchParams.get("session_token_code_challenge_method")).toBe("S256");
    expect(validateCallback(callback(pending.authorizationUrl), pending, now)).toBe("fixture-code");
  });

  it("rejects callback host, state, expiration, duplicate params, mixed hash/query and wrong client", () => {
    const pending = createAuthorization(now);
    const good = callback(pending.authorizationUrl);
    const bad = [
      good.replace("://auth", "://auth.evil"),
      good.replace(MOON_CLIENT_ID, "71b963c1b7b6d119"),
      good.replace("state=", "state=bad"),
      `${good}&state=x`,
      good.replace("#", "?x=y#"),
      good.replace("://auth", "://auth/"),
      `${good}&evil=1`,
    ];
    for (const input of bad) expect(() => validateCallback(input, pending, now)).toThrow();
    expect(() => validateCallback(good, pending, pending.expiresAt)).toThrow(
      "moon_authorization_expired",
    );
  });

  it("retains an active authorization and consumes a callback before exchanging even on failure", async () => {
    const { runtime, client } = await testRuntime({
      exchange: async () => {
        throw new MoonError("moon_upstream_unavailable");
      },
    });
    const auth = await runtime.authorize();
    expect(await runtime.authorize()).toEqual(auth);
    await expect(runtime.callback(callback(auth.authorizationUrl))).rejects.toThrow(
      "moon_upstream_unavailable",
    );
    await expect(runtime.callback(callback(auth.authorizationUrl))).rejects.toThrow(
      "moon_authorization_expired",
    );
    expect(client.exchangeCode).toHaveBeenCalledTimes(1);
    expect(runtime.status()).toMatchObject({
      linked: false,
      pendingAuthorization: false,
      lastError: "moon_upstream_unavailable",
    });
  });

  it("rejects a Coral-audience token and never persists it as Moon credentials", async () => {
    const { runtime, client } = await testRuntime({
      exchange: async () => token("71b963c1b7b6d119"),
    });
    const auth = await runtime.authorize();
    await expect(runtime.callback(callback(auth.authorizationUrl))).rejects.toThrow(
      "moon_invalid_upstream_data",
    );
    expect(client.account).not.toHaveBeenCalled();
    expect(runtime.status().linked).toBe(false);
  });
});

describe("Moon fixed network contract", () => {
  it("forbids redirects/arbitrary destinations/mutations/query parameters at the request boundary", () => {
    for (const [url, method] of [
      ["http://api-lp1.pctl.srv.nintendo.net/moon/v1/users/a/devices", "GET"],
      ["https://evil.test/moon/v1/users/a/devices", "GET"],
      ["https://api-lp1.pctl.srv.nintendo.net/moon/v1/users/a/devices?url=x", "GET"],
      ["https://api-lp1.pctl.srv.nintendo.net/moon/v1/users/a/devices", "POST"],
      ["https://api-lp1.pctl.srv.nintendo.net/moon/v1/devices/a/parental_control_setting", "GET"],
      ["https://api-lp1.pctl.srv.nintendo.net/moon/v1/users/a/../devices", "GET"],
      ["https://user:pass@accounts.nintendo.com/connect/1.0.0/api/token", "POST"],
    ])
      expect(() => assertAllowedRequest(url, method)).toThrow("moon_endpoint_forbidden");
  });

  it("collects directly from Nintendo using pinned profile and only retries an idempotent read", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: string;
    }> = [];
    let dailyAttempts = 0;
    const client = createNintendoClient({
      wait: async () => {},
      transport: async (input: (typeof requests)[number]) => {
        requests.push(input);
        if (input.url.endsWith("/api/token")) return { access_token: "private-access-token" };
        if (input.url.endsWith("/users/me")) return { id: "private-account" };
        if (input.url.endsWith("/devices")) return { items: [{ deviceId: "device-fixture" }] };
        if (++dailyAttempts === 1) throw new MoonError("moon_upstream_unavailable");
        return { items: [report()] };
      },
    });
    expect(await client.collect("private-session-token", "private-account")).toEqual(raw());
    expect(requests.filter((item) => item.method === "POST")).toHaveLength(1);
    expect(dailyAttempts).toBe(2);
    expect(requests.at(-1)?.headers).toMatchObject({
      "X-Moon-App-Display-Version": MOON_PROFILE.version,
      "X-Moon-App-Internal-Version": "660",
    });
    expect(requests.map((item) => item.url).join(" ")).not.toMatch(/fancy|remote-config/);
  });
});

describe("Moon persistent state and synchronization", () => {
  it("allows immediate recovery after failed manual sync and never invents a schedule when disabled", async () => {
    let failing = true;
    const { runtime } = await linkedRuntime({
      collect: async () => {
        if (failing) throw new MoonError("moon_upstream_unavailable");
        return raw();
      },
    });
    await expect(runtime.sync()).rejects.toThrow("moon_upstream_unavailable");
    expect(runtime.status()).toMatchObject({
      nextSyncAt: null,
      syncing: false,
      lastSuccessAt: null,
      scheduler: { enabled: false },
    });
    failing = false;
    await runtime.sync();
    expect(runtime.status()).toMatchObject({
      nextSyncAt: null,
      lastError: null,
      reportCount: 1,
      latestReportDate: "2026-09-12",
    });
    await runtime.disconnect();
    expect(runtime.status()).toMatchObject({ linked: false, reportCount: 0 });
    expect(() => runtime.snapshot()).toThrow("moon_snapshot_missing");
  });

  it("serializes disconnect/authorization with a running sync and sanitizes unexpected failures", async () => {
    let release: () => void = () => {};
    const blocking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runtime } = await linkedRuntime({
      collect: async () => {
        await blocking;
        throw new Error("credential secret and private endpoint");
      },
    });
    const sync = runtime.sync();
    expect(runtime.status().syncing).toBe(true);
    await expect(runtime.disconnect()).rejects.toThrow("moon_busy");
    release();
    await expect(sync).rejects.toThrow("moon_internal_error");
    expect(JSON.stringify(runtime.status())).not.toContain("credential secret");
  });

  it("executes the optional schedule, persists a short failed retry, and schedules success six hours out", async () => {
    vi.useFakeTimers();
    let failing = true;
    const { runtime, client, advance } = await linkedRuntime({
      schedulerEnabled: true,
      collect: async () => {
        if (failing) throw new MoonError("moon_upstream_unavailable");
        return raw();
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.collect).toHaveBeenCalledTimes(1);
    expect(runtime.status().nextSyncAt).toBe(new Date(now + 300_000).toISOString());
    failing = false;
    advance(300_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.collect).toHaveBeenCalledTimes(2);
    expect(runtime.status().nextSyncAt).toBe(new Date(now + 300_000 + 21600_000).toISOString());
  });

  it("encrypts pending PKCE and credentials with independent 0600 keys and fails closed on key reuse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moon-runtime-"));
    directories.push(directory);
    await initializeDirectory(directory);
    const installation = await loadInstallation(directory);
    await initializeDirectory(directory);
    const initializedAgain = await loadInstallation(directory);
    expect(initializedAgain.apiKey).toBe(installation.apiKey);
    expect(initializedAgain.masterKey).toEqual(installation.masterKey);
    expect(initializedAgain.installationKey).toEqual(installation.installationKey);
    const store = createEncryptedStore(installation);
    const state = {
      version: 1,
      secret: "private-session-token",
      pending: { verifier: "private-PKCE-verifier" },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect((await stat(join(directory, "state", "moon-state.enc"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "state", "moon-state.enc"), "utf8")).not.toMatch(
      /private-session|private-PKCE/,
    );
    const apiKey = await readFile(join(directory, "secrets", "api-key"));
    await writeFile(join(directory, "secrets", "master-key"), apiKey, { mode: 0o600 });
    await expect(loadInstallation(directory)).rejects.toThrow("private_key_reuse");
  });

  it("restores valid pending authorization then snapshot and credentials across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moon-runtime-"));
    directories.push(directory);
    await initializeDirectory(directory);
    const installation = await loadInstallation(directory);
    const client = {
      async exchangeCode() {
        return token();
      },
      async account() {
        return { accountId: "private-account", accessToken: "private-access-token" };
      },
      async collect() {
        return raw();
      },
    };
    const create = async () => {
      const runtime = await createMoonRuntime({
        store: createEncryptedStore(installation),
        installationKey: installation.installationKey,
        client,
        now: () => now,
      });
      runtimes.push(runtime);
      return runtime;
    };
    const first = await create();
    const authorization = await first.authorize();
    first.stop();
    const second = await create();
    expect(second.status().pendingAuthorization).toBe(true);
    expect(await second.authorize()).toEqual(authorization);
    await second.callback(callback(authorization.authorizationUrl));
    const snapshot = await second.sync();
    second.stop();
    const third = await create();
    expect(third.status()).toMatchObject({
      linked: true,
      pendingAuthorization: false,
      reportCount: 1,
      nextSyncAt: null,
    });
    expect(third.snapshot()).toEqual(snapshot);
    expect(await readFile(join(directory, "state", "moon-state.enc"), "utf8")).not.toContain(
      "Fixture Game",
    );
    await expect(third.callback(callback(authorization.authorizationUrl))).rejects.toThrow(
      "moon_authorization_expired",
    );
  });

  it("exposes only authenticated Unix routes, with safe errors and no wildcard request proxy", async () => {
    // /tmp is intentionally short enough for macOS sockaddr_un.
    const directory = await mkdtemp("/tmp/moon-runtime-");
    directories.push(directory);
    const { runtime } = await testRuntime();
    const apiKey = randomBytes(32).toString("base64url");
    const socketPath = join(directory, "sidecar.sock");
    const server = createMoonServer(runtime, apiKey);
    await listenUnix(server, socketPath);
    const call = (path: string, authenticated = true) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          { socketPath, path, headers: authenticated ? { authorization: `Bearer ${apiKey}` } : {} },
          (res) => {
            let body = "";
            res.on("data", (part) => {
              body += part;
            });
            res.on("end", () => resolve({ status: res.statusCode || 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await call("/healthz", false)).toEqual({ status: 200, body: '{"status":"ok"}' });
      expect((await call("/v1/status", false)).status).toBe(401);
      const status = await call("/v1/status");
      expect(status.status).toBe(200);
      expect(status.body).not.toContain(apiKey);
      expect((await call("/v1/snapshot")).status).toBe(404);
      expect((await call("/v1/status?url=https://evil.test")).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
