import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purchaseProjectionHash } from "../scripts/purchase-projection-json.mjs";
import { createLedgerDocument } from "../lib/ledger/schema";
import {
  createCollectionFromPlayGame,
  LedgerConflictError,
  openLedgerDatabase,
  readLedgerFromSqlite,
  writeLedgerToSqlite,
} from "../lib/ledger/repository";
import { listPlayGames, migratePlayDatabase } from "../lib/play-history/repository";

let testDirectory = "";

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "gamenote-repository-"));
  process.env.APP_DATABASE_FILE = join(testDirectory, "ns2.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(testDirectory, { recursive: true, force: true });
});

describe("ledger optimistic concurrency", () => {
  it("rejects a write based on an outdated document version", async () => {
    const initial = await readLedgerFromSqlite();
    const firstWrite = createLedgerDocument([]);
    await writeLedgerToSqlite(firstWrite, initial.updatedAt);

    await expect(
      writeLedgerToSqlite(createLedgerDocument([]), initial.updatedAt),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(readLedgerFromSqlite()).resolves.toEqual(firstWrite);
  });

  it("keeps purchase projection consistent for create, update and delete", async () => {
    const initial = await readLedgerFromSqlite();
    const created = createLedgerDocument([
      {
        id: "purchase-1",
        platform: "Nintendo Switch",
        title: "Zelda",
        price: 60,
        currency: "USD",
        purchaseDate: "2026-08-20",
        region: "美版",
        format: "实体卡带",
        seller: "Store",
        coverUrl: "https://example.com/cover.jpg",
        officialUrl: "https://example.com/title/0100ZELDA",
        notes: "",
        soldDate: "",
        soldPrice: 0,
        soldCurrency: "USD",
      },
    ]);
    await writeLedgerToSqlite(created, initial.updatedAt);
    let { db } = await openLedgerDatabase();
    const projected = db
      .prepare(
        "SELECT title, title_id, cover_url, purchase_date, platform_family, deleted_at, projection_hash, raw_json FROM purchase_records WHERE id=?",
      )
      .get("purchase-1") as Record<string, unknown>;
    expect(projected).toMatchObject({
      title: "Zelda",
      title_id: "0100ZELDA",
      cover_url: "https://example.com/cover.jpg",
      purchase_date: "2026-08-20",
      platform_family: "Nintendo",
      deleted_at: null,
    });
    expect(projected.projection_hash).toBe(purchaseProjectionHash(projected.raw_json));
    db.close();

    const updated = createLedgerDocument([{ ...created.records[0], title: "Zelda Updated" }]);
    await writeLedgerToSqlite(updated, created.updatedAt);
    ({ db } = await openLedgerDatabase());
    expect(
      db.prepare("SELECT title, deleted_at FROM purchase_records WHERE id=?").get("purchase-1"),
    ).toMatchObject({ title: "Zelda Updated", deleted_at: null });
    db.close();

    const deleted = createLedgerDocument([]);
    await writeLedgerToSqlite(deleted, updated.updatedAt);
    ({ db } = await openLedgerDatabase());
    expect(
      db.prepare("SELECT deleted_at FROM purchase_records WHERE id=?").get("purchase-1"),
    ).toMatchObject({ deleted_at: deleted.updatedAt });
    db.close();
  });

  it("rolls back both ledger document and projection when projection sync fails", async () => {
    const initial = await readLedgerFromSqlite();
    const { db } = await openLedgerDatabase();
    db.exec(`CREATE TRIGGER fail_purchase_projection
      BEFORE INSERT ON purchase_records
      BEGIN SELECT RAISE(ABORT, 'INJECTED_PROJECTION_FAILURE'); END`);
    db.close();

    const document = createLedgerDocument([
      {
        id: "purchase-failure",
        platform: "Nintendo Switch",
        title: "Failure Game",
        price: 0,
        currency: "CNY",
        purchaseDate: "2026-08-24",
        region: "其他",
        format: "数字版",
        seller: "",
        coverUrl: "",
        officialUrl: "",
        notes: "",
        soldDate: "",
        soldPrice: 0,
        soldCurrency: "CNY",
      },
    ]);
    await expect(writeLedgerToSqlite(document, initial.updatedAt)).rejects.toThrow(
      "INJECTED_PROJECTION_FAILURE",
    );
    await expect(readLedgerFromSqlite()).resolves.toEqual(initial);
    const reopened = await openLedgerDatabase();
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM purchase_records").get()).toEqual({
      count: 0,
    });
    reopened.db.close();
  });

  it("keeps confirmed links when a projected purchase is deleted", async () => {
    const initial = await readLedgerFromSqlite();
    const purchase = createLedgerDocument([
      {
        id: "purchase-linked",
        platform: "Nintendo Switch",
        title: "Linked Game",
        price: 0,
        currency: "CNY",
        purchaseDate: "2026-08-20",
        region: "其他",
        format: "数字版",
        seller: "",
        coverUrl: "",
        officialUrl: "",
        notes: "",
        soldDate: "",
        soldPrice: 0,
        soldCurrency: "CNY",
      },
    ]);
    await writeLedgerToSqlite(purchase, initial.updatedAt);
    const { db } = await openLedgerDatabase();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO play_games(id,source,external_id,title,normalized_title,first_played_at,last_played_at,created_at,updated_at) VALUES('game-linked','manual','game-linked','Linked Game','linked game',?,?,?,?)",
    ).run(now, now, now, now);
    db.prepare(
      "INSERT INTO play_purchase_links(id,play_game_id,purchase_record_id,status,match_method,confidence,decided_at,decided_by,created_at,updated_at) VALUES('link','game-linked','purchase-linked','confirmed','manual',1,?,'admin',?,?)",
    ).run(now, now, now);
    db.close();
    const deleted = createLedgerDocument([]);
    await writeLedgerToSqlite(deleted, purchase.updatedAt);
    const reopened = await openLedgerDatabase();
    expect(
      reopened.db
        .prepare("SELECT purchase_record_id,status FROM play_purchase_links WHERE id='link'")
        .get(),
    ).toEqual({ purchase_record_id: "purchase-linked", status: "confirmed" });
    reopened.db.close();
  });

  it("creates and links one collection record from history without inventing a purchase date", async () => {
    await seedStorePlayGame("store-game");
    const [historyGame] = await listPlayGames("recent", "desc", "Animal Crossing");
    expect(historyGame.id).toMatch(
      /^game-entity:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(historyGame).toMatchObject({
      entityId: historyGame.id,
      sourceGameId: "store-game",
      coverUrl: "https://example.com/animal-crossing.jpg",
    });

    const input = {
      format: "数字版" as const,
      region: "港版" as const,
      purchaseDate: "",
      seller: "Nintendo eShop",
      price: 429,
      currency: "HKD" as const,
      notes: "由历史游玩生成",
      soldDate: "",
      soldPrice: 0,
      soldCurrency: "HKD" as const,
    };
    const created = await createCollectionFromPlayGame("store-game", input, "admin");

    expect(created).toMatchObject({
      created: true,
      updatedAt: expect.any(String),
      record: {
        platform: "Nintendo Switch",
        title: "Animal Crossing: New Horizons",
        purchaseDate: "",
        seller: "Nintendo eShop",
        coverUrl: "https://example.com/animal-crossing.jpg",
        officialUrl: "https://example.com/title/01006F8002326000",
      },
    });
    const ledger = await readLedgerFromSqlite();
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toEqual(created.record);

    const { db } = await openLedgerDatabase();
    const projection = db
      .prepare("SELECT purchase_date,raw_json FROM purchase_records WHERE id=?")
      .get(created.record.id) as { purchase_date: unknown; raw_json: string };
    expect(projection.purchase_date).toBeNull();
    expect(JSON.parse(projection.raw_json)).toMatchObject({
      purchaseDate: "",
      seller: "Nintendo eShop",
      format: "数字版",
    });
    expect(
      db
        .prepare(
          "SELECT play_game_id,purchase_record_id,status,match_method,decided_by FROM play_purchase_links WHERE play_game_id=?",
        )
        .get("store-game"),
    ).toEqual({
      play_game_id: "store-game",
      purchase_record_id: created.record.id,
      status: "confirmed",
      match_method: "manual",
      decided_by: "admin",
    });
    db.close();

    await expect(
      createCollectionFromPlayGame(
        "store-game",
        { ...input, purchaseDate: "2026-09-15", seller: "另一个渠道" },
        "other-admin",
      ),
    ).resolves.toMatchObject({ created: false, record: { id: created.record.id } });
    expect((await readLedgerFromSqlite()).records).toHaveLength(1);
  });

  it("rolls back the ledger and projection if linking a generated collection fails", async () => {
    await seedStorePlayGame("store-rollback");
    const { db } = await openLedgerDatabase();
    db.exec(`CREATE TRIGGER fail_generated_collection_link
      BEFORE INSERT ON play_purchase_links
      BEGIN SELECT RAISE(ABORT, 'INJECTED_LINK_FAILURE'); END`);
    db.close();

    await expect(
      createCollectionFromPlayGame(
        "store-rollback",
        {
          format: "数字版",
          region: "港版",
          purchaseDate: "",
          seller: "Nintendo eShop",
          price: 0,
          currency: "HKD",
          notes: "",
          soldDate: "",
          soldPrice: 0,
          soldCurrency: "HKD",
        },
        "admin",
      ),
    ).rejects.toThrow("INJECTED_LINK_FAILURE");

    await expect(readLedgerFromSqlite()).resolves.toMatchObject({ records: [] });
    const reopened = await openLedgerDatabase();
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM ledger_documents").get()).toEqual({
      count: 0,
    });
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM purchase_records").get()).toEqual({
      count: 0,
    });
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM play_purchase_links").get()).toEqual({
      count: 0,
    });
    reopened.db.close();
  });

  it("uses the NS library form edits when completing a history-only game", async () => {
    await seedStorePlayGame("store-customized");

    const created = await createCollectionFromPlayGame(
      "store-customized",
      {
        title: "集合啦！动物森友会",
        coverUrl: "https://example.com/custom-cover.jpg",
        officialUrl: "https://example.com/custom-game",
        format: "实体卡带",
        region: "日版",
        purchaseDate: "2026-09-15",
        seller: "线下店",
        price: 299,
        currency: "CNY",
        notes: "从历史游戏完善",
        soldDate: "",
        soldPrice: 0,
        soldCurrency: "CNY",
      },
      "admin",
    );

    expect(created.record).toMatchObject({
      title: "集合啦！动物森友会",
      coverUrl: "https://example.com/custom-cover.jpg",
      officialUrl: "https://example.com/custom-game",
      format: "实体卡带",
      region: "日版",
    });
    expect((await listPlayGames("recent", "desc", "Animal Crossing")).at(0)?.link).toMatchObject({
      status: "confirmed",
      purchaseRecordId: created.record.id,
    });
  });
});

async function seedStorePlayGame(id: string) {
  const { db } = await openLedgerDatabase();
  const now = "2026-09-14T08:00:00.000Z";
  db.prepare(
    `INSERT INTO play_games(
      id,source,external_id,title,normalized_title,title_id,official_url,platform,
      first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "nintendo_store",
    `store:${id}`,
    "Animal Crossing: New Horizons",
    "animalcrossingnewhorizons",
    "01006F8002326000",
    "https://example.com/title/01006F8002326000",
    "Nintendo Switch 2",
    "2020-03-20T00:00:00.000Z",
    now,
    7_200,
    2,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO nintendo_store_sync_snapshots(
      id,fetched_at,authentication,payload_sha256,source_title_count,imported_title_count,
      skipped_title_count,imported_daily_count,skipped_daily_count,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(`snapshot:${id}`, now, "access_token", "a".repeat(64), 1, 1, 0, 0, 0, now);
  db.prepare(
    `INSERT INTO nintendo_store_game_snapshots(
      snapshot_id,play_game_id,external_id,title_id,title,platform,image_url,
      first_played_at,last_played_at,total_seconds,play_days
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `snapshot:${id}`,
    id,
    `store:${id}`,
    "01006F8002326000",
    "Animal Crossing: New Horizons",
    "Nintendo Switch 2",
    "https://example.com/animal-crossing.jpg",
    "2020-03-20T00:00:00.000Z",
    now,
    7_200,
    2,
  );
  db.close();
}
