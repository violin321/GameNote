import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { STORE_CLIENT_ID, STORE_REDIRECT_URI, STORE_SCOPE, createStoreClient } from "./client.mjs";

const directory = resolve(
  process.env.NINTENDO_STORE_PROBE_DIR || join(homedir(), ".local/share/gamenote-store-probe"),
);
const pendingPath = join(directory, "pending.json");
const keyPath = join(directory, "secret.key");
const tokenPath = join(directory, "session.enc");
const aad = Buffer.from("gamenote.nintendo.store.probe.v1");

function randomText(bytes) {
  return randomBytes(bytes).toString("base64url");
}
async function writePrivate(path, text) {
  const tmp = `${path}.${randomText(8)}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
}
async function ensureDirectory() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
async function readKey() {
  try {
    const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64url");
    if (key.length === 32) return key;
  } catch {}
  const key = randomBytes(32);
  await writePrivate(keyPath, key.toString("base64url") + "\n");
  return key;
}
function createAuthorization() {
  const state = randomText(36),
    verifier = randomText(32);
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
  };
}
function encrypt(value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  });
}
function decrypt(envelope, key) {
  const value = JSON.parse(envelope);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
function printResult(result) {
  const titles = result.history.playHistories.map((item) => ({
    titleId: item.titleId || "",
    titleName: item.titleName || "",
    platform: item.platform || item.deviceType || "",
    totalPlayedMinutes: item.totalPlayedMinutes,
    totalPlayedDays: item.totalPlayedDays,
    firstPlayedAt: item.firstPlayedAt || "",
    lastPlayedAt: item.lastPlayedAt || "",
  }));
  console.log(
    JSON.stringify(
      {
        authentication: result.authentication,
        titleCount: titles.length,
        titles,
        recent: result.history.recentPlayHistories,
      },
      null,
      2,
    ),
  );
}

const [command, ...args] = process.argv.slice(2);
await ensureDirectory();
if (command === "start") {
  const pending = createAuthorization();
  await writePrivate(pendingPath, JSON.stringify(pending));
  console.log(
    JSON.stringify(
      {
        authorizationUrl: pending.authorizationUrl,
        callbackPrefix: `${STORE_REDIRECT_URI}#`,
        expiresInMinutes: 15,
      },
      null,
      2,
    ),
  );
} else if (command === "callback") {
  const url = args[0] === "--url" ? args[1] : args[0];
  if (!url) throw new Error("usage: callback --url <full callback url>");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  const parsed = new URL(url);
  if (
    parsed.protocol !== `npf${STORE_CLIENT_ID}:` ||
    parsed.host !== "auth" ||
    parsed.pathname ||
    parsed.search
  )
    throw new Error("store_callback_invalid");
  const params = new URLSearchParams(parsed.hash.slice(1));
  if (params.get("state") !== pending.state || !params.get("session_token_code"))
    throw new Error("store_callback_state_mismatch");
  const client = createStoreClient();
  const sessionToken = await client.exchangeCode(
    params.get("session_token_code"),
    pending.verifier,
  );
  const result = await client.collect(sessionToken);
  const key = await readKey();
  await writePrivate(tokenPath, encrypt(sessionToken, key));
  await unlink(pendingPath).catch(() => {});
  printResult(result);
} else if (command === "collect") {
  const key = await readKey();
  const sessionToken = decrypt(await readFile(tokenPath, "utf8"), key);
  printResult(await createStoreClient().collect(sessionToken));
} else {
  throw new Error("usage: start | callback <full callback url> | collect");
}
