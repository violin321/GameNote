import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureAllPlayGameEntityBindings,
  ensurePlayGameEntityBinding,
  resolveGameEntityId,
  upsertGameEntityPurchaseLink,
} from "../lib/play-history/entities";
import { listPlayGames, migratePlayDatabase } from "../lib/play-history/repository";

const cryptoMock = vi.hoisted(() => ({ queuedUuids: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => cryptoMock.queuedUuids.shift() || actual.randomUUID(),
  };
});

let directory = "";
const opaqueEntityIdPattern =
  /^game-entity:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-entity-identity-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  cryptoMock.queuedUuids.length = 0;
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

describe("logical game identity metadata", () => {
  it("keeps the highest-priority non-empty official URL across merged sources", async () => {
    withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-metadata",
        source: "nintendo_store",
        title: "Store title",
        titleId: "0100METADATA00001",
      });
      seedPlayGame(db, {
        id: "moon-metadata",
        source: "moon_connector",
        title: "Moon title",
        titleId: "0100metadata00001",
        officialUrl: "https://example.com/games/metadata",
      });
    });

    const games = await listPlayGames("title", "asc", "title");
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      title: "Store title",
      officialUrl: "https://example.com/games/metadata",
    });
  });

  it("keeps an old public entity ID resolvable after a strong-identity merge", async () => {
    withDatabase((db) =>
      seedPlayGame(db, {
        id: "manual-provisional",
        source: "manual",
        title: "Alias game",
      }),
    );
    const [provisional] = await listPlayGames("title", "asc", "Alias game");
    const oldEntityId = provisional.entityId;

    const targetEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-alias",
        source: "nintendo_store",
        title: "Alias game",
        titleId: "0100ALIAS0000001",
      });
      const target = ensurePlayGameEntityBinding(db, "store-alias", "2026-09-15T02:00:00.000Z");
      db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id=?").run(
        "0100alias0000001",
        "2026-09-15T03:00:00.000Z",
        "manual-provisional",
      );
      ensurePlayGameEntityBinding(db, "manual-provisional", "2026-09-15T03:00:00.000Z");
      return target;
    });

    const state = withDatabase((db) => {
      const resolved = resolveGameEntityId(db, oldEntityId);
      return {
        resolved,
        alias: db
          .prepare("SELECT alias_id,entity_id FROM game_entity_aliases WHERE alias_id=?")
          .get(oldEntityId),
        oldEntity: db.prepare("SELECT id FROM game_entities WHERE id=?").get(oldEntityId),
        foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
      };
    });
    expect(targetEntityId).toMatch(opaqueEntityIdPattern);
    expect(targetEntityId).not.toBe(oldEntityId);
    expect(state.resolved).toBe(targetEntityId);
    expect(state.alias).toEqual({
      alias_id: oldEntityId,
      entity_id: state.resolved,
    });
    expect(state.oldEntity).toBeUndefined();
    expect(state.foreignKeys).toEqual([]);
  });

  it("keeps a single-source entity ID when its strong key changes and does not reclaim it", () => {
    const originalEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-retitled",
        source: "nintendo_store",
        title: "Retitled game",
        titleId: "0100IDENTITYKEYA1",
      });
      return ensurePlayGameEntityBinding(db, "store-retitled", "2026-09-15T01:00:00.000Z");
    });

    const changedEntityId = withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id=?").run(
        "0100IDENTITYKEYB1",
        "2026-09-15T02:00:00.000Z",
        "store-retitled",
      );
      return ensurePlayGameEntityBinding(db, "store-retitled", "2026-09-15T02:00:00.000Z");
    });

    const replacementEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-new-key-a",
        source: "nintendo_store",
        title: "New game using old key",
        titleId: "0100IDENTITYKEYA1",
      });
      return ensurePlayGameEntityBinding(db, "store-new-key-a", "2026-09-15T03:00:00.000Z");
    });

    expect(originalEntityId).toMatch(opaqueEntityIdPattern);
    expect(originalEntityId).not.toContain("0100identitykeya1");
    expect(changedEntityId).toBe(originalEntityId);
    expect(replacementEntityId).toMatch(opaqueEntityIdPattern);
    expect(replacementEntityId).not.toBe(originalEntityId);
    expect(
      withDatabase((db) => ({
        entities: db.prepare("SELECT id,strong_key FROM game_entities ORDER BY strong_key").all(),
        bindings: db
          .prepare("SELECT play_game_id,entity_id FROM source_bindings ORDER BY play_game_id")
          .all(),
        originalAlias: db
          .prepare("SELECT entity_id FROM game_entity_aliases WHERE alias_id=?")
          .get(originalEntityId),
      })),
    ).toEqual({
      entities: [
        { id: replacementEntityId, strong_key: "title-id:nintendo:0100identitykeya1" },
        { id: originalEntityId, strong_key: "title-id:nintendo:0100identitykeyb1" },
      ],
      bindings: [
        { play_game_id: "store-new-key-a", entity_id: replacementEntityId },
        { play_game_id: "store-retitled", entity_id: originalEntityId },
      ],
      originalAlias: undefined,
    });
  });

  it("clears a single-source strong identity when its title ID is removed", () => {
    const originalEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-cleared-key",
        source: "nintendo_store",
        title: "Cleared key game",
        titleId: "0100CLEARKEY00001",
      });
      return ensurePlayGameEntityBinding(db, "store-cleared-key", "2026-09-15T01:00:00.000Z");
    });

    const clearedEntityId = withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=NULL,updated_at=? WHERE id=?").run(
        "2026-09-15T02:00:00.000Z",
        "store-cleared-key",
      );
      return ensurePlayGameEntityBinding(db, "store-cleared-key", "2026-09-15T02:00:00.000Z");
    });
    const replacementEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-reused-cleared-key",
        source: "nintendo_store",
        title: "New owner of cleared key",
        titleId: "0100CLEARKEY00001",
      });
      return ensurePlayGameEntityBinding(
        db,
        "store-reused-cleared-key",
        "2026-09-15T03:00:00.000Z",
      );
    });

    expect(clearedEntityId).toBe(originalEntityId);
    expect(replacementEntityId).not.toBe(originalEntityId);
    expect(
      withDatabase((db) =>
        db.prepare("SELECT id,strong_key,title_id FROM game_entities ORDER BY strong_key").all(),
      ),
    ).toEqual([
      { id: originalEntityId, strong_key: null, title_id: null },
      {
        id: replacementEntityId,
        strong_key: "title-id:nintendo:0100clearkey00001",
        title_id: "0100CLEARKEY00001",
      },
    ]);
  });

  it("retains a shared strong key until every binding removes its title ID", () => {
    const sharedEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-cleared-shared",
        source: "nintendo_store",
        title: "Store shared clear",
        titleId: "0100SHAREDCLEAR01",
      });
      seedPlayGame(db, {
        id: "moon-cleared-shared",
        source: "moon_connector",
        title: "Moon shared clear",
        titleId: "0100SHAREDCLEAR01",
      });
      const entityId = ensurePlayGameEntityBinding(
        db,
        "store-cleared-shared",
        "2026-09-15T01:00:00.000Z",
      );
      expect(
        ensurePlayGameEntityBinding(db, "moon-cleared-shared", "2026-09-15T01:00:00.000Z"),
      ).toBe(entityId);
      return entityId;
    });

    withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=NULL,updated_at=? WHERE id=?").run(
        "2026-09-15T02:00:00.000Z",
        "store-cleared-shared",
      );
      ensurePlayGameEntityBinding(db, "store-cleared-shared", "2026-09-15T02:00:00.000Z");
      expect(
        db.prepare("SELECT strong_key,title_id FROM game_entities WHERE id=?").get(sharedEntityId),
      ).toEqual({
        strong_key: "title-id:nintendo:0100sharedclear01",
        title_id: "0100SHAREDCLEAR01",
      });
      db.prepare("UPDATE play_games SET title_id=NULL,updated_at=? WHERE id=?").run(
        "2026-09-15T03:00:00.000Z",
        "moon-cleared-shared",
      );
      expect(
        ensurePlayGameEntityBinding(db, "moon-cleared-shared", "2026-09-15T03:00:00.000Z"),
      ).toBe(sharedEntityId);
    });

    const replacementEntityId = withDatabase((db) => {
      expect(
        db.prepare("SELECT strong_key,title_id FROM game_entities WHERE id=?").get(sharedEntityId),
      ).toEqual({ strong_key: null, title_id: null });
      seedPlayGame(db, {
        id: "store-reused-shared-key",
        source: "nintendo_store",
        title: "Reused shared key",
        titleId: "0100SHAREDCLEAR01",
      });
      return ensurePlayGameEntityBinding(db, "store-reused-shared-key", "2026-09-15T04:00:00.000Z");
    });

    expect(replacementEntityId).not.toBe(sharedEntityId);
  });

  it("aliases a merged old ID to an existing strong entity without reusing it for the old key", () => {
    const initial = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-merge-a",
        source: "nintendo_store",
        title: "Merge source A",
        titleId: "0100MERGEKEYA0001",
      });
      seedPlayGame(db, {
        id: "moon-merge-b",
        source: "moon_connector",
        title: "Merge target B",
        titleId: "0100MERGEKEYB0001",
      });
      return {
        source: ensurePlayGameEntityBinding(db, "store-merge-a", "2026-09-15T01:00:00.000Z"),
        target: ensurePlayGameEntityBinding(db, "moon-merge-b", "2026-09-15T01:00:00.000Z"),
      };
    });

    const mergedEntityId = withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id=?").run(
        "0100MERGEKEYB0001",
        "2026-09-15T02:00:00.000Z",
        "store-merge-a",
      );
      db.exec(`CREATE TRIGGER reject_alias_direct_id_conflict
        BEFORE INSERT ON game_entity_aliases
        WHEN EXISTS(SELECT 1 FROM game_entities WHERE id=NEW.alias_id)
        BEGIN SELECT RAISE(ABORT, 'ALIAS_DIRECT_ID_CONFLICT'); END`);
      return ensurePlayGameEntityBinding(db, "store-merge-a", "2026-09-15T02:00:00.000Z");
    });
    const replacementEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-replacement-a",
        source: "nintendo_store",
        title: "Replacement A",
        titleId: "0100MERGEKEYA0001",
      });
      return ensurePlayGameEntityBinding(db, "store-replacement-a", "2026-09-15T03:00:00.000Z");
    });

    expect(initial.source).toMatch(opaqueEntityIdPattern);
    expect(initial.target).toMatch(opaqueEntityIdPattern);
    expect(mergedEntityId).toBe(initial.target);
    expect(replacementEntityId).toMatch(opaqueEntityIdPattern);
    expect(replacementEntityId).not.toBe(initial.source);
    expect(replacementEntityId).not.toBe(initial.target);
    expect(
      withDatabase((db) => ({
        resolvedOldId: resolveGameEntityId(db, initial.source),
        oldDirectEntity: db.prepare("SELECT id FROM game_entities WHERE id=?").get(initial.source),
        alias: db
          .prepare("SELECT alias_id,entity_id FROM game_entity_aliases WHERE alias_id=?")
          .get(initial.source),
        bindings: db
          .prepare("SELECT play_game_id,entity_id FROM source_bindings ORDER BY play_game_id")
          .all(),
        foreignKeys: db.prepare("PRAGMA foreign_key_check").all(),
      })),
    ).toEqual({
      resolvedOldId: initial.target,
      oldDirectEntity: undefined,
      alias: { alias_id: initial.source, entity_id: initial.target },
      bindings: [
        { play_game_id: "moon-merge-b", entity_id: initial.target },
        { play_game_id: "store-merge-a", entity_id: initial.target },
        { play_game_id: "store-replacement-a", entity_id: replacementEntityId },
      ],
      foreignKeys: [],
    });
  });

  it("chooses the same tied primary link regardless of link insertion order", async () => {
    const lowerUuid = "10000000-0000-4000-8000-000000000001";
    const higherUuid = "20000000-0000-4000-8000-000000000002";
    const lowerEntityId = `game-entity:${lowerUuid}`;

    const runMerge = async (scenario: string, linkOrder: Array<"a" | "b">) => {
      const scenarioDirectory = join(directory, scenario);
      await mkdir(scenarioDirectory);
      process.env.APP_DATABASE_FILE = join(scenarioDirectory, "ns2.sqlite");
      await migratePlayDatabase();
      return withDatabase((db) => {
        seedPlayGame(db, {
          id: "store-tied-a",
          source: "nintendo_store",
          title: "Tied link A",
        });
        seedPlayGame(db, {
          id: "moon-tied-b",
          source: "moon_connector",
          title: "Tied link B",
        });
        seedPurchase(db, "purchase-tied-a", "Tied purchase A");
        seedPurchase(db, "purchase-tied-b", "Tied purchase B");
        cryptoMock.queuedUuids.push(lowerUuid, higherUuid);
        const entities = {
          a: ensurePlayGameEntityBinding(db, "store-tied-a", "2026-09-15T01:00:00.000Z"),
          b: ensurePlayGameEntityBinding(db, "moon-tied-b", "2026-09-15T01:00:00.000Z"),
        };
        for (const item of linkOrder)
          upsertConfirmedLink(
            db,
            entities[item],
            item === "a" ? "purchase-tied-a" : "purchase-tied-b",
            `owner-${item}`,
          );
        db.prepare("UPDATE play_games SET title_id=? WHERE id IN (?,?)").run(
          "0100TIEBREAK00001",
          "store-tied-a",
          "moon-tied-b",
        );
        ensurePlayGameEntityBinding(db, "store-tied-a", "2026-09-15T02:00:00.000Z");
        ensurePlayGameEntityBinding(db, "moon-tied-b", "2026-09-15T02:00:00.000Z");
        return {
          primary: db
            .prepare("SELECT entity_id,purchase_record_id FROM game_entity_purchase_links")
            .get(),
          acquisitions: db
            .prepare(
              `SELECT entity_id,purchase_record_id FROM game_entity_acquisitions
               ORDER BY purchase_record_id`,
            )
            .all(),
        };
      });
    };

    const forward = await runMerge("tie-forward", ["a", "b"]);
    const reverse = await runMerge("tie-reverse", ["b", "a"]);

    expect(reverse).toEqual(forward);
    expect(forward).toEqual({
      primary: { entity_id: lowerEntityId, purchase_record_id: "purchase-tied-a" },
      acquisitions: [
        { entity_id: lowerEntityId, purchase_record_id: "purchase-tied-a" },
        { entity_id: lowerEntityId, purchase_record_id: "purchase-tied-b" },
      ],
    });
  });

  it("allocates a new opaque ID when one binding splits from a shared entity", () => {
    const sharedEntityId = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-shared-key",
        source: "nintendo_store",
        title: "Shared key Store",
        titleId: "0100SHAREDKEY0001",
      });
      seedPlayGame(db, {
        id: "moon-shared-key",
        source: "moon_connector",
        title: "Shared key Moon",
        titleId: "0100SHAREDKEY0001",
      });
      const storeEntityId = ensurePlayGameEntityBinding(
        db,
        "store-shared-key",
        "2026-09-15T01:00:00.000Z",
      );
      expect(ensurePlayGameEntityBinding(db, "moon-shared-key", "2026-09-15T01:00:00.000Z")).toBe(
        storeEntityId,
      );
      return storeEntityId;
    });

    const splitEntityId = withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id=?").run(
        "0100SPLITKEY000001",
        "2026-09-15T02:00:00.000Z",
        "moon-shared-key",
      );
      return ensurePlayGameEntityBinding(db, "moon-shared-key", "2026-09-15T02:00:00.000Z");
    });

    expect(sharedEntityId).toMatch(opaqueEntityIdPattern);
    expect(splitEntityId).toMatch(opaqueEntityIdPattern);
    expect(splitEntityId).not.toBe(sharedEntityId);
    expect(splitEntityId).not.toContain("0100splitkey000001");
    expect(
      withDatabase((db) =>
        db
          .prepare(
            `SELECT b.play_game_id,b.entity_id,e.strong_key
             FROM source_bindings b JOIN game_entities e ON e.id=b.entity_id
             ORDER BY b.play_game_id`,
          )
          .all(),
      ),
    ).toEqual([
      {
        play_game_id: "moon-shared-key",
        entity_id: splitEntityId,
        strong_key: "title-id:nintendo:0100splitkey000001",
      },
      {
        play_game_id: "store-shared-key",
        entity_id: sharedEntityId,
        strong_key: "title-id:nintendo:0100sharedkey0001",
      },
    ]);
  });

  it("keeps collection ownership on the old entity when a shared binding splits", () => {
    const initial = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-owned-a",
        source: "nintendo_store",
        title: "Store-owned A",
        titleId: "0100OWNEDKEYA001",
        officialUrl: "https://example.com/store-a",
      });
      seedPlayGame(db, {
        id: "moon-owned-a",
        source: "moon_connector",
        title: "Moon remaining A",
        titleId: "0100OWNEDKEYA001",
        officialUrl: "https://example.com/moon-a",
      });
      seedPurchase(db, "purchase-owned-a", "Owned A");
      const entityId = ensurePlayGameEntityBinding(db, "store-owned-a", "2026-09-15T01:00:00.000Z");
      expect(ensurePlayGameEntityBinding(db, "moon-owned-a", "2026-09-15T01:00:00.000Z")).toBe(
        entityId,
      );
      upsertConfirmedLink(db, entityId, "purchase-owned-a", "owner-a");
      return entityId;
    });

    const splitEntityId = withDatabase((db) => {
      db.prepare(
        `UPDATE play_games SET title=?,normalized_title=?,title_id=?,official_url=?,updated_at=?
         WHERE id=?`,
      ).run(
        "Store moved B",
        "storemovedb",
        "0100OWNEDKEYB001",
        "https://example.com/store-b",
        "2026-09-15T02:00:00.000Z",
        "store-owned-a",
      );
      return ensurePlayGameEntityBinding(db, "store-owned-a", "2026-09-15T02:00:00.000Z");
    });

    expect(splitEntityId).not.toBe(initial);
    expect(
      withDatabase((db) => ({
        entities: db
          .prepare(
            `SELECT id,strong_key,canonical_title,title_id,official_url
             FROM game_entities ORDER BY strong_key`,
          )
          .all(),
        links: db
          .prepare(
            `SELECT entity_id,purchase_record_id,status FROM game_entity_purchase_links
             ORDER BY entity_id`,
          )
          .all(),
        acquisitions: db
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_acquisitions
             ORDER BY entity_id,purchase_record_id`,
          )
          .all(),
        legacy: db
          .prepare(
            `SELECT play_game_id,purchase_record_id FROM play_purchase_links
             ORDER BY play_game_id`,
          )
          .all(),
      })),
    ).toEqual({
      entities: [
        {
          id: initial,
          strong_key: "title-id:nintendo:0100ownedkeya001",
          canonical_title: "Moon remaining A",
          title_id: "0100OWNEDKEYA001",
          official_url: "https://example.com/moon-a",
        },
        {
          id: splitEntityId,
          strong_key: "title-id:nintendo:0100ownedkeyb001",
          canonical_title: "Store moved B",
          title_id: "0100OWNEDKEYB001",
          official_url: "https://example.com/store-b",
        },
      ],
      links: [{ entity_id: initial, purchase_record_id: "purchase-owned-a", status: "confirmed" }],
      acquisitions: [{ entity_id: initial, purchase_record_id: "purchase-owned-a" }],
      legacy: [{ play_game_id: "moon-owned-a", purchase_record_id: "purchase-owned-a" }],
    });
  });

  it("keeps both collections isolated when a shared binding moves to an existing identity", () => {
    const initial = withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-isolated-a",
        source: "nintendo_store",
        title: "Store isolated A",
        titleId: "0100ISOLATEDA001",
      });
      seedPlayGame(db, {
        id: "moon-isolated-a",
        source: "moon_connector",
        title: "Moon isolated A",
        titleId: "0100ISOLATEDA001",
      });
      seedPlayGame(db, {
        id: "store-isolated-b",
        source: "nintendo_store",
        title: "Store isolated B",
        titleId: "0100ISOLATEDB001",
      });
      seedPurchase(db, "purchase-isolated-a", "Isolated A");
      seedPurchase(db, "purchase-isolated-b", "Isolated B");
      const entityA = ensurePlayGameEntityBinding(
        db,
        "store-isolated-a",
        "2026-09-15T01:00:00.000Z",
      );
      expect(ensurePlayGameEntityBinding(db, "moon-isolated-a", "2026-09-15T01:00:00.000Z")).toBe(
        entityA,
      );
      const entityB = ensurePlayGameEntityBinding(
        db,
        "store-isolated-b",
        "2026-09-15T01:00:00.000Z",
      );
      upsertConfirmedLink(db, entityA, "purchase-isolated-a", "owner-a");
      upsertConfirmedLink(db, entityB, "purchase-isolated-b", "owner-b");
      return { entityA, entityB };
    });

    const movedEntityId = withDatabase((db) => {
      db.prepare("UPDATE play_games SET title_id=?,updated_at=? WHERE id=?").run(
        "0100ISOLATEDB001",
        "2026-09-15T02:00:00.000Z",
        "store-isolated-a",
      );
      return ensurePlayGameEntityBinding(db, "store-isolated-a", "2026-09-15T02:00:00.000Z");
    });

    expect(movedEntityId).toBe(initial.entityB);
    expect(
      withDatabase((db) => ({
        links: db
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_purchase_links
             ORDER BY entity_id`,
          )
          .all(),
        acquisitions: db
          .prepare(
            `SELECT entity_id,purchase_record_id FROM game_entity_acquisitions
             ORDER BY entity_id,purchase_record_id`,
          )
          .all(),
        legacy: db
          .prepare(
            `SELECT play_game_id,purchase_record_id FROM play_purchase_links
             ORDER BY play_game_id`,
          )
          .all(),
        entities: db
          .prepare("SELECT id,strong_key,title_id FROM game_entities ORDER BY strong_key")
          .all(),
      })),
    ).toEqual({
      links: [
        { entity_id: initial.entityA, purchase_record_id: "purchase-isolated-a" },
        { entity_id: initial.entityB, purchase_record_id: "purchase-isolated-b" },
      ].sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
      acquisitions: [
        { entity_id: initial.entityA, purchase_record_id: "purchase-isolated-a" },
        { entity_id: initial.entityB, purchase_record_id: "purchase-isolated-b" },
      ].sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
      legacy: [
        { play_game_id: "moon-isolated-a", purchase_record_id: "purchase-isolated-a" },
        { play_game_id: "store-isolated-a", purchase_record_id: "purchase-isolated-b" },
        { play_game_id: "store-isolated-b", purchase_record_id: "purchase-isolated-b" },
      ],
      entities: [
        {
          id: initial.entityA,
          strong_key: "title-id:nintendo:0100isolateda001",
          title_id: "0100ISOLATEDA001",
        },
        {
          id: initial.entityB,
          strong_key: "title-id:nintendo:0100isolatedb001",
          title_id: "0100ISOLATEDB001",
        },
      ],
    });
  });

  it("does not leave an orphan when a concurrent binder wins an unbound row", () => {
    const winnerEntityId = "game-entity:concurrent-winner";
    const losingUuid = "44444444-4444-4444-8444-444444444444";
    withDatabase((db) => {
      const now = "2026-09-15T01:00:00.000Z";
      db.prepare(
        `INSERT INTO game_entities(
          id,strong_key,canonical_title,normalized_title,title_id,platform,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        winnerEntityId,
        null,
        "Concurrent placeholder",
        "concurrentplaceholder",
        null,
        "Nintendo Switch",
        now,
        now,
      );
      seedPlayGame(db, {
        id: "manual-concurrent-binding",
        source: "manual",
        title: "Concurrent binding",
      });
      db.exec(`CREATE TABLE binding_race_guard(fired INTEGER NOT NULL);
        CREATE TRIGGER inject_concurrent_binding
        BEFORE INSERT ON source_bindings
        WHEN NEW.play_game_id='manual-concurrent-binding'
          AND NOT EXISTS(SELECT 1 FROM binding_race_guard)
        BEGIN
          INSERT INTO binding_race_guard(fired) VALUES(1);
          INSERT INTO source_bindings(
            id,entity_id,play_game_id,source,external_id,created_at,updated_at
          ) VALUES(
            'concurrent-winning-binding','game-entity:concurrent-winner',NEW.play_game_id,
            NEW.source,NEW.external_id,NEW.created_at,NEW.updated_at
          );
        END`);
      cryptoMock.queuedUuids.push(losingUuid);
      ensureAllPlayGameEntityBindings(db, now);
    });

    expect(
      withDatabase((db) => ({
        entities: db.prepare("SELECT id,canonical_title FROM game_entities ORDER BY id").all(),
        binding: db
          .prepare(
            "SELECT entity_id FROM source_bindings WHERE play_game_id='manual-concurrent-binding'",
          )
          .get(),
      })),
    ).toEqual({
      entities: [{ id: winnerEntityId, canonical_title: "Concurrent binding" }],
      binding: { entity_id: winnerEntityId },
    });
  });

  it("retries opaque allocation when a candidate collides with a direct ID or alias", () => {
    const directCollisionUuid = "11111111-1111-4111-8111-111111111111";
    const aliasCollisionUuid = "22222222-2222-4222-8222-222222222222";
    const freeUuid = "33333333-3333-4333-8333-333333333333";
    const directCollisionId = `game-entity:${directCollisionUuid}`;
    const aliasCollisionId = `game-entity:${aliasCollisionUuid}`;

    const entityId = withDatabase((db) => {
      const now = "2026-09-15T01:00:00.000Z";
      db.prepare(
        `INSERT INTO game_entities(
          id,strong_key,canonical_title,normalized_title,title_id,platform,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        directCollisionId,
        null,
        "Existing entity",
        "existingentity",
        null,
        "Nintendo Switch",
        now,
        now,
      );
      db.prepare(
        `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
         VALUES(?,?,?,?)`,
      ).run(aliasCollisionId, directCollisionId, now, now);
      seedPlayGame(db, {
        id: "store-allocation",
        source: "nintendo_store",
        title: "Allocated entity",
        titleId: "0100ALLOCATED0001",
      });
      cryptoMock.queuedUuids.push(directCollisionUuid, aliasCollisionUuid, freeUuid);
      return ensurePlayGameEntityBinding(db, "store-allocation", now);
    });

    expect(entityId).toBe(`game-entity:${freeUuid}`);
    expect(
      withDatabase((db) => ({
        binding: db
          .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id='store-allocation'")
          .get(),
        alias: db
          .prepare("SELECT entity_id FROM game_entity_aliases WHERE alias_id=?")
          .get(aliasCollisionId),
      })),
    ).toEqual({
      binding: { entity_id: entityId },
      alias: { entity_id: directCollisionId },
    });
  });

  it("repairs an earlier V6 draft without alias support on repeated migration", async () => {
    withDatabase((db) => {
      seedPlayGame(db, {
        id: "store-reconcile",
        source: "nintendo_store",
        title: "Reconcile title",
        titleId: "0100RECONCILE001",
      });
      seedPlayGame(db, {
        id: "moon-reconcile",
        source: "moon_connector",
        title: "Reconcile title localized",
        titleId: "0100reconcile001",
        officialUrl: "https://example.com/games/reconcile",
      });
    });
    await listPlayGames("title", "asc", "Reconcile");
    withDatabase((db) => {
      db.exec("DROP TABLE game_entity_aliases");
      db.prepare("UPDATE game_entities SET official_url=NULL").run();
    });

    await migratePlayDatabase();

    expect(
      withDatabase((db) => ({
        aliasTable: db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='game_entity_aliases'",
          )
          .get(),
        entity: db.prepare("SELECT official_url FROM game_entities").get(),
      })),
    ).toEqual({
      aliasTable: { name: "game_entity_aliases" },
      entity: { official_url: "https://example.com/games/reconcile" },
    });
  });
});

function seedPlayGame(
  db: DatabaseSync,
  input: {
    id: string;
    source: "manual" | "moon_connector" | "nintendo_store";
    title: string;
    titleId?: string;
    officialUrl?: string;
  },
) {
  const now = "2026-09-15T00:00:00.000Z";
  db.prepare(
    `INSERT INTO play_games(
      id,source,external_id,title,normalized_title,title_id,official_url,platform,
      first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    input.source,
    `${input.source}:${input.id}`,
    input.title,
    input.title.toLowerCase().replaceAll(" ", ""),
    input.titleId || null,
    input.officialUrl || null,
    "Nintendo Switch",
    now,
    now,
    0,
    0,
    now,
    now,
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
    "2026-09-15",
  );
}

function upsertConfirmedLink(
  db: DatabaseSync,
  entityId: string,
  purchaseRecordId: string,
  decidedBy: string,
) {
  const now = "2026-09-15T01:00:00.000Z";
  upsertGameEntityPurchaseLink(db, {
    entityId,
    purchase_record_id: purchaseRecordId,
    status: "confirmed",
    match_method: "manual",
    confidence: 1,
    decided_at: now,
    decided_by: decidedBy,
    updated_at: now,
  });
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
