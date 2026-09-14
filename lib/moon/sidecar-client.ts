import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute } from "node:path";
import type { MoonSnapshot, MoonStatus } from "./types";

const clientId = "54789befb391a838";
const responseLimit = 8 * 1024 * 1024;

export class MoonSidecarError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null = null,
  ) {
    super(code);
    this.name = "MoonSidecarError";
  }
}

export class MoonSidecarClient {
  private readonly socketPath: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: { socketPath: string; apiKey: string; timeoutMs?: number }) {
    if (!isAbsolute(options.socketPath)) throw new MoonSidecarError(503, "sidecar_not_configured");
    this.socketPath = options.socketPath;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  static async configured(environment: NodeJS.ProcessEnv = process.env) {
    try {
      const socketPath = environment.MOON_SIDECAR_SOCKET_PATH?.trim();
      if (!socketPath) throw new Error("missing socket");
      return new MoonSidecarClient({ socketPath, apiKey: await readMoonApiKey(environment) });
    } catch {
      throw new MoonSidecarError(503, "sidecar_not_configured");
    }
  }

  async status(): Promise<MoonStatus> {
    const value = await this.call<unknown>("GET", "/v1/status");
    if (!value || typeof value !== "object") throw invalidResponse();
    const raw = value as Record<string, unknown>;
    const scheduler = raw.scheduler as Record<string, unknown> | undefined;
    if (
      ![raw.configured, raw.linked, raw.pendingAuthorization, raw.syncing].every(
        (field) => typeof field === "boolean",
      ) ||
      !scheduler ||
      typeof scheduler.enabled !== "boolean" ||
      !nonnegativeInteger(scheduler.intervalSeconds) ||
      !nonnegativeInteger(raw.deviceCount) ||
      !nonnegativeInteger(raw.reportCount) ||
      !nullableDate(raw.lastSuccessAt) ||
      !nullableDate(raw.nextSyncAt) ||
      !(raw.latestReportDate === null || /^\d{4}-\d{2}-\d{2}$/.test(String(raw.latestReportDate)))
    )
      throw invalidResponse();
    // Only known fields cross into the browser; never spread an upstream payload.
    return {
      configured: raw.configured as boolean,
      linked: raw.linked as boolean,
      pendingAuthorization: raw.pendingAuthorization as boolean,
      syncing: raw.syncing as boolean,
      lastSuccessAt: raw.lastSuccessAt as string | null,
      nextSyncAt: raw.nextSyncAt as string | null,
      lastError: raw.lastError === null ? null : safeMoonErrorCode(raw.lastError),
      deviceCount: raw.deviceCount as number,
      reportCount: raw.reportCount as number,
      latestReportDate: raw.latestReportDate as string | null,
      scheduler: {
        enabled: scheduler.enabled,
        intervalSeconds: scheduler.intervalSeconds as number,
      },
    };
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
      throw invalidResponse();
    assertOfficialMoonAuthorizeUrl(result.authorizationUrl);
    return { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt };
  }

  callback(callbackUrl: string) {
    return this.call<void>("POST", "/v1/auth/callback", { callbackUrl });
  }
  sync() {
    return this.call<MoonSnapshot>("POST", "/v1/sync", undefined, 180_000);
  }
  snapshot() {
    return this.call<MoonSnapshot>("GET", "/v1/snapshot");
  }
  disconnect() {
    return this.call<void>("DELETE", "/v1/link");
  }

  private call<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.apiKey) throw new MoonSidecarError(503, "sidecar_not_configured");
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          method,
          path,
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
            if (size > responseLimit) {
              reject(new MoonSidecarError(502, "moon_response_too_large"));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on("end", () => {
            let value: unknown;
            try {
              const raw = Buffer.concat(chunks).toString("utf8");
              value = raw ? JSON.parse(raw) : undefined;
            } catch {
              reject(invalidResponse());
              return;
            }
            const status = response.statusCode || 502;
            if (status >= 200 && status < 300) {
              resolve(value as T);
              return;
            }
            const error =
              value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
            const seconds = Number(response.headers["retry-after"]);
            reject(
              new MoonSidecarError(
                [400, 401, 403, 404, 409, 413, 429].includes(status) ? status : 502,
                safeMoonErrorCode(error),
                Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : null,
              ),
            );
          });
          response.on("error", () => reject(new MoonSidecarError(502, "sidecar_unavailable")));
        },
      );
      // An absolute deadline also stops a peer that sends occasional bytes forever.
      const deadline = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
      deadline.unref();
      request.on("close", () => clearTimeout(deadline));
      request.on("error", () => reject(new MoonSidecarError(503, "sidecar_unavailable")));
      if (payload) request.write(payload);
      request.end();
    });
  }
}

export async function readMoonApiKey(environment: NodeJS.ProcessEnv = process.env) {
  const file = environment.MOON_SIDECAR_API_KEY_FILE?.trim();
  if (!file || !isAbsolute(file)) throw new Error("Moon API key requires an absolute secret file");
  let handle;
  let key: string;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > 256
    )
      throw new MoonSidecarError(503, "unsafe_private_file");
    key = (await handle.readFile("utf8")).trim();
  } catch (error) {
    if (error instanceof MoonSidecarError) throw error;
    throw new MoonSidecarError(503, "unsafe_private_file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(key)) throw new MoonSidecarError(503, "invalid_api_key_file");
  return key;
}

export function assertOfficialMoonAuthorizeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MoonSidecarError(502, "invalid_authorize_url");
  }
  if (
    url.origin !== "https://accounts.nintendo.com" ||
    url.pathname !== "/connect/1.0.0/authorize" ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.getAll("client_id").length !== 1 ||
    url.searchParams.get("client_id") !== clientId ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("redirect_uri") !== `npf${clientId}://auth` ||
    url.searchParams.getAll("state").length !== 1 ||
    !url.searchParams.get("state")
  )
    throw new MoonSidecarError(502, "invalid_authorize_url");
}

const publicErrors = new Set([
  "moon_unlinked",
  "moon_busy",
  "moon_snapshot_missing",
  "moon_authorization_expired",
  "moon_callback_invalid",
  "moon_state_mismatch",
  "moon_authorization_denied",
  "moon_reauthorization_required",
  "moon_account_mismatch",
  "moon_rate_limited",
  "moon_upstream_unavailable",
  "moon_redirect_rejected",
  "moon_upstream_rejected",
  "moon_invalid_upstream_data",
  "moon_network_error",
  "moon_timeout",
  "moon_response_too_large",
  "moon_internal_error",
  "moon_configuration_invalid",
  "moon_sync_backoff",
  "moon_lease_lost",
  "moon_import_failed",
  "sidecar_not_configured",
  "sidecar_unavailable",
  "invalid_sidecar_response",
  "invalid_authorize_url",
  "unauthorized",
  "invalid_request",
  "invalid_callback",
  "callback_expired",
  "callback_state_mismatch",
  "authorization_pending",
  "authorization_expired",
  "authorization_required",
  "not_linked",
  "moon_not_linked",
  "snapshot_missing",
  "sync_in_progress",
  "sync_backoff",
  "sync_failed",
  "upstream_error",
  "upstream_unavailable",
  "upstream_rate_limited",
  "nintendo_auth_failed",
  "nintendo_auth_expired",
  "invalid_session_token",
  "invalid_session_token_code",
  "token_expired",
  "invalid_snapshot",
  "no_devices",
  "internal_error",
  "request_too_large",
  "scheduler_conflict",
]);
export function safeMoonErrorCode(value: unknown) {
  return typeof value === "string" && publicErrors.has(value) ? value : "sidecar_error";
}
function nonnegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nullableDate(value: unknown) {
  return (
    value === null ||
    (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)))
  );
}
function invalidResponse() {
  return new MoonSidecarError(502, "invalid_sidecar_response");
}
