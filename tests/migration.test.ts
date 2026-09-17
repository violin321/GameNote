import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getRecords } from "../app/api/records/route";
import { purchaseProjectionHash } from "../scripts/purchase-projection-json.mjs";
import { migratePlayDatabase } from "../lib/play-history/repository";

let directory = "";
afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

describe("schema migration", () => {
  it("keeps canonical hashes, tombstones and confirmed links across repeated up/down", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-migration-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    const activeRecord = {
      title: "Migration Game",
      id: "purchase-active",
      purchaseDate: "2026-08-24",
      coverUrl: "https://example.com/migration.jpg",
      platform: "Nintendo Switch",
    };
    const deletedRecord = {
      platform: "Nintendo Switch 2",
      id: "purchase-deleted",
      title: "Deleted But Linked",
    };
    const db = new DatabaseSync(database);
    db.exec(await readFile(resolve("migrations/001_play_history.sql"), "utf8"));
    db.prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'play_history',?)",
    ).run(new Date().toISOString());
    db.prepare("INSERT INTO ledger_documents(id,records,updated_at) VALUES('default',?,?)").run(
      // Deliberately non-canonical key order: the migration and repository must
      // hash the same recursively key-sorted compact JSON representation.
      JSON.stringify([activeRecord, deletedRecord], null, 2),
      "2026-08-24T00:00:00Z",
    );
    db.close();

    await migratePlayDatabase();
    const firstUp = new DatabaseSync(database);
    expect(
      firstUp
        .prepare(
          "SELECT title,cover_url,purchase_date,platform_family,deleted_at,projection_hash FROM purchase_records WHERE id='purchase-active'",
        )
        .get(),
    ).toEqual({
      title: "Migration Game",
      cover_url: "https://example.com/migration.jpg",
      purchase_date: "2026-08-24",
      platform_family: "Nintendo",
      deleted_at: null,
      projection_hash: purchaseProjectionHash(activeRecord),
    });
    expect(
      firstUp
        .prepare(
          "SELECT COUNT(*) AS count FROM purchase_records WHERE deleted_at IS NULL AND length(projection_hash)=64",
        )
        .get(),
    ).toEqual({ count: 2 });
    const firstHashes = firstUp
      .prepare("SELECT id,projection_hash FROM purchase_records ORDER BY id")
      .all();
    firstUp.close();

    await migratePlayDatabase();
    const idempotent = new DatabaseSync(database);
    expect(
      idempotent.prepare("SELECT id,projection_hash FROM purchase_records ORDER BY id").all(),
    ).toEqual(firstHashes);
    const now = "2026-08-24T01:00:00Z";
    idempotent
      .prepare(
        "INSERT INTO play_games(id,source,external_id,title,normalized_title,first_played_at,last_played_at,created_at,updated_at) VALUES('game-linked','manual','game-linked','Deleted But Linked','deleted but linked',?,?,?,?)",
      )
      .run(now, now, now, now);
    idempotent
      .prepare(
        "INSERT INTO play_purchase_links(id,play_game_id,purchase_record_id,status,match_method,confidence,decided_at,decided_by,created_at,updated_at) VALUES('link','game-linked','purchase-deleted','confirmed','manual',1,?,'admin',?,?)",
      )
      .run(now, now, now);
    idempotent
      .prepare("UPDATE ledger_documents SET records=?,updated_at=? WHERE id='default'")
      .run(JSON.stringify([activeRecord]), now);
    idempotent
      .prepare(
        "UPDATE purchase_records SET deleted_at=?,source_updated_at=? WHERE id='purchase-deleted'",
      )
      .run(now, now);
    const downSql = await readFile(resolve("migrations/002_purchase_projection.down.sql"), "utf8");
    idempotent.exec(await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8"));
    idempotent.exec(
      await readFile(resolve("migrations/005_nintendo_store_history.down.sql"), "utf8"),
    );
    idempotent.exec(await readFile(resolve("migrations/004_nintendo_store.down.sql"), "utf8"));
    idempotent.exec(await readFile(resolve("migrations/003_moon_connector.down.sql"), "utf8"));
    idempotent.exec(downSql);
    idempotent.exec(downSql);
    expect(
      idempotent.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
    ).toEqual({ value: "1" });
    expect(
      idempotent.prepare("SELECT name FROM pragma_table_info('purchase_records')").all(),
    ).toContainEqual({ name: "deleted_at" });
    expect(
      idempotent
        .prepare("SELECT deleted_at FROM purchase_records WHERE id='purchase-deleted'")
        .get(),
    ).toEqual({ deleted_at: now });
    const updatedActiveRecord = { ...activeRecord, title: "Migration Game Updated In V1" };
    idempotent
      .prepare("UPDATE ledger_documents SET records=?,updated_at=? WHERE id='default'")
      .run(JSON.stringify([updatedActiveRecord]), "2026-08-24T02:00:00Z");
    idempotent.close();

    await migratePlayDatabase();
    const repeated = new DatabaseSync(database);
    expect(
      repeated.prepare("SELECT id,deleted_at FROM purchase_records ORDER BY id").all(),
    ).toEqual([
      { id: "purchase-active", deleted_at: null },
      { id: "purchase-deleted", deleted_at: now },
    ]);
    expect(
      repeated
        .prepare("SELECT title,projection_hash FROM purchase_records WHERE id='purchase-active'")
        .get(),
    ).toEqual({
      title: "Migration Game Updated In V1",
      projection_hash: purchaseProjectionHash(updatedActiveRecord),
    });
    expect(
      repeated
        .prepare("SELECT purchase_record_id,status FROM play_purchase_links WHERE id='link'")
        .get(),
    ).toEqual({ purchase_record_id: "purchase-deleted", status: "confirmed" });
    expect(repeated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(repeated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      repeated.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
    ).toEqual({ value: "6" });
    expect(repeated.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 6,
    });
    repeated.close();
  });

  it("upgrades existing v4 copies and protects Store audit history from unsafe downgrade", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-store-history-migration-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();
    const v6Down = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    const v5Down = await readFile(
      resolve("migrations/005_nintendo_store_history.down.sql"),
      "utf8",
    );
    const v4Down = await readFile(resolve("migrations/004_nintendo_store.down.sql"), "utf8");
    const db = new DatabaseSync(database);

    expect(() => db.exec(v4Down)).toThrow(/CHECK constraint/);
    db.exec("ROLLBACK");
    expect(() => db.exec(v6Down)).not.toThrow();
    expect(() => db.exec(v5Down)).not.toThrow();
    expect(() => db.exec(v5Down)).not.toThrow();
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({
      value: "4",
    });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='nintendo_store_daily_history'").get(),
    ).toEqual({ 1: 1 });
    db.close();

    await migratePlayDatabase();
    const protectedCopy = new DatabaseSync(database);
    protectedCopy
      .prepare(
        `INSERT INTO nintendo_store_sync_snapshots(
          id,fetched_at,authentication,payload_sha256,source_title_count,imported_title_count,
          skipped_title_count,imported_daily_count,skipped_daily_count,created_at
        ) VALUES('snapshot-a','2026-09-14T00:00:00Z','access_token',?,0,0,0,0,0,'2026-09-14T00:00:00Z')`,
      )
      .run("a".repeat(64));
    expect(() => protectedCopy.exec(v6Down)).not.toThrow();
    expect(() => protectedCopy.exec(v5Down)).toThrow(/CHECK constraint/);
    protectedCopy.exec("ROLLBACK");
    expect(
      protectedCopy.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
    ).toEqual({ value: "5" });
    expect(
      protectedCopy.prepare("SELECT COUNT(*) AS count FROM nintendo_store_sync_snapshots").get(),
    ).toEqual({ count: 1 });
    protectedCopy.close();
  });

  it("rolls back a failed migration without partially upgrading the v1 copy", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-migration-failure-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    const db = new DatabaseSync(database);
    db.exec(await readFile(resolve("migrations/001_play_history.sql"), "utf8"));
    db.prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'play_history',?)",
    ).run(new Date().toISOString());
    db.prepare("INSERT INTO ledger_documents(id,records,updated_at) VALUES('default',?,?)").run(
      JSON.stringify([{ id: "purchase-failure", title: "Migration Failure" }]),
      "2026-08-24T00:00:00Z",
    );
    db.exec(`CREATE TRIGGER fail_v2_projection
      BEFORE INSERT ON purchase_records
      BEGIN SELECT RAISE(ABORT, 'INJECTED_MIGRATION_FAILURE'); END`);
    db.close();

    await expect(migratePlayDatabase()).rejects.toThrow("INJECTED_MIGRATION_FAILURE");
    const unchanged = new DatabaseSync(database);
    expect(
      unchanged.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
    ).toEqual({ value: "1" });
    expect(
      unchanged.prepare("SELECT name FROM pragma_table_info('purchase_records')").all(),
    ).not.toContainEqual({ name: "deleted_at" });
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    unchanged.close();
  });

  it("rolls back a failed down migration without partially downgrading v2", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-down-failure-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();
    const db = new DatabaseSync(database);
    // Roll back newer migrations first; v5/v4 markers must be removed before
    // the v3 down migration can safely downgrade the schema to v2.
    db.exec(await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8"));
    db.exec(await readFile(resolve("migrations/005_nintendo_store_history.down.sql"), "utf8"));
    db.exec(await readFile(resolve("migrations/004_nintendo_store.down.sql"), "utf8"));
    db.exec(await readFile(resolve("migrations/003_moon_connector.down.sql"), "utf8"));
    db.exec(`CREATE TRIGGER fail_projection_down
      BEFORE DELETE ON schema_migrations
      WHEN OLD.version = 2
      BEGIN SELECT RAISE(ABORT, 'INJECTED_DOWN_FAILURE'); END`);
    const downSql = await readFile(resolve("migrations/002_purchase_projection.down.sql"), "utf8");
    expect(() => db.exec(downSql)).toThrow("INJECTED_DOWN_FAILURE");
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({
      value: "2",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 2,
    });
    db.exec("ROLLBACK");
    db.exec("DROP TRIGGER fail_projection_down");
    expect(() => db.exec(downSql)).not.toThrow();
    db.close();
  });

  it("does not run migration from the purchase ledger GET path", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-get-no-migration-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    const db = new DatabaseSync(database);
    db.exec(await readFile(resolve("migrations/001_play_history.sql"), "utf8"));
    db.prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,'play_history',?)",
    ).run(new Date().toISOString());
    db.close();

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await getRecords(new Request("http://localhost/api/records") as never);
    consoleError.mockRestore();
    expect(response.status).toBe(500);
    const unchanged = new DatabaseSync(database);
    expect(
      unchanged.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get(),
    ).toEqual({ value: "1" });
    expect(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: 1,
    });
    unchanged.close();
  });
});
