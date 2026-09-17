import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPurchaseProjectionSqlFunctions } from "../scripts/purchase-projection-json.mjs";
import { migratePlayDatabase, verifyPlayDatabaseHealth } from "../lib/play-history/repository";
import { importMoonSnapshot } from "../lib/moon/import";

let directory = "";
let path = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-moon-migration-"));
  path = join(directory, "ns2.sqlite");
  process.env.APP_DATABASE_FILE = path;
});
afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

async function seedV2() {
  const db = new DatabaseSync(path);
  registerPurchaseProjectionSqlFunctions(db);
  db.exec(await readFile(resolve("migrations/001_play_history.sql"), "utf8"));
  db.exec(await readFile(resolve("migrations/002_purchase_projection.sql"), "utf8"));
  db.exec(`INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'play_history','2026-09-11'),(2,'purchase_projection','2026-09-11');
    ALTER TABLE play_games ADD COLUMN custom_note TEXT NOT NULL DEFAULT 'keep';
    CREATE INDEX custom_play_note ON play_games(custom_note);
    CREATE TABLE migration_audit (game_id TEXT);
    CREATE TRIGGER custom_play_update AFTER UPDATE ON play_games BEGIN INSERT INTO migration_audit(game_id) VALUES(NEW.id); END;
    INSERT INTO play_games(id,source,external_id,title,normalized_title,first_played_at,last_played_at,created_at,updated_at,custom_note)
      VALUES('game-old','manual','external-old','Existing game','existing game','2026-09-11','2026-09-11','2026-09-11','2026-09-11','user note');
    INSERT INTO purchase_records(id,title,normalized_title,raw_json,imported_at) VALUES('purchase-old','Existing game','existing game','{}','2026-09-11');
    INSERT INTO play_sessions(id,game_id,source,external_id,started_at,ended_at,duration_seconds,imported_at)
      VALUES('session-old','game-old','manual','session-external','2026-09-11T00:00:00Z','2026-09-11T01:00:00Z',3600,'2026-09-11');
    INSERT INTO play_observations(id,game_id,observed_at,total_seconds,source,created_at)
      VALUES('observation-old','game-old','2026-09-11T01:00:00Z',3600,'manual','2026-09-11');
    INSERT INTO play_purchase_links(id,play_game_id,purchase_record_id,status,match_method,confidence,decided_by,created_at,updated_at)
      VALUES('link-old','game-old','purchase-old','confirmed','manual',1,'owner','2026-09-11','2026-09-11');
    CREATE TABLE moon_daily_reports (legacy_id TEXT PRIMARY KEY, official_date TEXT);
    INSERT INTO moon_daily_reports VALUES('legacy-report','2026-08-31');`);
  db.close();
}

function assertPreserved(db: DatabaseSync) {
  expect(db.prepare("SELECT id,custom_note FROM play_games").all()).toEqual([
    { id: "game-old", custom_note: "user note" },
  ]);
  expect(db.prepare("SELECT id,game_id,duration_seconds FROM play_sessions").all()).toEqual([
    { id: "session-old", game_id: "game-old", duration_seconds: 3600 },
  ]);
  expect(db.prepare("SELECT id,game_id FROM play_observations").all()).toEqual([
    { id: "observation-old", game_id: "game-old" },
  ]);
  expect(
    db
      .prepare(
        "SELECT id,play_game_id,purchase_record_id,status,decided_by FROM play_purchase_links",
      )
      .all(),
  ).toEqual([
    {
      id: "link-old",
      play_game_id: "game-old",
      purchase_record_id: "purchase-old",
      status: "confirmed",
      decided_by: "owner",
    },
  ]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('custom_play_note','custom_play_update') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "custom_play_note" }, { name: "custom_play_update" }]);
  expect(db.prepare("SELECT * FROM moon_daily_reports").all()).toEqual([
    { legacy_id: "legacy-report", official_date: "2026-08-31" },
  ]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({
    value: "6",
  });
  expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='play_games'").get()?.sql).toContain(
    "'moon_connector'",
  );
  expect(db.prepare("SELECT name FROM schema_migrations ORDER BY version").all()).toEqual([
    { name: "play_history" },
    { name: "purchase_projection" },
    { name: "moon_connector" },
    { name: "nintendo_store" },
    { name: "nintendo_store_history" },
    { name: "game_entities" },
  ]);
  db.prepare("UPDATE play_games SET title='Updated' WHERE id='game-old'").run();
  expect(db.prepare("SELECT game_id FROM migration_audit").all()).toEqual([
    { game_id: "game-old" },
  ]);
}

async function seedLegacyMoonArtifactV3() {
  await seedV2();
  const db = new DatabaseSync(path);
  try {
    db.exec(`INSERT INTO schema_migrations(version,name,applied_at)
      VALUES(3,'moon_artifact_v1','2026-09-11');
      UPDATE app_metadata SET value='3' WHERE key='schema_version';`);
  } finally {
    db.close();
  }
}

describe("Moon schema v3 safety", () => {
  it.each(["repository", "startup CLI"])(
    "upgrades a deployment-specific v3 Moon artifact with the %s migration path",
    async (migrationPath) => {
      await seedLegacyMoonArtifactV3();
      if (migrationPath === "repository") {
        await migratePlayDatabase();
        await migratePlayDatabase();
      } else {
        const run = () =>
          promisify(execFile)(process.execPath, ["scripts/migrate-play-history.mjs"], {
            cwd: process.cwd(),
            env: { ...process.env, APP_DATABASE_FILE: path },
          });
        await run();
        await run();
      }
      await verifyPlayDatabaseHealth();

      const db = new DatabaseSync(path);
      try {
        expect(db.prepare("SELECT name FROM schema_migrations WHERE version=3").get()).toEqual({
          name: "moon_artifact_v1",
        });
        expect(
          db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
        ).toEqual({
          value: "6",
        });
        const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='play_games'").get()
          ?.sql as string;
        expect(schema).toContain("'moon_connector'");
        expect(schema).toContain("'nintendo_store'");
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name='moon_connector_accounts'").get(),
        ).toEqual({ name: "moon_connector_accounts" });
        expect(
          db.prepare("SELECT id,custom_note FROM play_games WHERE id='game-old'").get(),
        ).toEqual({
          id: "game-old",
          custom_note: "user note",
        });
        expect(db.prepare("SELECT id,play_game_id FROM play_purchase_links").get()).toEqual({
          id: "link-old",
          play_game_id: "game-old",
        });
        expect(db.prepare("SELECT * FROM moon_daily_reports").all()).toEqual([
          { legacy_id: "legacy-report", official_date: "2026-08-31" },
        ]);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        db.close();
      }
    },
  );

  it("preserves child rows, manual associations, custom columns/indexes/triggers and legacy Moon data", async () => {
    await seedV2();
    await migratePlayDatabase();
    await migratePlayDatabase();
    await verifyPlayDatabaseHealth();
    const db = new DatabaseSync(path);
    try {
      assertPreserved(db);
    } finally {
      db.close();
    }
  });

  it("uses the same safe migration path in the startup CLI", async () => {
    await seedV2();
    const result = await promisify(execFile)(
      process.execPath,
      ["scripts/migrate-play-history.mjs"],
      {
        cwd: process.cwd(),
        env: { ...process.env, APP_DATABASE_FILE: path },
      },
    );
    expect(result.stdout).toContain("schema v6");
    const db = new DatabaseSync(path);
    try {
      assertPreserved(db);
    } finally {
      db.close();
    }
  });

  it("rolls the table replacement back if foreign-key checking finds an orphan", async () => {
    await seedV2();
    const db = new DatabaseSync(path);
    db.exec(
      "PRAGMA foreign_keys=OFF; UPDATE play_sessions SET game_id='missing' WHERE id='session-old'",
    );
    db.close();
    await expect(migratePlayDatabase()).rejects.toThrow("invalid foreign keys");
    const unchanged = new DatabaseSync(path);
    try {
      expect(
        unchanged.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
      ).toEqual({ value: "2" });
      expect(
        unchanged.prepare("SELECT sql FROM sqlite_master WHERE name='play_games'").get()?.sql,
      ).not.toContain("moon_connector");
      expect(unchanged.prepare("SELECT id,game_id FROM play_sessions").get()).toEqual({
        id: "session-old",
        game_id: "missing",
      });
      expect(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name='moon_connector_accounts'").get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it("supports repeated empty down/up without dropping user data", async () => {
    await seedV2();
    await migratePlayDatabase();
    const db = new DatabaseSync(path);
    const down = await readFile(resolve("migrations/003_moon_connector.down.sql"), "utf8");
    db.exec(await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8"));
    db.exec(await readFile(resolve("migrations/005_nintendo_store_history.down.sql"), "utf8"));
    db.exec(await readFile(resolve("migrations/004_nintendo_store.down.sql"), "utf8"));
    db.exec(down);
    db.exec(down);
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({
      value: "2",
    });
    db.close();
    await migratePlayDatabase();
    const restored = new DatabaseSync(path);
    try {
      assertPreserved(restored);
    } finally {
      restored.close();
    }
  });

  it("refuses downgrade with imported Moon state instead of deleting it or silently misreading aggregates", async () => {
    await migratePlayDatabase();
    await importMoonSnapshot({
      schema: "gamenote.moon.daily.v1",
      fetchedAt: "2026-09-12T00:00:00Z",
      accountScope: "account-a",
      devices: [],
      dailyReports: [],
    });
    const down = await readFile(resolve("migrations/003_moon_connector.down.sql"), "utf8");
    const db = new DatabaseSync(path);
    try {
      db.exec(await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8"));
      db.exec(await readFile(resolve("migrations/005_nintendo_store_history.down.sql"), "utf8"));
      db.exec(await readFile(resolve("migrations/004_nintendo_store.down.sql"), "utf8"));
      expect(() => db.exec(down)).toThrow(/CHECK constraint/);
      db.exec("ROLLBACK");
      expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual(
        { value: "3" },
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM moon_connector_accounts").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });
});
