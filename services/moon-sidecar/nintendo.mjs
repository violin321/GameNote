import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { MoonError } from "./security.mjs";

export const MOON_CLIENT_ID = "54789befb391a838";
export const MOON_REDIRECT_URI = `npf${MOON_CLIENT_ID}://auth`;
export const MOON_SCOPE =
  "openid user user.mii moonUser:administration moonDevice:create moonOwnedDevice:administration moonParentalControlSetting moonParentalControlSetting:update moonParentalControlSettingState moonPairingState moonSmartDevice:administration moonDailySummary moonMonthlySummary";
export const MOON_PROFILE = Object.freeze({
  version: "2.4.0",
  build: "660",
  os: "ANDROID",
  osVersion: "26",
});
const ACCOUNT_BASE = "https://accounts.nintendo.com/connect/1.0.0/api";
const USER_URL = "https://api.accounts.nintendo.com/2.0.0/users/me";
const MOON_BASE = "https://api-lp1.pctl.srv.nintendo.net/moon";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function validatedId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw new MoonError("moon_invalid_upstream_data");
  return value;
}

export function assertAllowedRequest(url, method) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new MoonError("moon_endpoint_forbidden", 400);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== url
  ) {
    throw new MoonError("moon_endpoint_forbidden", 400);
  }
  if (method === "POST" && [ACCOUNT_BASE + "/session_token", ACCOUNT_BASE + "/token"].includes(url))
    return;
  if (method === "GET" && url === USER_URL) return;
  if (
    method === "GET" &&
    parsed.origin === "https://api-lp1.pctl.srv.nintendo.net" &&
    (/^\/moon\/v1\/users\/[A-Za-z0-9_-]{1,128}\/devices$/.test(parsed.pathname) ||
      /^\/moon\/v1\/devices\/[A-Za-z0-9_-]{1,128}\/daily_summaries$/.test(parsed.pathname))
  )
    return;
  throw new MoonError("moon_endpoint_forbidden", 400);
}

/**
 * Direct TLS only: no environment proxy, redirects, arbitrary paths, or remote config.
 * @param {{ url: string, method: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }} input
 */
export async function requestNintendoJson({ url, method, headers = {}, body, signal }) {
  assertAllowedRequest(url, method);
  if (body && Buffer.byteLength(body) > 32 * 1024)
    throw new MoonError("moon_request_too_large", 400);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method,
        headers: { Accept: "application/json", ...headers },
        agent: false,
        rejectUnauthorized: true,
        signal,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            request.destroy();
            reject(new MoonError("moon_response_too_large"));
          } else chunks.push(chunk);
        });
        response.on("error", () => reject(new MoonError("moon_network_error")));
        response.on("end", () => {
          clearTimeout(deadline);
          const status = response.statusCode || 502;
          if (status !== 200) {
            const code = [401, 403].includes(status)
              ? "moon_reauthorization_required"
              : status === 429
                ? "moon_rate_limited"
                : status >= 300 && status < 400
                  ? "moon_redirect_rejected"
                  : "moon_upstream_unavailable";
            reject(new MoonError(code, code === "moon_rate_limited" ? 429 : 502));
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("shape");
            if (data.error || data.errorCode) throw new MoonError("moon_upstream_rejected");
            resolve(data);
          } catch (error) {
            reject(
              error instanceof MoonError ? error : new MoonError("moon_invalid_upstream_data"),
            );
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      request.destroy();
      reject(new MoonError("moon_timeout", 504));
    }, 15_000);
    request.on("error", () => {
      clearTimeout(deadline);
      reject(
        signal?.aborted ? new MoonError("moon_timeout", 504) : new MoonError("moon_network_error"),
      );
    });
    request.on("close", () => clearTimeout(deadline));
    request.end(body);
  });
}

function secretString(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 8192 || /\s/.test(value)) {
    throw new MoonError("moon_invalid_upstream_data");
  }
  return value;
}

export function createNintendoClient({
  transport = requestNintendoJson,
  wait = (milliseconds) => delay(milliseconds),
} = {}) {
  async function call(request) {
    // Enforce allowlist even for an injected test transport.
    assertAllowedRequest(request.url, request.method);
    if (request.signal?.aborted) throw new MoonError("moon_timeout", 504);
    try {
      const result = await transport(request);
      if (request.signal?.aborted) throw new MoonError("moon_timeout", 504);
      return result;
    } catch (error) {
      // Only idempotent reads retry, once. Never replay an OAuth code exchange.
      if (
        request.signal?.aborted ||
        request.method !== "GET" ||
        !(error instanceof MoonError) ||
        !["moon_network_error", "moon_timeout", "moon_upstream_unavailable"].includes(error.code)
      )
        throw error;
      await wait(250);
      if (request.signal?.aborted) throw new MoonError("moon_timeout", 504);
      const result = await transport(request);
      if (request.signal?.aborted) throw new MoonError("moon_timeout", 504);
      return result;
    }
  }
  async function account(sessionToken, signal) {
    const token = await call({
      url: ACCOUNT_BASE + "/token",
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 8.0.0)",
      },
      body: JSON.stringify({
        client_id: MOON_CLIENT_ID,
        session_token: sessionToken,
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
      }),
    });
    const accessToken = secretString(token.access_token);
    const user = await call({
      url: USER_URL,
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "NASDKAPI; Android",
        "Accept-Language": "en-GB",
      },
    });
    return { accessToken, accountId: validatedId(user.id) };
  }
  async function moon(path, accessToken, signal) {
    return call({
      url: MOON_BASE + path,
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Moon-App-Id": "com.nintendo.znma",
        "X-Moon-Os": MOON_PROFILE.os,
        "X-Moon-Os-Version": MOON_PROFILE.osVersion,
        "X-Moon-Model": "",
        "X-Moon-TimeZone": "Asia/Shanghai",
        "X-Moon-Os-Language": "en-GB",
        "X-Moon-App-Language": "en-GB",
        "X-Moon-App-Display-Version": MOON_PROFILE.version,
        "X-Moon-App-Internal-Version": MOON_PROFILE.build,
        "User-Agent": `moon_ANDROID/${MOON_PROFILE.version} (com.nintendo.znma; build:${MOON_PROFILE.build}; ANDROID 26)`,
      },
    });
  }
  return {
    async exchangeCode(code, verifier) {
      const token = await call({
        url: ACCOUNT_BASE + "/session_token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "NASDKAPI; Android",
        },
        body: new URLSearchParams({
          client_id: MOON_CLIENT_ID,
          session_token_code: code,
          session_token_code_verifier: verifier,
        }).toString(),
      });
      return secretString(token.session_token);
    },
    account,
    async collect(sessionToken, expectedAccountId) {
      const signal = AbortSignal.timeout(120_000);
      const { accessToken, accountId } = await account(sessionToken, signal);
      if (accountId !== expectedAccountId) throw new MoonError("moon_account_mismatch", 409);
      const devices = await moon(
        `/v1/users/${validatedId(accountId)}/devices`,
        accessToken,
        signal,
      );
      if (!Array.isArray(devices.items) || devices.items.length > 16)
        throw new MoonError("moon_invalid_upstream_data");
      const results = [];
      const seen = new Set();
      for (const device of devices.items) {
        const deviceId = validatedId(device.deviceId);
        if (seen.has(deviceId)) throw new MoonError("moon_invalid_upstream_data");
        seen.add(deviceId);
        const reports = await moon(`/v1/devices/${deviceId}/daily_summaries`, accessToken, signal);
        if (!Array.isArray(reports.items) || reports.items.length > 400)
          throw new MoonError("moon_invalid_upstream_data");
        results.push({ deviceId, reports: reports.items });
      }
      return { accountId, devices: results };
    },
  };
}
