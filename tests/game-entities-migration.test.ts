import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePlayGameEntityBinding,
  resolveGameEntityId,
  upsertGameEntityPurchaseLink,
} from "../lib/play-history/entities";
import { migratePlayDatabase } from "../lib/play-history/repository";

let directory = "";

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("game entity schema migration", () => {
  it("allocates opaque, disjoint identities on the first V5 to V6 upgrade", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-first-up-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE game_entity_acquisitions;
      DROP TABLE game_entity_purchase_links;
      DROP TABLE source_bindings;
      DROP TABLE game_entity_aliases;
      DROP TABLE game_entities;
    `);
    const now = "2026-09-15T00:00:00.000Z";
    const firstTitleId = "0100FIRST0000001";
    seedPlayGame(db, now, {
      id: "first-strong",
      title: "First Store",
      titleId: firstTitleId,
      source: "nintendo_store",
    });
    seedPlayGame(db, now, {
      id: "first-strong-moon",
      title: "First Moon",
      titleId: firstTitleId,
      source: "moon_connector",
    });
    seedPlayGame(db, now, { id: "first-weak", title: "First Weak" });
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    try {
      const rows = migrated
        .prepare(
          `SELECT binding.play_game_id,binding.entity_id,entity.strong_key
           FROM source_bindings binding
           JOIN game_entities entity ON entity.id=binding.entity_id
           ORDER BY binding.play_game_id`,
        )
        .all() as Array<{ play_game_id: string; entity_id: string; strong_key: string | null }>;
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        play_game_id: "first-strong",
        strong_key: "title-id:nintendo:0100first0000001",
      });
      expect(rows[1]).toMatchObject({
        play_game_id: "first-strong-moon",
        entity_id: rows[0].entity_id,
        strong_key: "title-id:nintendo:0100first0000001",
      });
      expect(rows[2]).toMatchObject({ play_game_id: "first-weak", strong_key: null });
      expect(rows[0].entity_id).toMatch(/^game-entity:opaque:[0-9a-f]{32}$/);
      expect(rows[2].entity_id).toMatch(/^game-entity:opaque:[0-9a-f]{32}$/);
      expect(rows[0].entity_id).not.toBe(rows[2].entity_id);
      expect(rows[0].entity_id).not.toContain(rows[0].strong_key || "");
      expect(
        migrated
          .prepare("SELECT canonical_title,title_id FROM game_entities WHERE id=?")
          .get(rows[0].entity_id),
      ).toEqual({ canonical_title: "First Store", title_id: firstTitleId });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }
  });

  it("keeps a matching strong title ID when the highest-priority binding clears it", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-title-id-refresh-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    db.exec("PRAGMA foreign_keys=ON");
    const now = "2026-09-15T00:00:00.000Z";
    const titleA = "0100METADATAA0001";
    seedPlayGame(db, now, {
      id: "metadata-store",
      title: "Store Canonical Title",
      titleId: titleA,
      source: "nintendo_store",
    });
    seedPlayGame(db, now, {
      id: "metadata-moon",
      title: "Moon Fallback Title",
      titleId: titleA,
      source: "moon_connector",
    });
    const entityId = ensurePlayGameEntityBinding(db, "metadata-store", now);
    expect(ensurePlayGameEntityBinding(db, "metadata-moon", now)).toBe(entityId);

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.prepare("UPDATE play_games SET title_id=NULL,updated_at=? WHERE id='metadata-store'").run(
      "2026-09-15T01:00:00.000Z",
    );
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    try {
      expect(
        migrated
          .prepare(
            `SELECT id,strong_key,title_id,canonical_title
             FROM game_entities WHERE id=?`,
          )
          .get(entityId),
      ).toEqual({
        id: entityId,
        strong_key: `title-id:nintendo:${titleA.toLowerCase()}`,
        title_id: titleA,
        canonical_title: "Store Canonical Title",
      });
      expect(
        migrated
          .prepare("SELECT COUNT(*) AS count FROM source_bindings WHERE entity_id=?")
          .get(entityId),
      ).toEqual({ count: 2 });
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }

    const stale = new DatabaseSync(database);
    stale.prepare("UPDATE game_entities SET title_id=NULL WHERE id=?").run(entityId);
    stale.close();
    await migratePlayDatabase();
    const reconciled = new DatabaseSync(database);
    try {
      expect(
        reconciled
          .prepare("SELECT strong_key,title_id,canonical_title FROM game_entities WHERE id=?")
          .get(entityId),
      ).toEqual({
        strong_key: `title-id:nintendo:${titleA.toLowerCase()}`,
        title_id: titleA,
        canonical_title: "Store Canonical Title",
      });
    } finally {
      reconciled.close();
    }
  });

  it("reconciles a V5 title identity and collection decision on re-up", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-reup-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    db.exec("PRAGMA foreign_keys=ON");
    const now = "2026-09-15T00:00:00.000Z";
    const titleA = "0100AUDITA000001";
    const titleB = "0100AUDITB000001";
    seedPlayGame(db, now, { titleId: titleA });
    seedPurchase(db, "purchase-before", now);
    seedPurchase(db, "purchase-after", now);
    ensurePlayGameEntityBinding(db, "game-a", now);
    const originalEntityId = String(
      db.prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='game-a'").get()
        ?.entity_id,
    );
    upsertGameEntityPurchaseLink(db, {
      entityId: originalEntityId,
      purchase_record_id: "purchase-before",
      status: "confirmed",
      match_method: "manual",
      confidence: 1,
      decided_at: now,
      decided_by: "audit",
      updated_at: now,
    });

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id='game-a'").run(
      titleB,
      "2026-09-15T01:00:00.000Z",
    );
    seedPlayGame(db, "2026-09-15T01:00:00.000Z", {
      id: "game-new-a",
      title: "Audit Game A Again",
      titleId: titleA,
    });
    db.prepare(
      `UPDATE play_purchase_links SET purchase_record_id=?,updated_at=?,decided_at=?
       WHERE play_game_id='game-a'`,
    ).run("purchase-after", "2026-09-15T01:00:00.000Z", "2026-09-15T01:00:00.000Z");
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    let newAEntityId = "";
    try {
      expect(
        migrated.prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='game-a'").get(),
      ).toEqual({ entity_id: originalEntityId });
      const newAEntity = migrated
        .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='game-new-a'")
        .get() as { entity_id: string };
      newAEntityId = newAEntity.entity_id;
      expect(newAEntity.entity_id).not.toBe(originalEntityId);
      expect(
        migrated.prepare("SELECT id,strong_key FROM game_entities ORDER BY strong_key").all(),
      ).toEqual([
        {
          id: newAEntity.entity_id,
          strong_key: `title-id:nintendo:${titleA.toLowerCase()}`,
        },
        {
          id: originalEntityId,
          strong_key: `title-id:nintendo:${titleB.toLowerCase()}`,
        },
      ]);
      expect(resolveGameEntityId(migrated, originalEntityId)).toBe(originalEntityId);
      expect(
        migrated
          .prepare(
            `SELECT purchase_record_id,status FROM game_entity_purchase_links
             WHERE entity_id=?`,
          )
          .get(originalEntityId),
      ).toEqual({ purchase_record_id: "purchase-after", status: "confirmed" });
      expect(
        migrated
          .prepare(
            `SELECT purchase_record_id FROM game_entity_acquisitions
             WHERE entity_id=? ORDER BY purchase_record_id`,
          )
          .all(originalEntityId),
      ).toEqual([{ purchase_record_id: "purchase-after" }]);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }

    await migratePlayDatabase();
    const repeated = new DatabaseSync(database);
    try {
      expect(
        repeated.prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='game-a'").get(),
      ).toEqual({ entity_id: originalEntityId });
      expect(repeated.prepare("SELECT COUNT(*) AS count FROM game_entities").get()).toEqual({
        count: 2,
      });
      expect(repeated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(repeated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      repeated.exec(downSql);
    } finally {
      repeated.close();
    }

    await migratePlayDatabase();
    const cycled = new DatabaseSync(database);
    try {
      expect(
        cycled
          .prepare("SELECT play_game_id,entity_id FROM source_bindings ORDER BY play_game_id")
          .all(),
      ).toEqual([
        { play_game_id: "game-a", entity_id: originalEntityId },
        { play_game_id: "game-new-a", entity_id: newAEntityId },
      ]);
      expect(cycled.prepare("SELECT COUNT(*) AS count FROM game_entities").get()).toEqual({
        count: 2,
      });
      expect(cycled.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(cycled.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      cycled.close();
    }
  });

  it("does not copy an unchanged collection projection onto a split sibling", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-sibling-split-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    db.exec("PRAGMA foreign_keys=ON");
    const now = "2026-09-15T00:00:00.000Z";
    const titleA = "0100SIBLINGA00001";
    const titleB = "0100SIBLINGB00001";
    seedPlayGame(db, now, { id: "sibling-a", title: "Sibling A", titleId: titleA });
    seedPlayGame(db, now, { id: "sibling-b", title: "Sibling B", titleId: titleA });
    seedPurchase(db, "purchase-sibling", now);
    const originalEntityId = ensurePlayGameEntityBinding(db, "sibling-a", now);
    expect(ensurePlayGameEntityBinding(db, "sibling-b", now)).toBe(originalEntityId);
    upsertGameEntityPurchaseLink(db, {
      entityId: originalEntityId,
      purchase_record_id: "purchase-sibling",
      status: "confirmed",
      match_method: "manual",
      confidence: 1,
      decided_at: now,
      decided_by: "audit",
      updated_at: now,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM play_purchase_links").get()).toEqual({
      count: 2,
    });

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id='sibling-b'").run(
      titleB,
      "2026-09-15T01:00:00.000Z",
    );
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    try {
      const bindings = migrated
        .prepare("SELECT play_game_id,entity_id FROM source_bindings ORDER BY play_game_id")
        .all() as Array<{ play_game_id: string; entity_id: string }>;
      expect(bindings[0]).toEqual({ play_game_id: "sibling-a", entity_id: originalEntityId });
      expect(bindings[1].play_game_id).toBe("sibling-b");
      expect(bindings[1].entity_id).not.toBe(originalEntityId);
      const splitEntityId = bindings[1].entity_id;

      expect(
        migrated
          .prepare(
            `SELECT entity_id,purchase_record_id,status FROM game_entity_purchase_links
             ORDER BY entity_id`,
          )
          .all(),
      ).toEqual([
        {
          entity_id: originalEntityId,
          purchase_record_id: "purchase-sibling",
          status: "confirmed",
        },
      ]);
      expect(
        migrated
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_acquisitions
             ORDER BY entity_id`,
          )
          .all(),
      ).toEqual([{ entity_id: originalEntityId, purchase_record_id: "purchase-sibling" }]);
      expect(
        migrated
          .prepare("SELECT play_game_id,purchase_record_id FROM play_purchase_links ORDER BY id")
          .all(),
      ).toEqual([{ play_game_id: "sibling-a", purchase_record_id: "purchase-sibling" }]);
      expect(
        migrated
          .prepare("SELECT id FROM game_entity_purchase_links WHERE entity_id=?")
          .get(splitEntityId),
      ).toBe(undefined);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }
  });

  it("keeps an explicit V5 collection edit on the newly split sibling", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-sibling-edit-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    db.exec("PRAGMA foreign_keys=ON");
    const now = "2026-09-15T00:00:00.000Z";
    const titleA = "0100EDITA00000001";
    const titleB = "0100EDITB00000001";
    seedPlayGame(db, now, { id: "edit-a", title: "Edit A", titleId: titleA });
    seedPlayGame(db, now, { id: "edit-b", title: "Edit B", titleId: titleA });
    seedPurchase(db, "purchase-original", now);
    seedPurchase(db, "purchase-explicit", now);
    const originalEntityId = ensurePlayGameEntityBinding(db, "edit-a", now);
    expect(ensurePlayGameEntityBinding(db, "edit-b", now)).toBe(originalEntityId);
    upsertGameEntityPurchaseLink(db, {
      entityId: originalEntityId,
      purchase_record_id: "purchase-original",
      status: "confirmed",
      match_method: "manual",
      confidence: 1,
      decided_at: now,
      decided_by: "audit",
      updated_at: now,
    });

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id='edit-b'").run(
      titleB,
      "2026-09-15T01:00:00.000Z",
    );
    db.prepare(
      `UPDATE play_purchase_links
       SET purchase_record_id='purchase-explicit',updated_at=?,decided_at=?
       WHERE play_game_id='edit-b'`,
    ).run("2026-09-15T01:00:00.000Z", "2026-09-15T01:00:00.000Z");
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    try {
      const splitEntity = migrated
        .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='edit-b'")
        .get() as { entity_id: string };
      expect(splitEntity.entity_id).not.toBe(originalEntityId);
      expect(
        migrated
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_purchase_links
             ORDER BY purchase_record_id`,
          )
          .all(),
      ).toEqual([
        { entity_id: splitEntity.entity_id, purchase_record_id: "purchase-explicit" },
        { entity_id: originalEntityId, purchase_record_id: "purchase-original" },
      ]);
      expect(
        migrated
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_acquisitions
             ORDER BY purchase_record_id`,
          )
          .all(),
      ).toEqual([
        { entity_id: splitEntity.entity_id, purchase_record_id: "purchase-explicit" },
        { entity_id: originalEntityId, purchase_record_id: "purchase-original" },
      ]);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }
  });

  it("redirects aliases before a true re-up merge and enforces public ID exclusivity", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-alias-reup-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    db.exec("PRAGMA foreign_keys=ON");
    const now = "2026-09-15T00:00:00.000Z";
    const titleA = "0100MERGEA000001";
    const titleB = "0100MERGEB000001";
    seedPlayGame(db, now, { id: "merge-a", title: "Merge A", titleId: titleA });
    seedPlayGame(db, now, { id: "merge-b", title: "Merge B", titleId: titleB });
    const oldEntityId = ensurePlayGameEntityBinding(db, "merge-a", now);
    const survivorId = ensurePlayGameEntityBinding(db, "merge-b", now);
    db.prepare(
      `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
       VALUES('legacy-merge-a',?,?,?)`,
    ).run(oldEntityId, now, now);

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    db.exec(downSql);
    db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id='merge-a'").run(
      titleB,
      "2026-09-15T01:00:00.000Z",
    );
    db.close();

    await migratePlayDatabase();
    const migrated = new DatabaseSync(database);
    migrated.exec("PRAGMA foreign_keys=ON");
    try {
      expect(
        migrated
          .prepare("SELECT play_game_id,entity_id FROM source_bindings ORDER BY play_game_id")
          .all(),
      ).toEqual([
        { play_game_id: "merge-a", entity_id: survivorId },
        { play_game_id: "merge-b", entity_id: survivorId },
      ]);
      expect(migrated.prepare("SELECT id FROM game_entities WHERE id=?").get(oldEntityId)).toBe(
        undefined,
      );
      expect(
        migrated
          .prepare(
            `SELECT alias_id,entity_id FROM game_entity_aliases
             WHERE alias_id IN (?,?) ORDER BY alias_id`,
          )
          .all(oldEntityId, "legacy-merge-a"),
      ).toEqual([
        { alias_id: oldEntityId, entity_id: survivorId },
        { alias_id: "legacy-merge-a", entity_id: survivorId },
      ]);
      expect(resolveGameEntityId(migrated, oldEntityId)).toBe(survivorId);
      expect(resolveGameEntityId(migrated, "legacy-merge-a")).toBe(survivorId);
      expect(
        migrated
          .prepare(
            `SELECT COUNT(*) AS count FROM game_entity_aliases alias
             JOIN game_entities entity ON entity.id=alias.alias_id`,
          )
          .get(),
      ).toEqual({ count: 0 });

      expect(() =>
        migrated
          .prepare(
            `INSERT INTO game_entities(
              id,strong_key,canonical_title,normalized_title,title_id,platform,created_at,updated_at
            ) VALUES(?,NULL,'Collision','collision',NULL,'Nintendo Switch',?,?)`,
          )
          .run(oldEntityId, now, now),
      ).toThrow(/conflicts with alias/);
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
             VALUES(?,?,?,?)`,
          )
          .run(survivorId, survivorId, now, now),
      ).toThrow(/conflicts with entity/);
      expect(() =>
        migrated
          .prepare("UPDATE game_entity_aliases SET alias_id=? WHERE alias_id='legacy-merge-a'")
          .run(survivorId),
      ).toThrow(/conflicts with entity/);
      expect(() =>
        migrated.prepare("UPDATE game_entities SET id='changed-id' WHERE id=?").run(survivorId),
      ).toThrow(/immutable/);
      expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      migrated.close();
    }
  });

  it("reconcile keeps the direct entity when an older schema reused its ID as an alias", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-alias-collision-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    const now = "2026-09-15T00:00:00.000Z";
    for (const [id, title] of [
      ["direct-wins", "Direct Wins"],
      ["alias-target", "Alias Target"],
    ])
      db.prepare(
        `INSERT INTO game_entities(
          id,strong_key,canonical_title,normalized_title,title_id,platform,created_at,updated_at
        ) VALUES(?,NULL,?,?,NULL,'Nintendo Switch',?,?)`,
      ).run(id, title, title.toLowerCase().replaceAll(" ", ""), now, now);
    db.exec("DROP TRIGGER trg_game_entity_alias_not_entity_insert");
    db.prepare(
      `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
       VALUES('direct-wins','alias-target',?,?)`,
    ).run(now, now);
    db.close();

    await migratePlayDatabase();
    const reconciled = new DatabaseSync(database);
    try {
      expect(
        reconciled.prepare("SELECT id FROM game_entities WHERE id='direct-wins'").get(),
      ).toEqual({ id: "direct-wins" });
      expect(
        reconciled
          .prepare("SELECT entity_id FROM game_entity_aliases WHERE alias_id='direct-wins'")
          .get(),
      ).toBe(undefined);
      expect(resolveGameEntityId(reconciled, "direct-wins")).toBe("direct-wins");
      expect(() =>
        reconciled
          .prepare(
            `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
             VALUES('direct-wins','alias-target',?,?)`,
          )
          .run(now, now),
      ).toThrow(/conflicts with entity/);
      expect(reconciled.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(reconciled.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      reconciled.close();
    }
  });

  it("refuses an orphan entity decision and leaves V6 markers unchanged", async () => {
    directory = await mkdtemp(join(tmpdir(), "gamenote-entity-down-"));
    const database = join(directory, "ns2.sqlite");
    process.env.APP_DATABASE_FILE = database;
    await migratePlayDatabase();

    const db = new DatabaseSync(database);
    const now = "2026-09-15T00:00:00.000Z";
    seedPurchase(db, "purchase-orphan", now);
    db.prepare(
      `INSERT INTO game_entities(
        id,strong_key,canonical_title,normalized_title,title_id,platform,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
    ).run("orphan-entity", null, "Orphan", "orphan", null, "Nintendo Switch", now, now);
    upsertGameEntityPurchaseLink(db, {
      entityId: "orphan-entity",
      purchase_record_id: "purchase-orphan",
      status: "confirmed",
      match_method: "manual",
      confidence: 1,
      decided_at: now,
      decided_by: "audit",
      updated_at: now,
    });

    const downSql = await readFile(resolve("migrations/006_game_entities.down.sql"), "utf8");
    expect(() => db.exec(downSql)).toThrow(/CHECK constraint/);
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()).toEqual({
      value: "6",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=6").get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    db.close();
  });
});

function seedPlayGame(
  db: DatabaseSync,
  now: string,
  options: {
    id?: string;
    title?: string;
    titleId?: string | null;
    source?: "manual" | "json_import" | "nintendo_connector" | "moon_connector" | "nintendo_store";
  } = {},
) {
  const id = options.id || "game-a";
  const title = options.title || "Audit Game";
  const source = options.source || "manual";
  db.prepare(
    `INSERT INTO play_games(
      id,source,external_id,title,normalized_title,title_id,platform,
      first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    source,
    `${source}:${id}`,
    title,
    title.toLowerCase().replaceAll(" ", ""),
    options.titleId || null,
    "Nintendo Switch",
    now,
    now,
    0,
    0,
    now,
    now,
  );
}

function seedPurchase(db: DatabaseSync, id: string, now: string) {
  db.prepare(
    `INSERT INTO purchase_records(id,title,normalized_title,raw_json,imported_at)
     VALUES(?,?,?,?,?)`,
  ).run(id, id, id, JSON.stringify({ id }), now);
}
