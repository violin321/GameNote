import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moonHealth, prepareContainerServices } from "../scripts/container-runtime.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function environment() {
  // Unix-domain socket paths are short on macOS; the host's tmpdir may be long.
  const root = await mkdtemp("/tmp/gamenote-container-");
  directories.push(root);
  const moon = join(root, "moon");
  return {
    ...process.env,
    MOON_SIDECAR_DIRECTORY: moon,
    MOON_SIDECAR_SOCKET_PATH: join(moon, "run/sidecar.sock"),
    MOON_SIDECAR_API_KEY_FILE: join(moon, "secrets/api-key"),
    NINTENDO_STORE_PROBE_DIR: join(root, "store"),
  };
}

describe("single-image container services", () => {
  it("packages both services and points them at the persistent volume", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const entrypoint = await readFile("docker-entrypoint.sh", "utf8");
    expect(dockerfile).toContain("/app/services/moon-sidecar ./services/moon-sidecar");
    expect(dockerfile).toContain("ENV NINTENDO_STORE_PROBE_DIR=/data/nintendo-store");
    expect(dockerfile).toContain("ENV MOON_SIDECAR_SOCKET_PATH=/data/moon/run/sidecar.sock");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(entrypoint).toContain('exec node scripts/container-runtime.mjs "$@"');
  });

  it("initializes one private installation and never replaces its keys on restart", async () => {
    const env = await environment();
    await prepareContainerServices(env);
    const key = await readFile(env.MOON_SIDECAR_API_KEY_FILE, "utf8");
    expect((await stat(env.MOON_SIDECAR_DIRECTORY)).mode & 0o777).toBe(0o700);
    expect((await stat(env.NINTENDO_STORE_PROBE_DIR)).mode & 0o777).toBe(0o700);
    await writeFile(join(env.MOON_SIDECAR_DIRECTORY, "state/moon-state.enc"), "fixture", {
      mode: 0o600,
    });
    await prepareContainerServices(env);
    expect(await readFile(env.MOON_SIDECAR_API_KEY_FILE, "utf8")).toBe(key);
    expect(await readFile(join(env.MOON_SIDECAR_DIRECTORY, "state/moon-state.enc"), "utf8")).toBe(
      "fixture",
    );
  });

  it("fails closed on an incomplete pre-existing Moon directory", async () => {
    const env = await environment();
    await mkdir(env.MOON_SIDECAR_DIRECTORY, { mode: 0o700 });
    await expect(prepareContainerServices(env)).rejects.toThrow();
    await expect(stat(env.MOON_SIDECAR_API_KEY_FILE)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("starts Moon before Web, propagates Web exit, and stops Moon", async () => {
    const env = await environment();
    const child = spawn(
      process.execPath,
      ["scripts/container-runtime.mjs", process.execPath, "-e", "process.exit(7)"],
      { cwd: process.cwd(), env, stdio: "ignore" },
    );
    const exit = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("container runtime timed out")), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      child.once("error", reject);
    });
    expect(exit).toBe(7);
    expect(await moonHealth(env.MOON_SIDECAR_SOCKET_PATH)).toBe(false);
  });
});
