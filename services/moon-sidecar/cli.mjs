import { resolve } from "node:path";
import {
  initializeDirectory,
  loadInstallation,
  createEncryptedStore,
  safeError,
  MoonError,
} from "./security.mjs";
import { createMoonRuntime } from "./runtime.mjs";
import { createMoonServer, listenUnix } from "./server.mjs";

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!["init", "serve"].includes(command))
    throw new MoonError("usage_init_or_serve_directory", 400);
  let directory;
  let ipcDirectory;
  let schedulerEnabled = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--directory" && !directory) {
      directory = args[++index];
      if (!directory) throw new MoonError("usage_init_or_serve_directory", 400);
    } else if (args[index] === "--ipc-directory" && !ipcDirectory) {
      ipcDirectory = args[++index];
      if (!ipcDirectory) throw new MoonError("usage_init_or_serve_directory", 400);
    } else if (args[index] === "--scheduler" && command === "serve") schedulerEnabled = true;
    else throw new MoonError("usage_init_or_serve_directory", 400);
  }
  directory = resolve(
    directory || process.env.MOON_RUNTIME_DIR?.trim() || ".gamenote-private/moon",
  );
  ipcDirectory = resolve(ipcDirectory || process.env.MOON_IPC_DIRECTORY?.trim() || directory);
  if (schedulerEnabled && process.env.MOON_AUTO_SYNC_ENABLED === "1")
    throw new MoonError("moon_dual_scheduler_forbidden", 500);
  process.umask(0o077);
  if (command === "init") {
    const paths = await initializeDirectory(directory, { ipcDirectory });
    process.stdout.write(JSON.stringify({ initialized: true, ...paths }) + "\n");
    return;
  }
  const installation = await loadInstallation(directory, { ipcDirectory });
  const runtime = await createMoonRuntime({
    store: createEncryptedStore(installation),
    installationKey: installation.installationKey,
    schedulerEnabled,
  });
  const server = createMoonServer(runtime, installation.apiKey);
  await listenUnix(server, installation.socketPath);
  process.stdout.write(
    JSON.stringify({ status: "ready", socketPath: installation.socketPath, schedulerEnabled }) +
      "\n",
  );
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: safeError(error).code }) + "\n");
  process.exitCode = 1;
});
