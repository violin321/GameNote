import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { STORE_CLIENT_ID, STORE_REDIRECT_URI, STORE_SCOPE, createStoreClient } from "./client.mjs";

export const STORE_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const aad = Buffer.from("gamenote.nintendo.store.credentials.v1");

export class StoreAuthError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.name = "StoreAuthError";
    this.code = code;
    this.status = status;
  }
}

/** Store credentials never fall back to a developer home directory. */
export function nintendoStoreDataDirectory(environment = process.env) {
  const configured = environment.NINTENDO_STORE_DATA_DIR?.trim();
  if (
    !configured ||
    configured.length > 2048 ||
    !isAbsolute(configured) ||
    configured.includes("\0")
  )
    throw new StoreAuthError("not_configured", 503);
  const directory = resolve(configured);
  if (directory === parse(directory).root) throw new StoreAuthError("not_configured", 503);
  return directory;
}

function paths(environment = process.env) {
  const directory = nintendoStoreDataDirectory(environment);
  return {
    directory,
    pending: join(directory, "pending.json"),
    key: join(directory, "secret.key"),
    token: join(directory, "session.enc"),
  };
}

function randomText(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function authorization(now = Date.now()) {
  const state = randomText(36);
  const verifier = randomText(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: STORE_CLIENT_ID,
    redirect_uri: STORE_REDIRECT_URI,
    response_type: "session_token_code",
    scope: STORE_SCOPE,
    session_token_code_challenge: challenge,
    session_token_code_challenge_method: "S256",
    state,
    theme: "login_form",
  });
  return {
    state,
    verifier,
    authorizationUrl: `https://accounts.nintendo.com/connect/1.0.0/authorize?${query}`,
    expiresAt: now + STORE_AUTHORIZATION_TTL_MS,
  };
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateStoreCallback(callbackUrl, pending, now = Date.now()) {
  if (!pending || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now)
    throw new StoreAuthError("store_authorization_expired", 409);
  if (
    typeof callbackUrl !== "string" ||
    callbackUrl.length < 1 ||
    callbackUrl.length > 4096 ||
    /[\r\n\t\s]/.test(callbackUrl)
  )
    throw new StoreAuthError("store_callback_invalid", 400);

  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new StoreAuthError("store_callback_invalid", 400);
  }
  if (
    url.protocol !== `npf${STORE_CLIENT_ID}:` ||
    url.host !== "auth" ||
    url.pathname ||
    url.username ||
    url.password ||
    url.port ||
    (url.hash && url.search)
  )
    throw new StoreAuthError("store_callback_invalid", 400);

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
      throw new StoreAuthError("store_callback_invalid", 400);
  if (!equalSecret(params.get("state") || "", pending.state))
    throw new StoreAuthError("store_state_mismatch", 400);
  if (params.has("error")) throw new StoreAuthError("store_authorization_denied", 400);
  const code = params.get("session_token_code");
  if (!code || code.length > 2048 || !/^[A-Za-z0-9._~-]+$/.test(code))
    throw new StoreAuthError("store_callback_invalid", 400);
  return code;
}

async function ensureDirectory(environment = process.env) {
  const directory = nintendoStoreDataDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new StoreAuthError("store_data_directory_unsafe", 503);
  await chmod(directory, 0o700);
  return directory;
}

async function writePrivate(path, value) {
  const temporary = `${path}.${randomText(8)}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readPrivate(path, maximumBytes) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new StoreAuthError("store_credential_invalid", 503);
  return readFile(path, "utf8");
}

async function readPending(environment = process.env) {
  const { pending } = paths(environment);
  try {
    const value = JSON.parse(await readPrivate(pending, 16 * 1024));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.state !== "string" ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(value.state) ||
      typeof value.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(value.verifier) ||
      typeof value.authorizationUrl !== "string" ||
      !isAuthorizationUrl(value.authorizationUrl) ||
      !Number.isSafeInteger(value.expiresAt)
    )
      return null;
    return value;
  } catch (error) {
    if (error instanceof StoreAuthError && error.code === "not_configured") throw error;
    return null;
  }
}

function isAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "accounts.nintendo.com" &&
      url.pathname === "/connect/1.0.0/authorize" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.searchParams.get("client_id") === STORE_CLIENT_ID &&
      url.searchParams.get("redirect_uri") === STORE_REDIRECT_URI &&
      url.searchParams.get("response_type") === "session_token_code"
    );
  } catch {
    return false;
  }
}

export async function readPendingStoreAuthorization(environment = process.env) {
  return readPending(environment);
}

export async function beginStoreAuthorization(now = Date.now(), environment = process.env) {
  await ensureDirectory(environment);
  const files = paths(environment);
  const previous = await readPending(environment);
  const pending = previous && previous.expiresAt > now ? previous : authorization(now);
  if (!previous || previous.expiresAt <= now)
    await writePrivate(files.pending, JSON.stringify(pending));
  return { authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt };
}

async function loadKey(environment = process.env, create = false) {
  const { key } = paths(environment);
  try {
    const encoded = (await readPrivate(key, 256)).trim();
    const value = Buffer.from(encoded, "base64url");
    if (value.length === 32 && value.toString("base64url") === encoded) return value;
  } catch (error) {
    if (!isNotFound(error) && !(error instanceof StoreAuthError)) throw error;
  }
  if (!create) throw new StoreAuthError("store_credential_invalid", 503);
  const value = randomBytes(32);
  await writePrivate(key, `${value.toString("base64url")}\n`);
  return value;
}

function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  });
}

function decrypt(value, key) {
  try {
    const envelope = JSON.parse(value);
    if (
      !envelope ||
      envelope.version !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.data !== "string"
    )
      throw new Error("envelope");
    const iv = Buffer.from(envelope.iv, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    const data = Buffer.from(envelope.data, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || data.length < 1) throw new Error("envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    if (!/^[A-Za-z0-9._~-]{8,16384}$/.test(token)) throw new Error("token");
    return token;
  } catch {
    throw new StoreAuthError("store_credential_invalid", 503);
  }
}

export async function readStoreSession(environment = process.env) {
  const files = paths(environment);
  let encrypted;
  try {
    encrypted = await readPrivate(files.token, 32 * 1024);
  } catch (error) {
    if (isNotFound(error)) throw new StoreAuthError("store_not_connected", 409);
    if (error instanceof StoreAuthError) throw error;
    throw new StoreAuthError("store_credential_invalid", 503);
  }
  return decrypt(encrypted, await loadKey(environment));
}

export async function readStoreCredentialState(environment = process.env) {
  nintendoStoreDataDirectory(environment);
  try {
    await readStoreSession(environment);
    return "connected";
  } catch (error) {
    if (error instanceof StoreAuthError && error.code === "store_not_connected")
      return "not_connected";
    if (error instanceof StoreAuthError && error.code === "store_credential_invalid")
      return "invalid";
    throw error;
  }
}

export async function completeStoreAuthorization(
  callbackUrl,
  { now = Date.now(), environment = process.env, client = createStoreClient() } = {},
) {
  const pending = await readPending(environment);
  const code = validateStoreCallback(callbackUrl, pending, now);
  const files = paths(environment);
  // Burn the state before exchanging the code so a valid callback cannot be replayed.
  await unlink(files.pending).catch(() => undefined);
  try {
    const sessionToken = await client.exchangeCode(code, pending.verifier);
    const result = await client.collect(sessionToken);
    await ensureDirectory(environment);
    const key = await loadKey(environment, true);
    await writePrivate(files.token, encrypt(sessionToken, key));
    return { authentication: result.authentication };
  } catch (error) {
    if (error instanceof StoreAuthError) throw error;
    throw new StoreAuthError("store_authorization_failed", 502);
  }
}

export async function disconnectStoreCredentials(environment = process.env) {
  const files = paths(environment);
  await unlink(files.pending).catch(() => undefined);
  await unlink(files.token).catch(() => undefined);
}

export async function hasStoreSession(environment = process.env) {
  return (await readStoreCredentialState(environment)) === "connected";
}

function isNotFound(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}
