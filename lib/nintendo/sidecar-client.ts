import "server-only";

import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";
import type { NintendoConsentChallenge, NintendoSnapshot, NintendoStatus } from "./types";

const responseLimit = 2 * 1024 * 1024;
const officialAuthorizeOrigin = "https://accounts.nintendo.com";
const officialAuthorizePath = "/connect/1.0.0/authorize";
const officialClientId = "71b963c1b7b6d119";

export class NintendoSidecarError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null = null,
  ) {
    super(code);
    this.name = "NintendoSidecarError";
  }
}

export type NintendoSidecarClientOptions = {
  socketPath?: string;
  apiKey?: string;
  timeoutMs?: number;
};

export class NintendoSidecarClient {
  private readonly socketPath: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: NintendoSidecarClientOptions = {}) {
    this.socketPath = options.socketPath || configuredSocketPath();
    this.apiKey = options.apiKey || "";
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  static async configured(environment: NodeJS.ProcessEnv = process.env) {
    try {
      return new NintendoSidecarClient({
        socketPath: configuredSocketPath(environment),
        apiKey: await readApiKey(environment),
      });
    } catch {
      throw new NintendoSidecarError(503, "sidecar_not_configured");
    }
  }

  status() {
    return this.call<NintendoStatus>("GET", "/v1/status");
  }
  consentChallenge() {
    return this.call<NintendoConsentChallenge>("GET", "/v1/provider/consent/challenge");
  }
  grantConsent(value: { riskNoticeHash: string; userSubject: string; adminSubject: string }) {
    return this.call("POST", "/v1/provider/consent", value);
  }
  revokeConsent() {
    return this.call("DELETE", "/v1/provider/consent");
  }
  async authorize() {
    const result = await this.call<{ authorizationUrl: string; expiresAt: number }>(
      "POST",
      "/v1/auth/authorize",
    );
    if (
      !result ||
      typeof result.authorizationUrl !== "string" ||
      !Number.isSafeInteger(result.expiresAt)
    )
      throw new NintendoSidecarError(502, "invalid_authorize_response");
    assertOfficialNintendoAuthorizeUrl(result.authorizationUrl);
    return result;
  }
  callback(callbackUrl: string) {
    return this.call<void>("POST", "/v1/auth/callback", { callbackUrl });
  }
  sync() {
    // Fancy OAuth + Nintendo/Coral reads routinely take longer than the
    // low-latency control endpoints. Keep the default tight elsewhere, but do
    // not abandon a real sync while the sidecar is still completing it.
    return this.call<NintendoSnapshot>("POST", "/v1/sync", undefined, 180_000);
  }
  snapshot() {
    return this.call<NintendoSnapshot>("GET", "/v1/snapshot");
  }
  disconnect() {
    return this.call<void>("DELETE", "/v1/link");
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.apiKey) throw new NintendoSidecarError(503, "sidecar_not_configured");
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            ...(payload
              ? { "content-type": "application/json", "content-length": String(payload.length) }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) response.destroy(new Error("sidecar response too large"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            const status = response.statusCode || 502;
            const raw = Buffer.concat(chunks).toString("utf8");
            let value: unknown = undefined;
            try {
              if (raw) value = JSON.parse(raw);
            } catch {
              reject(new NintendoSidecarError(502, "invalid_sidecar_response"));
              return;
            }
            if (status >= 200 && status < 300) {
              resolve(value as T);
              return;
            }
            const code = safeErrorCode(value);
            const retryAfter = safeRetryAfter(response.headers["retry-after"]);
            reject(new NintendoSidecarError(mapStatus(status), code, retryAfter));
          });
          response.on("error", () => reject(new NintendoSidecarError(502, "sidecar_unavailable")));
        },
      );
      request.setTimeout(timeoutMs, () => request.destroy(new Error("sidecar timeout")));
      request.on("error", (error) => {
        reject(
          error instanceof NintendoSidecarError
            ? error
            : new NintendoSidecarError(503, "sidecar_unavailable"),
        );
      });
      if (payload) request.write(payload);
      request.end();
    });
  }
}

export function assertOfficialNintendoAuthorizeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NintendoSidecarError(502, "invalid_authorize_url");
  }
  if (
    url.origin !== officialAuthorizeOrigin ||
    url.pathname !== officialAuthorizePath ||
    url.username ||
    url.password ||
    url.searchParams.getAll("client_id").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("client_id") !== officialClientId ||
    url.searchParams.get("redirect_uri") !== `npf${officialClientId}://auth` ||
    !url.searchParams.get("state")
  )
    throw new NintendoSidecarError(502, "invalid_authorize_url");
}

export async function readApiKey(environment: NodeJS.ProcessEnv = process.env) {
  const file = environment.NINTENDO_SIDECAR_API_KEY_FILE?.trim();
  if (file) {
    if (!isAbsolute(file)) throw new Error("NINTENDO_SIDECAR_API_KEY_FILE must be absolute");
    const value = (await readFile(file, "utf8")).trim();
    if (!value) throw new Error("Nintendo sidecar API key file is empty");
    return value;
  }
  const value = environment.NINTENDO_SIDECAR_API_KEY?.trim();
  if (!value) throw new Error("Nintendo sidecar API key is not configured");
  return value;
}

function configuredSocketPath(environment: NodeJS.ProcessEnv = process.env) {
  const value =
    environment.NINTENDO_SIDECAR_SOCKET_PATH?.trim() || "/run/nintendo-sidecar/sidecar.sock";
  if (!isAbsolute(value)) throw new Error("NINTENDO_SIDECAR_SOCKET_PATH must be absolute");
  return value;
}
function safeErrorCode(value: unknown) {
  const code =
    value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : "sidecar_error";
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "sidecar_error";
}
function safeRetryAfter(value: string | string[] | undefined) {
  const seconds = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : null;
}
function mapStatus(status: number) {
  return [400, 401, 404, 409, 413, 429].includes(status) ? status : status >= 500 ? 502 : 502;
}
