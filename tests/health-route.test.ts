import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/health/route";
import { migratePlayDatabase } from "../lib/play-history/repository";

let directory = "";
let database = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-health-"));
  database = join(directory, "ns2.sqlite");
  vi.stubEnv("APP_DATABASE_FILE", database);
  vi.stubEnv("JWT_SECRET", "h".repeat(32));
  await migratePlayDatabase();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("health endpoint", () => {
  it("reports healthy only with a strong secret and valid NS2 marker/schema", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("fails closed without exposing configuration or database details", async () => {
    vi.stubEnv("JWT_SECRET", "too-short");
    let response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unhealthy" });

    vi.stubEnv("JWT_SECRET", "h".repeat(32));
    const db = new DatabaseSync(database);
    db.prepare("UPDATE app_metadata SET value='wrong' WHERE key='database_identity'").run();
    db.close();
    response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unhealthy" });
  });
});
