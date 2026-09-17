import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessIdentity, getJwtSecret } = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  getJwtSecret: vi.fn(() => "fixture-consent-subject-secret"),
}));
vi.mock("../lib/auth/access", () => ({ getAccessIdentity, getJwtSecret }));

import { POST as authorize } from "../app/api/nintendo-connector/authorize/route";
import { POST as callback } from "../app/api/nintendo-connector/callback/route";
import { POST as disconnect } from "../app/api/nintendo-connector/disconnect/route";
import {
  DELETE as revokeConsent,
  GET as consent,
  POST as grantConsent,
} from "../app/api/nintendo-connector/consent/route";
import { GET as status } from "../app/api/nintendo-connector/status/route";
import { POST as sync } from "../app/api/nintendo-connector/sync/route";
import { nintendoErrorResponse } from "../lib/nintendo/api";
import { NintendoSidecarError } from "../lib/nintendo/sidecar-client";

function post(path: string, origin?: string, body = "{}") {
  return new NextRequest(`https://games.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body,
  });
}
function get(path: string) {
  return new NextRequest(`https://games.example${path}`);
}

describe("Nintendo route security boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NINTENDO_SIDECAR_API_KEY;
  });

  it.each([
    ["status", status, () => get("/api/nintendo-connector/status")],
    ["consent challenge", consent, () => get("/api/nintendo-connector/consent")],
    ["authorize", authorize, "/api/nintendo-connector/authorize"],
    ["callback", callback, "/api/nintendo-connector/callback"],
    ["consent grant", grantConsent, "/api/nintendo-connector/consent"],
    ["consent revoke", revokeConsent, "/api/nintendo-connector/consent"],
    ["sync", sync, "/api/nintendo-connector/sync"],
    ["disconnect", disconnect, "/api/nintendo-connector/disconnect"],
  ])(
    "returns 401 before touching the connector for anonymous %s",
    async (_name, handler, target) => {
      getAccessIdentity.mockResolvedValue(null);
      const request =
        typeof target === "function" ? target() : post(target, "https://games.example");
      const response = await handler(request);
      expect(response!.status).toBe(401);
      expect(await response!.json()).toEqual({ error: "unauthorized" });
      expect(response!.headers.get("cache-control")).toBe("no-store");
    },
  );

  it.each([
    ["authorize", authorize, "/api/nintendo-connector/authorize"],
    ["callback", callback, "/api/nintendo-connector/callback"],
    ["consent grant", grantConsent, "/api/nintendo-connector/consent"],
    ["consent revoke", revokeConsent, "/api/nintendo-connector/consent"],
    ["sync", sync, "/api/nintendo-connector/sync"],
    ["disconnect", disconnect, "/api/nintendo-connector/disconnect"],
  ])("returns 403 for authenticated cross-origin %s", async (_name, handler, path) => {
    getAccessIdentity.mockResolvedValue({ id: "owner", username: "admin", sessionVersion: 1 });
    const response = await handler(post(path, "https://evil.example"));
    expect(response!.status).toBe(403);
    expect(response!.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an authenticated cross-origin callback with 403", async () => {
    getAccessIdentity.mockResolvedValue({ id: "owner", username: "admin", sessionVersion: 1 });
    const response = await callback(
      post(
        "/api/nintendo-connector/callback?session_token_code=must-not-read",
        "https://evil.example",
        JSON.stringify({ callbackUrl: "sensitive-callback" }),
      ),
    );
    expect(response!.status).toBe(403);
    expect(JSON.stringify(await response!.json())).not.toContain("sensitive-callback");
  });

  it("accepts callback material only in a one-field bounded POST body", async () => {
    getAccessIdentity.mockResolvedValue({ id: "owner", username: "admin", sessionVersion: 1 });
    const response = await callback(
      post(
        "/api/nintendo-connector/callback?callbackUrl=query-forbidden",
        "https://games.example",
        JSON.stringify({ other: "not-a-callback" }),
      ),
    );
    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({ error: "callback_query_forbidden" });
  });

  it("never logs callback material on validation failures", async () => {
    getAccessIdentity.mockResolvedValue({ id: "owner", username: "admin", sessionVersion: 1 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await callback(
      post(
        "/api/nintendo-connector/callback",
        "https://games.example",
        JSON.stringify({ callbackUrl: "sensitive-callback", extra: "forbidden" }),
      ),
    );
    expect(response!.status).toBe(400);
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("maps sidecar errors to redacted structured responses", async () => {
    const response = nintendoErrorResponse(
      new NintendoSidecarError(429, "upstream_rate_limited", 120),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await response.json()).toEqual({ error: "upstream_rate_limited" });
  });

  it.each([
    "provider_consent_missing",
    "provider_consent_legacy",
    "provider_consent_stale",
    "provider_consent_revoked",
  ])("preserves the exact 409 consent code %s", async (code) => {
    const response = nintendoErrorResponse(new NintendoSidecarError(409, code));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: code });
  });

  it("limits repeated administrator operations before opening the sidecar", async () => {
    getAccessIdentity.mockResolvedValue({ id: "rate-owner", username: "admin", sessionVersion: 1 });
    let response: Response | undefined;
    for (let count = 0; count < 31; count += 1)
      response = await authorize(
        post("/api/nintendo-connector/authorize", "https://games.example"),
      );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBeTruthy();
    expect(await response?.json()).toEqual({ error: "connector_rate_limited" });
  });
});
