import { createHash, randomBytes } from "node:crypto";
import {
  createNintendoClient,
  MOON_CLIENT_ID,
  MOON_REDIRECT_URI,
  MOON_SCOPE,
} from "./nintendo.mjs";
import { normalizeMoonSnapshot } from "./normalize.mjs";
import { equalSecret, MoonError, safeError } from "./security.mjs";

export const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;

export function createAuthorization(now = Date.now()) {
  const state = randomBytes(36).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    state,
    redirect_uri: MOON_REDIRECT_URI,
    client_id: MOON_CLIENT_ID,
    scope: MOON_SCOPE,
    response_type: "session_token_code",
    session_token_code_challenge: challenge,
    session_token_code_challenge_method: "S256",
    theme: "login_form",
  });
  return {
    state,
    verifier,
    authorizationUrl: `https://accounts.nintendo.com/connect/1.0.0/authorize?${query}`,
    expiresAt: now + AUTHORIZATION_TTL_MS,
  };
}

export function validateCallback(callbackUrl, pending, now = Date.now()) {
  if (!pending || pending.expiresAt <= now) throw new MoonError("moon_authorization_expired", 409);
  if (
    typeof callbackUrl !== "string" ||
    callbackUrl.length > 4096 ||
    /[\r\n\t\s]/.test(callbackUrl)
  )
    throw new MoonError("moon_callback_invalid", 400);
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new MoonError("moon_callback_invalid", 400);
  }
  if (
    url.protocol !== `npf${MOON_CLIENT_ID}:` ||
    url.host !== "auth" ||
    url.pathname ||
    url.username ||
    url.password ||
    url.port ||
    (url.hash && url.search)
  ) {
    throw new MoonError("moon_callback_invalid", 400);
  }
  const params = new URLSearchParams(url.hash ? url.hash.slice(1) : url.search.slice(1));
  const allowed = new Set([
    "state",
    "session_token_code",
    "session_state",
    "error",
    "error_description",
  ]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new MoonError("moon_callback_invalid", 400);
  if (!equalSecret(params.get("state") || "", pending.state))
    throw new MoonError("moon_state_mismatch", 400);
  if (params.has("error")) throw new MoonError("moon_authorization_denied", 400);
  const code = params.get("session_token_code");
  if (!code || code.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(code))
    throw new MoonError("moon_callback_invalid", 400);
  return code;
}

function validateSessionAudience(token, now) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("jwt");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (
      claims.aud !== MOON_CLIENT_ID ||
      claims.iss !== "https://accounts.nintendo.com" ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now
    )
      throw new Error("audience");
  } catch {
    // The session token came from Nintendo over TLS. These are additional audience/expiry
    // checks, not a substitute for JWT signature verification or local token acceptance.
    throw new MoonError("moon_invalid_upstream_data");
  }
}

const emptyState = () => ({
  version: 1,
  credential: null,
  pending: null,
  snapshot: null,
  lastSuccessAt: null,
  lastError: null,
  nextSyncAt: null,
});

/** Dependency injection is a library test seam; the production CLI exposes no fixture switch. */
export async function createMoonRuntime({
  store,
  installationKey,
  client = createNintendoClient(),
  now = Date.now,
  schedulerEnabled = false,
  intervalSeconds = 21600,
  failureSeconds = 300,
}) {
  if (!Buffer.isBuffer(installationKey) || installationKey.length !== 32)
    throw new MoonError("invalid_private_key", 500);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 3600 ||
    intervalSeconds > 86400 ||
    !Number.isInteger(failureSeconds) ||
    failureSeconds < 60 ||
    failureSeconds > 900
  )
    throw new MoonError("moon_scheduler_config_invalid", 500);
  let state = (await store.load()) || emptyState();
  if (state.version !== 1) throw new MoonError("moon_state_unreadable", 500);
  let active = null;
  let timer = null;
  let stopped = false;

  async function commit(next) {
    await store.save(next);
    state = next;
  }
  async function exclusively(operation, task) {
    if (active) throw new MoonError("moon_busy", 409);
    active = operation;
    try {
      return await task();
    } finally {
      active = null;
    }
  }
  function nextAfter(seconds) {
    return new Date(now() + seconds * 1000).toISOString();
  }
  function arm() {
    clearTimeout(timer);
    timer = null;
    if (!schedulerEnabled || !state.credential || stopped) return;
    const due = state.nextSyncAt ? Date.parse(state.nextSyncAt) : now();
    timer = setTimeout(
      async () => {
        if (active) {
          timer = setTimeout(arm, 1000);
          return;
        }
        try {
          await runtime.sync();
        } catch {
          /* sync persisted a safe error and short retry. */
        }
        arm();
      },
      Math.max(1000, Math.min(86400_000, due - now())),
    );
    timer.unref();
  }
  const runtime = {
    status() {
      const reports = state.snapshot?.dailyReports || [];
      return {
        configured: true,
        linked: Boolean(state.credential),
        pendingAuthorization: Boolean(state.pending && state.pending.expiresAt > now()),
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        nextSyncAt: schedulerEnabled && state.credential ? state.nextSyncAt : null,
        syncing: active === "sync",
        deviceCount: state.snapshot?.devices.length || 0,
        reportCount: reports.length,
        latestReportDate: reports.reduce(
          (latest, report) => (!latest || report.date > latest ? report.date : latest),
          null,
        ),
        scheduler: { enabled: schedulerEnabled, intervalSeconds },
      };
    },
    async authorize() {
      return exclusively("authorize", async () => {
        let pending = state.pending;
        if (!pending || pending.expiresAt <= now()) {
          pending = createAuthorization(now());
          await commit({ ...state, pending });
        }
        return { authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt };
      });
    },
    async callback(callbackUrl) {
      return exclusively("callback", async () => {
        const pending = state.pending;
        const code = validateCallback(callbackUrl, pending, now());
        // Burn valid-state codes durably before contacting Nintendo, including on failures.
        await commit({ ...state, pending: null });
        try {
          const sessionToken = await client.exchangeCode(code, pending.verifier);
          validateSessionAudience(sessionToken, now());
          const { accountId } = await client.account(sessionToken);
          const sameAccount = state.credential?.accountId === accountId;
          await commit({
            ...state,
            credential: { sessionToken, accountId },
            lastError: null,
            snapshot: sameAccount ? state.snapshot : null,
            lastSuccessAt: sameAccount ? state.lastSuccessAt : null,
            nextSyncAt: schedulerEnabled ? new Date(now()).toISOString() : null,
          });
          arm();
        } catch (error) {
          const safe = safeError(error);
          await commit({ ...state, lastError: safe.code });
          throw safe;
        }
      });
    },
    async sync() {
      return exclusively("sync", async () => {
        if (!state.credential) throw new MoonError("moon_unlinked", 409);
        try {
          const raw = await client.collect(
            state.credential.sessionToken,
            state.credential.accountId,
          );
          const fetchedAt = new Date(now()).toISOString();
          const snapshot = normalizeMoonSnapshot(raw, installationKey, fetchedAt);
          await commit({
            ...state,
            snapshot,
            lastSuccessAt: fetchedAt,
            lastError: null,
            nextSyncAt: schedulerEnabled ? nextAfter(intervalSeconds) : null,
          });
          arm();
          return structuredClone(snapshot);
        } catch (error) {
          const safe = safeError(error);
          await commit({
            ...state,
            lastError: safe.code,
            nextSyncAt: schedulerEnabled ? nextAfter(failureSeconds) : null,
          });
          arm();
          throw safe;
        }
      });
    },
    snapshot() {
      if (!state.snapshot) throw new MoonError("moon_snapshot_missing", 404);
      return structuredClone(state.snapshot);
    },
    async disconnect() {
      return exclusively("disconnect", async () => {
        await commit(emptyState());
        arm();
      });
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
  if (schedulerEnabled && state.credential && !state.nextSyncAt)
    await commit({ ...state, nextSyncAt: new Date(now()).toISOString() });
  arm();
  return runtime;
}
