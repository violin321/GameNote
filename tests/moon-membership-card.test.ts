import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readMoonMembershipStatus } from "../features/moon/moon-membership-card";

let directory = "";

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = "";
});

describe("Moon membership status", () => {
  it("counts overlapping legacy and automatic reports once per official date", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-moon-card-"));
    const databaseFile = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = databaseFile;

    const db = new DatabaseSync(databaseFile);
    db.exec(`
      CREATE TABLE moon_daily_reports (official_date TEXT NOT NULL);
      CREATE TABLE moon_auto_daily (official_date TEXT NOT NULL);
      INSERT INTO moon_daily_reports VALUES ('2026-09-10'), ('2026-09-11');
      INSERT INTO moon_auto_daily VALUES ('2026-09-10'), ('2026-09-11'), ('2026-09-12');
    `);
    db.close();

    expect(readMoonMembershipStatus()).toEqual({
      connected: true,
      reportCount: 3,
      latestDate: "2026-09-12",
    });
  });
});
