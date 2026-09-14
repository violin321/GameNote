import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export class MoonError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function safeError(error) {
  return error instanceof MoonError ? error : new MoonError("moon_internal_error", 500);
}

export function equalSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new MoonError("unsafe_runtime_directory", 500);
  }
  if ((stat.mode & 0o077) !== 0) {
    if (!create) throw new MoonError("unsafe_runtime_directory", 500);
    await chmod(path, 0o700);
  }
}

export async function readPrivateFile(path, maximum = 10 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      stat.size > maximum
    ) {
      throw new MoonError("unsafe_private_file", 500);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function createKey(path) {
  const key = randomBytes(32).toString("base64url");
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(key + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}

function assertAbsoluteDirectory(path) {
  if (!isAbsolute(path)) throw new MoonError("absolute_directory_required", 400);
}

function directoryPaths(directory, ipcDirectory = directory) {
  assertAbsoluteDirectory(directory);
  assertAbsoluteDirectory(ipcDirectory);
  return {
    privateDirectory: directory,
    ipcDirectory,
    privateSecrets: join(directory, "secrets"),
    privateState: join(directory, "state"),
    ipcSecrets: join(ipcDirectory, "secrets"),
    ipcRun: join(ipcDirectory, "run"),
  };
}

async function ensureDirectories(paths) {
  await privateDirectory(paths.privateDirectory, true);
  await privateDirectory(paths.ipcDirectory, true);
  for (const path of new Set([
    paths.privateSecrets,
    paths.privateState,
    paths.ipcSecrets,
    paths.ipcRun,
  ]))
    await privateDirectory(path, true);
}

function keyPath(paths, name) {
  return name === "api-key" ? join(paths.ipcSecrets, name) : join(paths.privateSecrets, name);
}

async function readKey(path) {
  const text = (await readPrivateFile(path, 256)).toString("utf8").trim();
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(text) ||
    Buffer.from(text, "base64url").toString("base64url") !== text
  ) {
    throw new MoonError("invalid_private_key", 500);
  }
  return text;
}

export async function initializeDirectory(directory, options = {}) {
  const paths = directoryPaths(directory, options.ipcDirectory || directory);
  await ensureDirectories(paths);
  // Exclusive creation never overwrites an existing installation's keys.
  for (const name of ["api-key", "master-key", "installation-key"]) {
    const path = keyPath(paths, name);
    try {
      await createKey(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  await loadInstallation(directory, { ipcDirectory: paths.ipcDirectory });
  return {
    socketPath: join(paths.ipcRun, "sidecar.sock"),
    apiKeyFile: join(paths.ipcSecrets, "api-key"),
  };
}

export async function loadInstallation(directory, options = {}) {
  const paths = directoryPaths(directory, options.ipcDirectory || directory);
  await privateDirectory(paths.privateDirectory);
  await privateDirectory(paths.ipcDirectory);
  for (const path of new Set([
    paths.privateSecrets,
    paths.privateState,
    paths.ipcSecrets,
    paths.ipcRun,
  ]))
    await privateDirectory(path);
  const values = await Promise.all(
    ["api-key", "master-key", "installation-key"].map((name) => readKey(keyPath(paths, name))),
  );
  if (new Set(values).size !== 3) throw new MoonError("private_key_reuse", 500);
  return {
    directory: paths.privateDirectory,
    ipcDirectory: paths.ipcDirectory,
    apiKey: values[0],
    masterKey: Buffer.from(values[1], "base64url"),
    installationKey: Buffer.from(values[2], "base64url"),
    socketPath: join(paths.ipcRun, "sidecar.sock"),
    apiKeyFile: join(paths.ipcSecrets, "api-key"),
  };
}

const STATE_AAD = Buffer.from("gamenote.moon.encrypted-state.v1");

export function createEncryptedStore(installation) {
  const path = join(installation.directory, "state", "moon-state.enc");
  return {
    async load() {
      let content;
      try {
        content = await readPrivateFile(path);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      try {
        const envelope = JSON.parse(content.toString("utf8"));
        if (envelope.version !== 1) throw new Error("version");
        const iv = Buffer.from(envelope.iv, "base64url");
        const tag = Buffer.from(envelope.tag, "base64url");
        if (iv.length !== 12 || tag.length !== 16) throw new Error("envelope");
        const decipher = createDecipheriv("aes-256-gcm", installation.masterKey, iv);
        decipher.setAAD(STATE_AAD);
        decipher.setAuthTag(tag);
        const json = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64url")),
          decipher.final(),
        ]);
        return JSON.parse(json.toString("utf8"));
      } catch {
        throw new MoonError("moon_state_unreadable", 500);
      }
    },
    async save(state) {
      const json = Buffer.from(JSON.stringify(state));
      if (json.length > 6 * 1024 * 1024) throw new MoonError("moon_state_too_large", 500);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", installation.masterKey, iv);
      cipher.setAAD(STATE_AAD);
      const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: encrypted.toString("base64url"),
      });
      const temporary = join(
        installation.directory,
        "state",
        `.moon-state-${randomBytes(12).toString("hex")}.tmp`,
      );
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(envelope);
        await file.sync();
        await file.close();
        await rename(temporary, path);
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}
