import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePlayGameEntityBinding } from "../lib/play-history/entities";
import {
  createManualPlayEntry,
  decidePurchaseLink,
  getPlayGameDetail,
  listPlayGames,
  listPurchasePlaySummaries,
  migratePlayDatabase,
} from "../lib/play-history/repository";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-entities-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

describe("logical game entities", () => {
  it("does not merge equal normalized titles without a strong identifier", async () => {
    withDatabase((db) => {
      seedPlayGame(db, {
        id: "manual-same-title",
        source: "manual",
        externalId: "manual:same-title",
        title: "Same Title",
      });
      seedPlayGame(db, {
        id: "json-same-title",
        source: "json_import",
        externalId: "json:same-title",
        title: "Same Title",
      });
    });

    const games = await listPlayGames("title", "asc", "Same Title");
    expect(games).toHaveLength(2);
    expect(new Set(games.map((game) => game.entityId)).size).toBe(2);
    expect(
      withDatabase((db) =>
        db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM game_entities) AS entities,
              (SELECT COUNT(*) FROM source_bindings) AS bindings`,
          )
          .get(),
      ),
    ).toEqual({ entities: 2, bindings: 2 });
  });

  it("adds manual sessions through an entity-owned manual binding", async () => {
    withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-shared",
        source: "nintendo_store",
        externalId: "store:shared",
        title: "Shared Game",
        titleId: "0100SHARED000001",
        totalSeconds: 72_000,
        playDays: 20,
      });
      seedPlayGame(db, {
        id: "moon-shared",
        source: "moon_connector",
        externalId: "moon:shared",
        title: "Shared Game Localized",
        titleId: "0100shared000001",
      });
      seedPurchase(db, "purchase-shared", "Shared Game");
    });

    const [game] = await listPlayGames("recent", "desc", "Shared Game");
    expect(game).toMatchObject({ source: "nintendo_store", totalSeconds: 72_000 });
    expect(
      await createManualPlayEntry(
        {
          playGameId: game.entityId,
          purchaseRecordId: "purchase-shared",
          title: "",
          platform: "Nintendo Switch",
          startedAt: "2026-09-14T10:00:00.000Z",
          durationSeconds: 1800,
        },
        "admin",
      ),
    ).toMatchObject({ entityId: game.entityId });

    const persisted = withDatabase((db) =>
      db
        .prepare(
          `SELECT session_game.source,session_binding.entity_id,s.duration_seconds,
            (SELECT COUNT(*) FROM play_sessions WHERE game_id='store-shared') AS store_sessions
           FROM play_sessions s
           JOIN play_games session_game ON session_game.id=s.game_id
           JOIN source_bindings session_binding ON session_binding.play_game_id=s.game_id`,
        )
        .get(),
    );
    expect(persisted).toEqual({
      source: "manual",
      entity_id: game.entityId,
      duration_seconds: 1800,
      store_sessions: 0,
    });
    expect(await getPlayGameDetail("store-shared")).toMatchObject({
      entityId: game.entityId,
      totalSeconds: 72_000,
      sessionCount: 1,
      link: { status: "confirmed", purchaseRecordId: "purchase-shared" },
    });
    expect(await getPlayGameDetail("moon-shared")).toMatchObject({
      entityId: game.entityId,
      link: { status: "confirmed", purchaseRecordId: "purchase-shared" },
    });
    expect(
      withDatabase((db) =>
        db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM source_bindings WHERE entity_id=?) AS bindings,
              (SELECT COUNT(*) FROM play_purchase_links WHERE status='confirmed') AS legacy_links,
              (SELECT COUNT(*) FROM game_entity_acquisitions WHERE entity_id=?) AS acquisitions`,
          )
          .get(game.entityId, game.entityId),
      ),
    ).toEqual({ bindings: 3, legacy_links: 3, acquisitions: 1 });
  });

  it("preserves distinct confirmed acquisitions when strong identities converge", async () => {
    withDatabase((db) => {
      seedPlayGame(db, {
        id: "copy-a",
        source: "manual",
        externalId: "manual:copy-a",
        title: "Merge Later A",
      });
      seedPlayGame(db, {
        id: "copy-b",
        source: "json_import",
        externalId: "json:copy-b",
        title: "Merge Later B",
      });
      seedPurchase(db, "purchase-a", "Merge Later A");
      seedPurchase(db, "purchase-b", "Merge Later B");
    });
    const games = await listPlayGames("title", "asc", "Merge Later");
    await decidePurchaseLink(games[0].entityId, "confirm", "purchase-a", "admin-a");
    await decidePurchaseLink(games[1].entityId, "confirm", "purchase-b", "admin-b");

    withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=? WHERE id='copy-a'").run("0100MERGED0000001");
      ensurePlayGameEntityBinding(db, "copy-a", "2026-09-15T01:00:00.000Z");
      db.prepare("UPDATE play_games SET title_id=? WHERE id='copy-b'").run("0100merged0000001");
      ensurePlayGameEntityBinding(db, "copy-b", "2026-09-15T02:00:00.000Z");
    });

    expect(await listPlayGames("title", "asc", "Merge Later")).toHaveLength(1);
    expect(
      (await listPurchasePlaySummaries()).map((summary) => summary.purchaseRecordId).sort(),
    ).toEqual(["purchase-a", "purchase-b"]);
    expect(
      withDatabase((db) =>
        db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM game_entities) AS entities,
              (SELECT COUNT(*) FROM source_bindings) AS bindings,
              (SELECT COUNT(*) FROM game_entity_acquisitions) AS acquisitions`,
          )
          .get(),
      ),
    ).toEqual({ entities: 1, bindings: 2, acquisitions: 2 });
  });

  it("keeps healthy bindings stable across reads and repeated migration", async () => {
    withDatabase((db) =>
      seedPlayGame(db, {
        id: "stable-store",
        source: "nintendo_store",
        externalId: "store:stable",
        title: "Stable Game",
        titleId: "0100STABLE0000001",
      }),
    );
    await listPlayGames("recent", "desc", "Stable Game");
    const before = bindingState();
    await listPlayGames("recent", "desc", "Stable Game");
    await migratePlayDatabase();
    expect(bindingState()).toEqual(before);
  });
});

function bindingState() {
  return withDatabase((db) => ({
    entities: db.prepare("SELECT id,strong_key,updated_at FROM game_entities ORDER BY id").all(),
    bindings: db
      .prepare("SELECT entity_id,play_game_id,source,external_id,updated_at FROM source_bindings")
      .all(),
  }));
}

function seedPlayGame(
  db: DatabaseSync,
  input: {
    id: string;
    source: "manual" | "json_import" | "nintendo_store" | "moon_connector";
    externalId: string;
    title: string;
    titleId?: string;
    totalSeconds?: number;
    playDays?: number;
  },
) {
  db.prepare(
    `INSERT INTO play_games(
      id,source,external_id,title,normalized_title,title_id,platform,
      first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    input.source,
    input.externalId,
    input.title,
    input.title.toLowerCase().replaceAll(" ", ""),
    input.titleId || null,
    "Nintendo Switch",
    "2026-01-01T00:00:00.000Z",
    "2026-09-14T00:00:00.000Z",
    input.totalSeconds || 0,
    input.playDays || 0,
    "2026-09-14T00:00:00.000Z",
    "2026-09-14T00:00:00.000Z",
  );
}

function seedPurchase(db: DatabaseSync, id: string, title: string) {
  db.prepare(
    `INSERT INTO purchase_records(id,title,normalized_title,raw_json,imported_at)
     VALUES(?,?,?,?,?)`,
  ).run(
    id,
    title,
    title.toLowerCase().replaceAll(" ", ""),
    JSON.stringify({ id, title }),
    "2026-09-14",
  );
}

function withDatabase<T>(run: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    return run(db);
  } finally {
    db.close();
  }
}
