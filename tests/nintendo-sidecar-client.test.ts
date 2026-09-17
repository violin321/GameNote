import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOfficialNintendoAuthorizeUrl,
  NintendoSidecarClient,
  NintendoSidecarError,
  readApiKey,
} from "../lib/nintendo/sidecar-client";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Nintendo Unix sidecar client", () => {
  it("uses only the Unix socket and never exposes its API key in response data", async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, "sidecar.sock");
    const apiKey = randomBytes(32).toString("base64url");
    const requests: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          linked: false,
          provider: {
            mode: "disabled",
            enabled: false,
            recipient: null,
            receipt: { status: "not_required", version: null, recipient: null },
          },
          sync: {
            inFlight: false,
            lastSuccessAt: null,
            nextSyncAt: null,
            hasSnapshot: false,
            lastError: null,
          },
          readOnly: true,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await new NintendoSidecarClient({ socketPath, apiKey }).status();
      expect(result.readOnly).toBe(true);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(requests).toEqual([{ url: "/v1/status", authorization: `Bearer ${apiKey}` }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps structured errors and preserves only a bounded Retry-After", async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, "sidecar.sock");
    const server = createServer((_request, response) => {
      response.statusCode = 429;
      response.setHeader("retry-after", "43200");
      response.end(JSON.stringify({ error: "sync_interval", message: "sensitive upstream text" }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        new NintendoSidecarClient({ socketPath, apiKey: "fixture-key" }).sync(),
      ).rejects.toEqual(
        expect.objectContaining({ status: 429, code: "sync_interval", retryAfter: 43200 }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("implements only the named consent, auth, snapshot, sync and disconnect operations", async () => {
    const directory = await temporaryDirectory();
    const socketPath = join(directory, "sidecar.sock");
    const calls: string[] = [];
    const authorizeUrl =
      "https://accounts.nintendo.com/connect/1.0.0/authorize?client_id=71b963c1b7b6d119&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&state=x";
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/auth/authorize")
        response.end(
          JSON.stringify({ authorizationUrl: authorizeUrl, expiresAt: Date.now() + 1_000 }),
        );
      else if (["/v1/auth/callback", "/v1/link"].includes(request.url || "")) {
        response.statusCode = 204;
        response.end();
      } else if (request.url === "/v1/provider/consent/challenge")
        response.end(
          JSON.stringify({
            required: false,
            schema: null,
            version: null,
            recipient: null,
            riskNotice: "disabled",
            riskNoticeHash: null,
          }),
        );
      else if (request.url === "/v1/provider/consent")
        response.end(JSON.stringify({ status: "valid", version: 2, recipient: "fixture" }));
      else
        response.end(
          JSON.stringify({
            schema: "gamenote.nintendo.readonly.v1",
            capturedAt: "2026-08-24T15:00:00.000Z",
            source: { provider: "Nintendo Switch Online", coralVersion: "3.4.0", readOnly: true },
            presence: [],
          }),
        );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const client = new NintendoSidecarClient({ socketPath, apiKey: "fixture-key" });
      await client.consentChallenge();
      await client.grantConsent({
        riskNoticeHash: "sha256:fixture",
        userSubject: "user:fixture",
        adminSubject: "admin:fixture",
      });
      await client.revokeConsent();
      await client.authorize();
      await client.callback("npf71b963c1b7b6d119://auth#sensitive");
      await client.sync();
      await client.snapshot();
      await client.disconnect();
      expect(calls).toEqual([
        "GET /v1/provider/consent/challenge",
        "POST /v1/provider/consent",
        "DELETE /v1/provider/consent",
        "POST /v1/auth/authorize",
        "POST /v1/auth/callback",
        "POST /v1/sync",
        "GET /v1/snapshot",
        "DELETE /v1/link",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads an API key only from a server env value or absolute secret file", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "api-key");
    await writeFile(file, "from-file\n", { mode: 0o600 });
    await expect(
      readApiKey({ NODE_ENV: "test", NINTENDO_SIDECAR_API_KEY_FILE: file }),
    ).resolves.toBe("from-file");
    await expect(
      readApiKey({ NODE_ENV: "test", NINTENDO_SIDECAR_API_KEY: "from-env" }),
    ).resolves.toBe("from-env");
    await expect(
      readApiKey({ NODE_ENV: "test", NINTENDO_SIDECAR_API_KEY_FILE: "relative" }),
    ).rejects.toThrow("absolute");
    expect(await readFile(file, "utf8")).toBe("from-file\n");
  });
});

describe("official Nintendo authorize URL allowlist", () => {
  const official =
    "https://accounts.nintendo.com/connect/1.0.0/authorize?client_id=71b963c1b7b6d119&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&state=x";
  it("accepts only the exact accounts.nintendo.com origin, path, client and redirect", () => {
    expect(() => assertOfficialNintendoAuthorizeUrl(official)).not.toThrow();
    for (const value of [
      official.replace("https://accounts.nintendo.com", "https://accounts.nintendo.com.evil.test"),
      official.replace("/connect/1.0.0/authorize", "/other"),
      official.replace("71b963c1b7b6d119", "wrong-client"),
      official.replace("npf71b963c1b7b6d119%3A%2F%2Fauth", "https%3A%2F%2Fevil.test"),
      "not a url",
    ])
      expect(() => assertOfficialNintendoAuthorizeUrl(value)).toThrow(NintendoSidecarError);
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "gamenote-sidecar-client-"));
  directories.push(directory);
  return directory;
}
