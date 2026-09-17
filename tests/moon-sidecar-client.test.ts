import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOfficialMoonAuthorizeUrl,
  MoonSidecarClient,
  readMoonApiKey,
} from "../lib/moon/sidecar-client";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const official =
  "https://accounts.nintendo.com/connect/1.0.0/authorize?client_id=54789befb391a838&redirect_uri=npf54789befb391a838%3A%2F%2Fauth&state=fixture";
const status = {
  configured: true,
  linked: false,
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
async function directory() {
  const value = await mkdtemp(join(tmpdir(), "moon-client-"));
  directories.push(value);
  return value;
}
async function unixServer(
  listener: RequestListener,
  operation: (client: MoonSidecarClient) => Promise<void>,
  timeoutMs = 10_000,
) {
  const socketPath = join(await directory(), "sidecar.sock");
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await operation(new MoonSidecarClient({ socketPath, apiKey: "fixture-api-key", timeoutMs }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Moon Unix-socket client", () => {
  it("uses only named Unix endpoints and redacts unexpected status fields", async () => {
    const calls: string[] = [];
    await unixServer(
      (request, response) => {
        calls.push(`${request.method} ${request.url}`);
        expect(request.headers.authorization).toBe("Bearer fixture-api-key");
        if (request.url === "/v1/status")
          response.end(JSON.stringify({ ...status, session_token: "private" }));
        else if (request.url === "/v1/auth/authorize")
          response.end(
            JSON.stringify({
              authorizationUrl: official,
              expiresAt: Date.now() + 60_000,
              credential: "private",
            }),
          );
        else if (["/v1/auth/callback", "/v1/link"].includes(request.url || "")) {
          response.statusCode = 204;
          response.end();
        } else response.end(JSON.stringify({ schema: "gamenote.moon.daily.v1" }));
      },
      async (client) => {
        expect(await client.status()).toEqual(status);
        expect(JSON.stringify(await client.authorize())).not.toContain("private");
        await client.callback("npf54789befb391a838://auth#fixture");
        await client.sync();
        await client.snapshot();
        await client.disconnect();
      },
    );
    expect(calls).toEqual([
      "GET /v1/status",
      "POST /v1/auth/authorize",
      "POST /v1/auth/callback",
      "POST /v1/sync",
      "GET /v1/snapshot",
      "DELETE /v1/link",
    ]);
  });

  it("preserves only known public errors and bounded retry-after", async () => {
    for (const [upstreamCode, expected] of [
      ["moon_rate_limited", "moon_rate_limited"],
      ["secret_token_123456789", "sidecar_error"],
    ]) {
      await unixServer(
        (_request, response) => {
          response.statusCode = 429;
          response.setHeader("retry-after", "999999");
          response.end(JSON.stringify({ error: upstreamCode, message: "sensitive upstream body" }));
        },
        async (client) => {
          await expect(client.status()).rejects.toMatchObject({
            status: 429,
            code: expected,
            retryAfter: 86400,
          });
        },
      );
    }
  });

  it("rejects oversized, invalid JSON and malformed status responses", async () => {
    for (const data of [
      "{not-json",
      JSON.stringify({ ...status, syncing: "maybe" }),
      "x".repeat(8 * 1024 * 1024 + 1),
    ]) {
      await unixServer(
        (_request, response) => response.end(data),
        async (client) => {
          await expect(client.status()).rejects.toMatchObject({ status: 502 });
        },
      );
    }
  });

  it("enforces an absolute response deadline", async () => {
    await unixServer(
      (_request, response) => {
        response.writeHead(200);
        response.write("{");
        const keepAlive = setInterval(() => response.write(" "), 5);
        response.on("close", () => clearInterval(keepAlive));
      },
      async (client) => {
        await expect(client.status()).rejects.toMatchObject({ code: "sidecar_unavailable" });
      },
      30,
    );
  });

  it("reads only the independent absolute server-side key file", async () => {
    const file = join(await directory(), "api-key");
    const key = randomBytes(32).toString("base64url");
    await writeFile(file, `${key}\n`, { mode: 0o600 });
    await expect(
      readMoonApiKey({ NODE_ENV: "test", MOON_SIDECAR_API_KEY_FILE: file }),
    ).resolves.toBe(key);
    await expect(
      readMoonApiKey({ NODE_ENV: "test", MOON_SIDECAR_API_KEY_FILE: "relative" }),
    ).rejects.toThrow("absolute");
    await expect(MoonSidecarClient.configured({ NODE_ENV: "test" })).rejects.toMatchObject({
      code: "sidecar_not_configured",
    });
  });
});

describe("Moon official authorization URL allowlist", () => {
  it("accepts the Parental Controls client but rejects NSO, redirects, duplicate state and foreign origins", () => {
    expect(() => assertOfficialMoonAuthorizeUrl(official)).not.toThrow();
    for (const value of [
      official.replace("54789befb391a838", "71b963c1b7b6d119"),
      official.replace("accounts.nintendo.com", "accounts.nintendo.com.evil.test"),
      official.replace("npf54789befb391a838%3A%2F%2Fauth", "https%3A%2F%2Fevil.test"),
      official.replace("/connect/1.0.0/authorize", "/other"),
      `${official}&state=duplicate`,
      `${official}#secret`,
      "invalid-url",
    ])
      expect(() => assertOfficialMoonAuthorizeUrl(value)).toThrow("invalid_authorize_url");
  });
});
