import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storeProbeDirectory } from "./nintendo-store-probe/auth.mjs";
import { initializeDirectory, loadInstallation } from "../services/moon-sidecar/security.mjs";

const applicationRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const moonCli = join(applicationRoot, "services/moon-sidecar/cli.mjs");

export async function prepareContainerServices(environment = process.env) {
  const directory = environment.MOON_SIDECAR_DIRECTORY || "/data/moon";
  const socketPath = join(directory, "run/sidecar.sock");
  const apiKeyFile = join(directory, "secrets/api-key");
  if (
    !isAbsolute(directory) ||
    environment.MOON_SIDECAR_SOCKET_PATH !== socketPath ||
    environment.MOON_SIDECAR_API_KEY_FILE !== apiKeyFile ||
    (environment.MOON_AUTO_SYNC_ENABLED === "1" &&
      environment.MOON_SCHEDULER_STATE_FILE !== join(directory, "state/app-scheduler.sqlite"))
  )
    throw new Error("moon_container_configuration_invalid");

  // Only a genuinely new volume is initialized. A damaged or incomplete
  // installation must fail closed rather than silently replace its keys.
  try {
    await lstat(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await initializeDirectory(directory);
  }
  await loadInstallation(directory);

  const storeDirectory = storeProbeDirectory(environment);
  if (
    !isAbsolute(environment.NINTENDO_STORE_PROBE_DIR || "") ||
    (environment.NINTENDO_STORE_AUTO_SYNC_ENABLED === "1" &&
      environment.NINTENDO_STORE_SCHEDULER_STATE_FILE !== join(storeDirectory, "scheduler.sqlite"))
  )
    throw new Error("store_container_configuration_invalid");
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  const storeStat = await lstat(storeDirectory);
  if (
    !storeStat.isDirectory() ||
    storeStat.isSymbolicLink() ||
    (storeStat.mode & 0o077) !== 0 ||
    storeStat.uid !== process.getuid?.()
  )
    throw new Error("store_container_directory_unsafe");
  return { directory, socketPath };
}

export function moonHealth(socketPath, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: "/healthz", method: "GET" }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

function childExit(child) {
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function waitForMoon(socketPath, sidecarExit) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await moonHealth(socketPath)) return true;
    const exited = await Promise.race([
      sidecarExit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    if (exited) return false;
  }
  return false;
}

export async function runContainer(command, environment = process.env) {
  if (!command.length) throw new Error("container_command_missing");
  const { directory, socketPath } = await prepareContainerServices(environment);
  const children = new Set();
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    const moon = spawn(process.execPath, [moonCli, "serve", "--directory", directory], {
      stdio: "inherit",
      env: environment,
    });
    children.add(moon);
    const sidecarExit = childExit(moon);
    if (!(await waitForMoon(socketPath, sidecarExit))) {
      console.error("moon_container_start_failed");
      return stopping ? 0 : 1;
    }
    if (stopping) return 0;

    const web = spawn(command[0], command.slice(1), { stdio: "inherit", env: environment });
    children.add(web);
    const webExit = childExit(web);
    const first = await Promise.race([
      sidecarExit.then((code) => ({ service: "moon", code })),
      webExit.then((code) => ({ service: "web", code })),
    ]);
    if (first.service === "moon" && !stopping) console.error("moon_container_exited");
    return stopping ? 0 : first.service === "moon" ? 1 : first.code;
  } finally {
    stop();
    // A child which ignores TERM must not keep the container alive indefinitely.
    const killTimer = setTimeout(() => {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    try {
      await Promise.all([...children].map((child) => childExitOrClosed(child)));
    } finally {
      clearTimeout(killTimer);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    }
  }
}

function childExitOrClosed(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runContainer(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const code =
        typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : typeof error?.code === "string" && /^moon_[a-z_]+$/.test(error.code)
            ? error.code
            : "container_start_failed";
      console.error(code);
      process.exitCode = 1;
    },
  );
}
