import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const privateRoot = join(home, ".local", "share", "gamenote");
const dataDir = join(privateRoot, "data");
const stateDir = join(privateRoot, "state");
const runDir = join(privateRoot, "run");
const secretFile = join(privateRoot, "secrets", "jwt-secret");
const runtimeFile = join(project, ".env.local");
const moonDir = join(home, ".local", "share", "gamenote-moon");
const storeDir = join(home, ".local", "share", "gamenote-store-probe");
const appPidFile = join(runDir, "app.pid.json");
const sidecarPidFile = join(runDir, "moon-sidecar.pid.json");
const appUrl = "http://127.0.0.1:3018";
const action = process.argv[2];

function configuredEnvironment() {
  if (!existsSync(runtimeFile)) throw new Error("缺少 .env.local；请先配置本机路径。");
  const values = {};
  for (const line of readFileSync(runtimeFile, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || Object.hasOwn(values, match[1]))
      throw new Error(".env.local 格式或重复配置有误。");
    values[match[1]] = match[2];
  }
  const database = values.APP_DATABASE_FILE;
  if (
    values.GAMENOTE_LOCAL_RUNTIME !== "1" ||
    !database ||
    !isAbsolute(database) ||
    basename(database) !== "ns2.sqlite" ||
    resolve(database) !== join(dataDir, "ns2.sqlite")
  )
    throw new Error("本地数据库必须固定为 ~/.local/share/gamenote/data/ns2.sqlite。");
  if (values.MOON_SIDECAR_SOCKET_PATH !== join(moonDir, "run", "sidecar.sock"))
    throw new Error("Moon socket 路径不是当前本机固定目录。");
  if (values.MOON_SIDECAR_API_KEY_FILE !== join(moonDir, "secrets", "api-key"))
    throw new Error("Moon 密钥文件路径不是当前本机固定目录。");
  if (!existsSync(values.MOON_SIDECAR_API_KEY_FILE))
    throw new Error("Moon 授权目录不存在；不会创建或覆盖原有授权。");
  if (values.JWT_SECRET || values.NINTENDO_SIDECAR_API_KEY)
    throw new Error("请勿将凭据内容写进 .env.local。");
  return values;
}

function preparePrivateFiles() {
  for (const path of [privateRoot, dataDir, stateDir, runDir, dirname(secretFile)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  if (!existsSync(secretFile))
    writeFileSync(secretFile, randomBytes(48).toString("base64url"), {
      flag: "wx",
      mode: 0o600,
    });
  chmodSync(secretFile, 0o600);
  const secret = readFileSync(secretFile, "utf8").trim();
  if (Buffer.byteLength(secret) < 32) throw new Error("本机 JWT 密钥长度不足。");
  return secret;
}

function appEnvironment(values, secret) {
  return {
    ...process.env,
    ...values,
    JWT_SECRET: secret,
    GAMENOTE_LOCAL_RUNTIME: "1",
    APP_DATABASE_FILE: join(dataDir, "ns2.sqlite"),
    HOSTNAME: "127.0.0.1",
    PORT: "3018",
  };
}

function runNode(script, args, environment) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: project,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${basename(script)} 未完成（退出码 ${result.status}）。`);
}

function dbSummary(file) {
  if (!existsSync(file) || statSync(file).size === 0) return "尚未创建";
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const identity = db
      .prepare("SELECT value FROM app_metadata WHERE key='database_identity'")
      .get()?.value;
    const version = db
      .prepare("SELECT value FROM app_metadata WHERE key='schema_version'")
      .get()?.value;
    if (identity !== "gamenote-ns2" || version !== "6")
      throw new Error("NS2 数据库标识/版本异常。");
    const count = (table) =>
      Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    return `schema v6，历史 ${count("game_entities")} 款，收藏 ${count("purchase_records")} 条，Moon 日报 ${count("moon_connector_reports")} 份，Store 快照 ${count("nintendo_store_game_snapshots")} 条`;
  } finally {
    db.close();
  }
}

async function health(url, options = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200), ...options });
    return response.ok && (await response.json()).status === "ok";
  } catch {
    return false;
  }
}

async function moonHealth(socketPath) {
  if (!existsSync(socketPath)) return false;
  return new Promise((resolveHealth) => {
    const req = httpRequest(
      { socketPath, path: "/healthz", method: "GET", timeout: 1200 },
      (res) => {
        res.resume();
        resolveHealth(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolveHealth(false));
    req.end();
  });
}

function readOwnedPid(file, kind) {
  if (!existsSync(file)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (record?.kind !== kind || record?.project !== project || !Number.isSafeInteger(record.pid))
    return null;
  try {
    process.kill(record.pid, 0);
  } catch {
    return null;
  }
  return record.pid;
}

function spawnOwned(kind, script, args, environment) {
  const log = join(runDir, `${kind}.log`);
  const logFd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: project,
    env: environment,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(
    kind === "app" ? appPidFile : sidecarPidFile,
    JSON.stringify({
      kind,
      pid: child.pid,
      project,
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return child.pid;
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} 未就绪；检查 ~/.local/share/gamenote/run/ 下的日志。`);
}

async function status() {
  const values = configuredEnvironment();
  console.log(`数据库：${dbSummary(values.APP_DATABASE_FILE)}`);
  console.log(`GameNote：${(await health(`${appUrl}/api/health`)) ? `${appUrl} 正常` : "未运行"}`);
  console.log(
    `Moon：${(await moonHealth(values.MOON_SIDECAR_SOCKET_PATH)) ? "采集服务正常" : "采集服务未运行"}`,
  );
  console.log(
    `Moon 授权：${existsSync(join(moonDir, "state", "moon-state.enc")) ? "加密状态文件已保留" : "无加密状态文件"}`,
  );
  console.log(
    `Store 授权：${existsSync(join(storeDir, "session.enc")) ? "加密会话文件已保留" : "无加密会话文件"}`,
  );
}

async function up() {
  const values = configuredEnvironment();
  const secret = preparePrivateFiles();
  const environment = appEnvironment(values, secret);
  if (await health(`${appUrl}/api/health`)) {
    console.log("3018 已运行；不会覆盖现有进程。");
    await status();
    return;
  }
  if (readOwnedPid(appPidFile, "app"))
    throw new Error("先前的 3018 进程还在运行，但健康检查未通过；请先检查日志或停止进程。");

  runNode(join(project, "scripts", "migrate-play-history.mjs"), [], environment);
  chmodSync(values.APP_DATABASE_FILE, 0o600);
  console.log("构建本地正式版…");
  runNode(
    join(project, "node_modules", "next", "dist", "bin", "next"),
    ["build", "--webpack"],
    environment,
  );
  const standalone = join(project, ".next", "standalone");
  cpSync(join(project, ".next", "static"), join(standalone, ".next", "static"), {
    recursive: true,
  });
  if (existsSync(join(project, "public")))
    cpSync(join(project, "public"), join(standalone, "public"), { recursive: true });

  if (!(await moonHealth(values.MOON_SIDECAR_SOCKET_PATH))) {
    if (readOwnedPid(sidecarPidFile, "moon-sidecar"))
      throw new Error("Moon 服务进程仍在但未就绪；请检查日志。");
    spawnOwned(
      "moon-sidecar",
      join(project, "services", "moon-sidecar", "cli.mjs"),
      ["serve", "--directory", moonDir],
      environment,
    );
    await waitFor(() => moonHealth(values.MOON_SIDECAR_SOCKET_PATH), "Moon 采集服务");
  }
  spawnOwned("app", join(standalone, "server.js"), [], environment);
  await waitFor(() => health(`${appUrl}/api/health`), "GameNote 3018");
  console.log("本地空库服务已启动；请在页面注册新的管理员账号，再验收同步。");
  await status();
}

async function down() {
  // Never stop an existing Moon sidecar that was started outside this script.
  for (const [file, kind] of [
    [appPidFile, "app"],
    [sidecarPidFile, "moon-sidecar"],
  ]) {
    const pid = readOwnedPid(file, kind);
    if (!pid) continue;
    const matches =
      kind === "app"
        ? processWorkingDirectory(pid) === join(project, ".next", "standalone")
        : processCommand(pid).includes(join(project, "services", "moon-sidecar", "cli.mjs"));
    if (!matches) {
      console.log(`${kind} PID 已被其他进程使用，不会终止。`);
      continue;
    }
    process.kill(pid, "SIGTERM");
    console.log(`${kind} 已发送安全停止信号。`);
  }
}

function processCommand(pid) {
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  }).stdout.trim();
}

function processWorkingDirectory(pid) {
  const result = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  const pathLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("n"));
  return pathLine?.slice(1) || "";
}

try {
  if (action === "up") await up();
  else if (action === "status" || action === "doctor") {
    if (action === "doctor") {
      const values = configuredEnvironment();
      if ((statSync(runtimeFile).mode & 0o077) !== 0)
        throw new Error(".env.local 必须为 0600，不可被其他用户读取。");
      if (existsSync(secretFile) && (statSync(secretFile).mode & 0o077) !== 0)
        throw new Error("本机 JWT 文件权限必须为 0600。");
      dbSummary(values.APP_DATABASE_FILE);
      console.log("本机路径与权限检查通过。");
    }
    await status();
  } else if (action === "down") await down();
  else throw new Error("用法：node scripts/local-runtime.mjs doctor|up|status|down");
} catch (error) {
  console.error(error instanceof Error ? error.message : "本地运行任务失败。");
  process.exitCode = 1;
}
