import { request as httpsRequest } from "node:https";

export const STORE_CLIENT_ID = "5c38e31cd085304b";
export const STORE_REDIRECT_URI = `npf${STORE_CLIENT_ID}://auth`;
export const STORE_SCOPE = "openid user user.mii user.email user.links[].id";

const ACCOUNT_BASE = "https://accounts.nintendo.com/connect/1.0.0/api";
const HISTORY_URL = "https://app-api.znej.nintendo.com/api/v2.0/users/me/play_histories";
const USER_AGENT = "com.nintendo.znej/3.0.3 (iOS/26.0.1)";

export class ProbeError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
    this.status = status;
  }
}

function allowed(url, method) {
  return (
    (method === "POST" &&
      (url === `${ACCOUNT_BASE}/session_token` || url === `${ACCOUNT_BASE}/token`)) ||
    (method === "GET" && url === HISTORY_URL)
  );
}

function assertAllowed(url, method) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProbeError("store_endpoint_forbidden", 400);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== url ||
    !allowed(url, method)
  )
    throw new ProbeError("store_endpoint_forbidden", 400);
}

export function classifyStoreHttpError(url, status, bodyText = "") {
  if (status >= 300 && status < 400) return "store_redirect_rejected";
  if (url === `${ACCOUNT_BASE}/token` && (status === 401 || status === 403))
    return "store_reauthorization_required";
  if (status === 401 || status === 403) return "store_auth_rejected";
  if (status !== 400) return `store_http_${status}`;
  try {
    const parsed = JSON.parse(bodyText);
    const hint = `${parsed?.error || ""} ${parsed?.error_description || ""}`;
    if (url === `${ACCOUNT_BASE}/token` && /invalid[_ -]?grant/i.test(hint))
      return "store_reauthorization_required";
    if (/id[_ -]?token/i.test(hint) && /(parse|invalid|malformed|decode)/i.test(hint))
      return "store_id_token_parse_failed";
  } catch {
    // Malformed upstream errors retain their generic fixed status code.
  }
  return "store_http_400";
}

/** Direct TLS request to the small, fixed Nintendo Store endpoint allowlist. */
export async function requestStoreJson({ url, method, headers = {}, body, signal }) {
  assertAllowed(url, method);
  if (body && Buffer.byteLength(body) > 32 * 1024)
    throw new ProbeError("store_request_too_large", 400);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const req = httpsRequest(
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
            req.destroy();
            finish(reject, new ProbeError("store_response_too_large"));
          } else chunks.push(chunk);
        });
        response.on("error", () => finish(reject, new ProbeError("store_network_error")));
        response.on("end", () => {
          const status = response.statusCode || 502;
          if (status < 200 || status >= 300) {
            const code = classifyStoreHttpError(
              url,
              status,
              Buffer.concat(chunks).toString("utf8"),
            );
            finish(reject, new ProbeError(code, status));
            return;
          }
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("shape");
            finish(resolve, data);
          } catch {
            finish(reject, new ProbeError("store_invalid_upstream_data"));
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      finish(reject, new ProbeError("store_timeout", 504));
    }, 15_000);
    req.on("error", () =>
      finish(
        reject,
        signal?.aborted
          ? new ProbeError("store_timeout", 504)
          : new ProbeError("store_network_error"),
      ),
    );
    req.end(body);
  });
}

function secret(value, field) {
  if (typeof value !== "string" || value.length < 8 || value.length > 16_384 || /\s/.test(value))
    throw new ProbeError(`store_missing_${field}`);
  return value;
}

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizedHistory(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.playHistories))
    throw new ProbeError("store_invalid_upstream_data");
  if (raw.playHistories.length > 5_000) throw new ProbeError("store_response_too_large", 502);
  const source = raw.playHistories;
  const playHistories = source
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const out = {};
      for (const key of [
        "titleId",
        "titleName",
        "platform",
        "deviceType",
        "imageUrl",
        "firstPlayedAt",
        "lastPlayedAt",
        "lastUpdatedAt",
      ]) {
        if (typeof item[key] === "string" && item[key].length <= 512) out[key] = item[key];
      }
      const minutes = nonNegativeInt(item.totalPlayedMinutes);
      if (minutes !== undefined) out.totalPlayedMinutes = minutes;
      const days = nonNegativeInt(item.totalPlayedDays);
      if (days !== undefined) out.totalPlayedDays = days;
      return Object.keys(out).length ? out : null;
    })
    .filter(Boolean);

  const recent = Array.isArray(raw?.recentPlayHistories) ? raw.recentPlayHistories : [];
  if (recent.length > 4_000) throw new ProbeError("store_response_too_large", 502);
  const dates = [];
  const days = [];
  let dailyTitleCount = 0;
  for (const item of recent) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const value = item.date ?? item.playedAt ?? item.playedDate;
    const playedDate =
      typeof value === "string" && value.length <= 64 ? value.slice(0, 10) : undefined;
    if (playedDate) dates.push(playedDate);
    const sourceTitles = Array.isArray(item.dailyPlayHistories) ? item.dailyPlayHistories : [];
    dailyTitleCount += sourceTitles.length;
    if (dailyTitleCount > 20_000) throw new ProbeError("store_response_too_large", 502);
    const dailyPlayHistories = sourceTitles
      .map((title) => {
        if (!title || typeof title !== "object" || Array.isArray(title)) return null;
        const out = {};
        for (const key of ["titleId", "titleName", "platform", "deviceType", "imageUrl"]) {
          if (typeof title[key] === "string" && title[key].length <= 512) out[key] = title[key];
        }
        const minutes = nonNegativeInt(title.totalPlayedMinutes);
        if (minutes !== undefined) out.totalPlayedMinutes = minutes;
        return Object.keys(out).length ? out : null;
      })
      .filter(Boolean);
    if (playedDate || dailyPlayHistories.length) days.push({ playedDate, dailyPlayHistories });
  }
  return {
    playHistories,
    recentPlayHistories: { count: recent.length, dates: [...new Set(dates)], days },
    lastUpdatedAt:
      typeof raw.lastUpdatedAt === "string" && raw.lastUpdatedAt.length <= 64
        ? raw.lastUpdatedAt
        : undefined,
  };
}

export function createStoreClient({ transport = requestStoreJson } = {}) {
  const call = async (request) => {
    assertAllowed(request.url, request.method);
    return transport(request);
  };
  return {
    async exchangeCode(code, verifier, signal) {
      const result = await call({
        url: `${ACCOUNT_BASE}/session_token`,
        method: "POST",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: new URLSearchParams({
          client_id: STORE_CLIENT_ID,
          session_token_code: code,
          session_token_code_verifier: verifier,
        }).toString(),
      });
      return secret(result.session_token, "session_token");
    },
    async collect(sessionToken, signal) {
      const token = await call({
        url: `${ACCOUNT_BASE}/token`,
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          client_id: STORE_CLIENT_ID,
          session_token: secret(sessionToken, "session_token"),
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
        }),
      });
      const accessToken = secret(token.access_token, "access_token");
      const idToken = token.id_token ? secret(token.id_token, "id_token") : undefined;
      const fetchHistory = (bearer) =>
        call({
          url: HISTORY_URL,
          method: "GET",
          signal,
          headers: {
            Authorization: `Bearer ${bearer}`,
            "User-Agent": USER_AGENT,
            "Gentry-Locale": "en-GB",
          },
        });
      try {
        return {
          history: normalizedHistory(await fetchHistory(accessToken)),
          authentication: "access_token",
        };
      } catch (error) {
        const idFallback =
          idToken &&
          (error?.status === 401 ||
            error?.status === 403 ||
            (error?.status === 400 && error?.code === "store_id_token_parse_failed"));
        if (!idFallback) throw error;
        return {
          history: normalizedHistory(await fetchHistory(idToken)),
          authentication: "id_token",
        };
      }
    },
  };
}
