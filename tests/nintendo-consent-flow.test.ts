import { createHmac } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessIdentity, getJwtSecret } = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  getJwtSecret: vi.fn(() => "fixture-consent-subject-secret"),
}));
vi.mock("../lib/auth/access", () => ({ getAccessIdentity, getJwtSecret }));

import { POST as authorize } from "../app/api/nintendo-connector/authorize/route";
import { POST as callback } from "../app/api/nintendo-connector/callback/route";
import {
  GET as consentChallenge,
  POST as grantConsent,
} from "../app/api/nintendo-connector/consent/route";
import { GET as connectorStatus } from "../app/api/nintendo-connector/status/route";

const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

beforeEach(() => {
  getAccessIdentity.mockResolvedValue({
    id: "flow-owner",
    username: "admin",
    sessionVersion: 1,
  });
});

afterEach(async () => {
  delete process.env.NINTENDO_SIDECAR_SOCKET_PATH;
  delete process.env.NINTENDO_SIDECAR_API_KEY;
  delete process.env.APP_DATABASE_FILE;
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Nintendo Fancy consent flow", () => {
  it("blocks missing consent, records an explicit receipt, then permits authorize", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gamenote-consent-flow-"));
    directories.push(directory);
    const socketPath = join(directory, "sidecar.sock");
    const apiKey = "fixture-sidecar-key";
    const recipient = "https://nxapi-znca-api.fancy.org.uk";
    const riskNotice =
      "Third party fancy.org.uk receives short-lived Nintendo authentication material.";
    const riskNoticeHash = `sha256:${"a".repeat(64)}`;
    const authorizeUrl =
      "https://accounts.nintendo.com/connect/1.0.0/authorize?client_id=71b963c1b7b6d119&redirect_uri=npf71b963c1b7b6d119%3A%2F%2Fauth&state=fixture";
    let consentValid = false;
    let receivedConsent: Record<string, unknown> | null = null;

    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url === "/v1/status") {
        response.end(
          JSON.stringify({
            linked: false,
            provider: {
              mode: "fancy",
              enabled: true,
              recipient,
              receipt: {
                status: consentValid ? "valid" : "missing",
                version: consentValid ? 2 : null,
                recipient,
              },
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
        return;
      }
      if (request.method === "GET" && request.url === "/v1/provider/consent/challenge") {
        response.end(
          JSON.stringify({
            required: true,
            schema: "gamenote.nintendo.provider-consent",
            version: 2,
            recipient,
            riskNotice,
            riskNoticeHash,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/v1/provider/consent") {
        receivedConsent = JSON.parse(await readBody(request)) as Record<string, unknown>;
        consentValid = true;
        response.statusCode = 201;
        response.end(JSON.stringify({ status: "valid", version: 2, recipient }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/auth/authorize") {
        if (!consentValid) {
          response.statusCode = 409;
          response.end(
            JSON.stringify({
              error: "provider_consent_missing",
              message: "sensitive sidecar explanation must not pass through",
            }),
          );
          return;
        }
        response.statusCode = 201;
        response.end(JSON.stringify({ authorizationUrl: authorizeUrl, expiresAt: 1_800_000_000 }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.NINTENDO_SIDECAR_SOCKET_PATH = socketPath;
    process.env.NINTENDO_SIDECAR_API_KEY = apiKey;

    const initialStatus = required(await connectorStatus(get("/api/nintendo-connector/status")));
    expect(initialStatus.status).toBe(200);
    expect((await initialStatus.json()).provider.receipt.status).toBe("missing");

    const blocked = required(await authorize(post("/api/nintendo-connector/authorize")));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "provider_consent_missing" });

    const challenge = required(await consentChallenge(get("/api/nintendo-connector/consent")));
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toMatchObject({
      required: true,
      schema: "gamenote.nintendo.provider-consent",
      version: 2,
      recipient,
      riskNotice,
      riskNoticeHash,
    });

    const unchecked = required(
      await grantConsent(
        post(
          "/api/nintendo-connector/consent",
          JSON.stringify({ riskNoticeHash, acknowledged: false }),
        ),
      ),
    );
    expect(unchecked.status).toBe(400);
    expect(await unchecked.json()).toEqual({ error: "invalid_consent" });
    expect(receivedConsent).toBeNull();

    const consent = required(
      await grantConsent(
        post(
          "/api/nintendo-connector/consent",
          JSON.stringify({ riskNoticeHash, acknowledged: true }),
        ),
      ),
    );
    expect(consent.status).toBe(201);
    expect(await consent.json()).toEqual({ status: "valid", version: 2, recipient });
    const localSubject = createHmac("sha256", "fixture-consent-subject-secret")
      .update("gamenote:nintendo-provider-consent\0", "utf8")
      .update("flow-owner", "utf8")
      .digest("base64url");
    expect(receivedConsent).toEqual({
      riskNoticeHash,
      userSubject: `user:${localSubject}`,
      adminSubject: `admin:${localSubject}`,
    });

    const validStatus = required(await connectorStatus(get("/api/nintendo-connector/status")));
    expect(validStatus.status).toBe(200);
    expect((await validStatus.json()).provider.receipt.status).toBe("valid");

    const permitted = required(await authorize(post("/api/nintendo-connector/authorize")));
    expect(permitted.status).toBe(201);
    expect(await permitted.json()).toEqual({
      authorizationUrl: authorizeUrl,
      expiresAt: 1_800_000_000,
    });
  });

  it("does not accept client-selected receipt subjects or an unchecked acknowledgment", async () => {
    process.env.NINTENDO_SIDECAR_SOCKET_PATH = "/not-reached.sock";
    process.env.NINTENDO_SIDECAR_API_KEY = "not-reached";
    for (const payload of [
      { riskNoticeHash: `sha256:${"b".repeat(64)}`, acknowledged: false },
      {
        riskNoticeHash: `sha256:${"b".repeat(64)}`,
        acknowledged: true,
        userSubject: "user:attacker-selected",
        adminSubject: "admin:attacker-selected",
      },
    ]) {
      const response = required(
        await grantConsent(post("/api/nintendo-connector/consent", JSON.stringify(payload))),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_consent" });
    }
  });

  it("forwards sensitive callback material without persisting it in the app", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gamenote-callback-ephemeral-"));
    directories.push(directory);
    const socketPath = join(directory, "sidecar.sock");
    const databaseFile = join(directory, "must-not-be-created.sqlite");
    const callbackUrl = "npf71b963c1b7b6d119://auth#session_token_code=highly-sensitive-fixture";
    let receivedCallback: unknown = null;
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/v1/auth/callback") {
        receivedCallback = JSON.parse(await readBody(request));
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    process.env.NINTENDO_SIDECAR_SOCKET_PATH = socketPath;
    process.env.NINTENDO_SIDECAR_API_KEY = "fixture-sidecar-key";
    process.env.APP_DATABASE_FILE = databaseFile;

    const response = required(
      await callback(post("/api/nintendo-connector/callback", JSON.stringify({ callbackUrl }))),
    );
    expect(response.status).toBe(204);
    expect(receivedCallback).toEqual({ callbackUrl });
    await expect(access(databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
    delete process.env.APP_DATABASE_FILE;
  });
});

function required<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

function get(path: string) {
  return new NextRequest(`https://games.example${path}`);
}

function post(path: string, body = "{}") {
  return new NextRequest(`https://games.example${path}`, {
    method: "POST",
    headers: { origin: "https://games.example", "content-type": "application/json" },
    body,
  });
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
