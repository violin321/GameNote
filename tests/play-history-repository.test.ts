import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitImportBatch,
  createManualPlayEntry,
  decidePurchaseLink,
  getPlayGameDetail,
  ImportConflictError,
  getPlayTableCounts,
  ImportInvalidError,
  listPlayGames,
  listRecentPlayActivity,
  listRecentSessions,
  migratePlayDatabase,
  saveImportPreview,
} from "../lib/play-history/repository";
import { payloadSha256, validateImportPayload } from "../lib/play-history/validation";
import { writeLedgerToSqlite } from "../lib/ledger/repository";
import type { GameRecord } from "../lib/ledger/schema";

let directory = "";
const payload = {
  version: 1,
  games: [
    {
      externalId: "g-1",
      title: "塞尔达传说 王国之泪",
      titleId: "0100ZELDA",
      officialUrl: "https://example.com/title/0100ZELDA",
      sessions: [
        {
          externalId: "s-1",
          startedAt: "2026-08-20T10:00:00Z",
          endedAt: "2026-08-20T11:00:00Z",
          durationSeconds: 3600,
        },
        {
          externalId: "s-2",
          startedAt: "2026-08-21T10:00:00Z",
          endedAt: "2026-08-21T10:30:00Z",
          durationSeconds: 1800,
        },
      ],
      observations: [],
    },
  ],
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-play-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  await migratePlayDatabase();
});
afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

describe("play-history repository", () => {
  it("migrates, previews, commits and replays idempotently", async () => {
    await seedPurchaseRecords([
      {
        id: "purchase-1",
        title: "塞尔达传说 王国之泪",
        officialUrl: "https://example.com/title/0100ZELDA",
      },
    ]);
    const raw = JSON.stringify(payload);
    const preview = validateImportPayload(payload);
    const saved = await saveImportPreview("idem-key-0001", payloadSha256(raw), preview);
    expect(saved.replayed).toBe(false);
    await expect(
      saveImportPreview("idem-key-0001", payloadSha256(raw), preview),
    ).resolves.toMatchObject({ replayed: true, batchId: saved.batchId });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      insertedGames: 1,
      insertedSessions: 2,
      replayed: false,
    });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      replayed: true,
      insertedSessions: 0,
    });
    const games = await listPlayGames("recent", "desc", "塞尔达");
    expect(games[0]).toMatchObject({
      totalSeconds: 5400,
      playDays: 2,
      sessionCount: 2,
      link: { status: "suggested", method: "title_id", purchaseRecordId: "purchase-1" },
    });
  });

  it("serializes concurrent preview and commit requests atomically", async () => {
    const preview = validateImportPayload(payload);
    const hash = payloadSha256(JSON.stringify(payload));
    const previews = await Promise.all(
      Array.from({ length: 16 }, () => saveImportPreview("idem-key-concurrent", hash, preview)),
    );
    expect(new Set(previews.map((item) => item.batchId)).size).toBe(1);
    expect(previews.filter((item) => !item.replayed)).toHaveLength(1);

    const commits = await Promise.all(
      Array.from({ length: 8 }, () => commitImportBatch(previews[0].batchId)),
    );
    expect(commits.filter((item) => !item.replayed)).toHaveLength(1);
    expect(commits.reduce((sum, item) => sum + item.insertedSessions, 0)).toBe(2);
    expect(await getPlayTableCounts()).toMatchObject({
      import_batches: 1,
      import_items: 1,
      play_games: 1,
      play_sessions: 2,
      play_observations: 2,
    });
  });

  it("returns conflict when concurrent callers reuse a key for different payloads", async () => {
    const preview = validateImportPayload(payload);
    const results = await Promise.allSettled([
      saveImportPreview("idem-key-conflict", payloadSha256("first"), preview),
      saveImportPreview("idem-key-conflict", payloadSha256("second"), preview),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: expect.any(ImportConflictError) });
    expect(await getPlayTableCounts()).toMatchObject({ import_batches: 1, import_items: 1 });
  });

  it("rolls the whole transaction back on failure", async () => {
    const preview = validateImportPayload(payload);
    const saved = await saveImportPreview(
      "idem-key-rollback",
      payloadSha256(JSON.stringify(payload)),
      preview,
    );
    await expect(
      commitImportBatch(saved.batchId, { injectFailureAfterSession: 1 }),
    ).rejects.toThrow("INJECTED_IMPORT_FAILURE");
    expect(await getPlayTableCounts()).toMatchObject({
      play_games: 0,
      play_sessions: 0,
      play_observations: 0,
    });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      insertedGames: 1,
      insertedSessions: 2,
    });
  });

  it("rejects manual confirmation against a soft-deleted purchase", async () => {
    await seedPurchaseRecords([
      {
        id: "purchase-deleted",
        title: "Deleted Purchase",
        officialUrl: "https://example.com/title/DELETED01",
      },
    ]);
    const saved = await saveImportPreview(
      "idem-key-deleted-purchase",
      payloadSha256("deleted-purchase"),
      validateImportPayload(payload),
    );
    await commitImportBatch(saved.batchId);
    const [game] = await listPlayGames("recent", "desc", "");
    const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
    db.prepare("UPDATE purchase_records SET deleted_at=? WHERE id=?").run(
      "2026-08-24T12:00:00Z",
      "purchase-deleted",
    );
    db.close();

    await expect(
      decidePurchaseLink(game.id, "confirm", "purchase-deleted", "admin"),
    ).rejects.toBeInstanceOf(ImportInvalidError);
  });

  it("allows an administrator to manually select and replace a purchase link", async () => {
    await seedPurchaseRecords([
      { id: "purchase-manual", title: "Manual Purchase" },
      { id: "purchase-other", title: "Other Purchase" },
    ]);
    const saved = await saveImportPreview(
      "idem-key-manual-link",
      payloadSha256("manual-link"),
      validateImportPayload(payload),
    );
    await commitImportBatch(saved.batchId);
    const [game] = await listPlayGames("recent", "desc", "");

    await decidePurchaseLink(game.id, "confirm", "purchase-manual", "admin");
    expect((await listPlayGames("recent", "desc", ""))[0].link).toMatchObject({
      status: "confirmed",
      method: "manual",
      purchaseRecordId: "purchase-manual",
      purchaseTitle: "Manual Purchase",
    });

    await decidePurchaseLink(game.id, "confirm", "purchase-other", "admin");
    expect((await listPlayGames("recent", "desc", ""))[0].link).toMatchObject({
      status: "confirmed",
      method: "manual",
      purchaseRecordId: "purchase-other",
    });
  });

  it("creates one reusable manual history game and links it to the selected collection", async () => {
    await seedPurchaseRecords([
      {
        id: "purchase-manual-entry",
        title: "Manual Timeline Game",
        platform: "Nintendo Switch",
        purchaseDate: "",
        seller: "Nintendo eShop",
      },
    ]);

    const first = await createManualPlayEntry(
      {
        playGameId: null,
        purchaseRecordId: "purchase-manual-entry",
        title: "",
        platform: "Nintendo Switch",
        startedAt: "2026-09-13T10:00:00.000Z",
        durationSeconds: 1800,
      },
      "admin",
    );
    const second = await createManualPlayEntry(
      {
        playGameId: null,
        purchaseRecordId: "purchase-manual-entry",
        title: "",
        platform: "Nintendo Switch",
        startedAt: "2026-09-14T10:00:00.000Z",
        durationSeconds: 2700,
      },
      "admin",
    );

    expect(second.gameId).toBe(first.gameId);
    expect(await listPlayGames("recent", "desc", "Manual Timeline Game")).toEqual([
      expect.objectContaining({
        id: first.entityId,
        entityId: first.entityId,
        sourceGameId: first.gameId,
        source: "manual",
        totalSeconds: 4500,
        playDays: 2,
        sessionCount: 2,
        timeSemantics: "play_timeline",
        link: expect.objectContaining({
          status: "confirmed",
          method: "manual",
          purchaseRecordId: "purchase-manual-entry",
        }),
      }),
    ]);
  });

  it("attaches a manual session to Store history without changing its official cumulative total", async () => {
    const now = "2026-09-14T08:00:00.000Z";
    const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
    db.prepare(
      `INSERT INTO play_games(
        id,source,external_id,title,normalized_title,title_id,platform,
        first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "store-history-game",
      "nintendo_store",
      "store:history-game",
      "Store History Game",
      "storehistorygame",
      "0100STOREHISTORY",
      "Nintendo Switch",
      "2020-01-01T00:00:00.000Z",
      now,
      72_000,
      20,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO play_games(
        id,source,external_id,title,normalized_title,title_id,platform,
        first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "store-history-other",
      "nintendo_store",
      "store:history-other",
      "Other History Game",
      "otherhistorygame",
      "0100STOREOTHER",
      "Nintendo Switch",
      "2020-01-01T00:00:00.000Z",
      "2026-09-14T09:00:00.000Z",
      36_000,
      10,
      now,
      now,
    );
    db.close();

    await createManualPlayEntry(
      {
        playGameId: "store-history-game",
        purchaseRecordId: null,
        title: "",
        platform: "Nintendo Switch",
        startedAt: "2026-09-14T10:00:00.000Z",
        durationSeconds: 1800,
      },
      "admin",
    );

    const games = await listPlayGames("recent", "desc", "History Game");
    expect(games.map((game) => game.sourceGameId)).toEqual([
      "store-history-game",
      "store-history-other",
    ]);
    const historyEntityId = games[0].entityId;
    expect(historyEntityId).toMatch(
      /^game-entity:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(games[0]).toMatchObject({
      id: historyEntityId,
      entityId: historyEntityId,
      sourceGameId: "store-history-game",
      source: "nintendo_store",
      totalSeconds: 72_000,
      playDays: 20,
      lastPlayedAt: "2026-09-14T10:30:00.000Z",
      sessionCount: 1,
      timeSemantics: "snapshot_observation",
    });
    expect(await getPlayGameDetail("store-history-game")).toMatchObject({
      id: historyEntityId,
      sourceGameId: "store-history-game",
      totalSeconds: 72_000,
      lastPlayedAt: "2026-09-14T10:30:00.000Z",
      sessions: [
        {
          source: "manual",
          startedAt: "2026-09-14T10:00:00.000Z",
          endedAt: "2026-09-14T10:30:00.000Z",
          durationSeconds: 1800,
        },
      ],
    });
    expect(await listRecentPlayActivity(7, new Date("2026-09-15T00:00:00.000Z"))).toEqual([
      expect.objectContaining({
        gameId: historyEntityId,
        source: "manual",
        timeSemantics: "play_timeline",
        seconds: 1800,
      }),
    ]);
  });

  it("does not overwrite confirmed or rejected decisions during later imports", async () => {
    await seedPurchaseRecords([
      {
        id: "purchase-1",
        title: "塞尔达传说 王国之泪",
        officialUrl: "https://example.com/title/0100ZELDA",
      },
    ]);
    const first = await saveImportPreview(
      "idem-key-decision-1",
      payloadSha256("one"),
      validateImportPayload(payload),
    );
    await commitImportBatch(first.batchId);
    const [game] = await listPlayGames("recent", "desc", "");
    await decidePurchaseLink(game.id, "reject", null, "admin");
    const secondPayload = {
      ...payload,
      games: [
        {
          ...payload.games[0],
          sessions: [
            ...payload.games[0].sessions,
            {
              externalId: "s-3",
              startedAt: "2026-08-22T10:00:00Z",
              endedAt: "2026-08-22T10:10:00Z",
              durationSeconds: 600,
            },
          ],
        },
      ],
    };
    const second = await saveImportPreview(
      "idem-key-decision-2",
      payloadSha256("two"),
      validateImportPayload(secondPayload),
    );
    await commitImportBatch(second.batchId);
    expect((await listPlayGames("recent", "desc", ""))[0].link?.status).toBe("rejected");
  });

  it("filters the real session timeline into 7, 30 and 90 day windows", async () => {
    const timelinePayload = {
      version: 1,
      games: [
        {
          externalId: "timeline-game",
          title: "Timeline Game",
          sessions: [
            {
              externalId: "recent",
              startedAt: "2026-08-20T10:00:00Z",
              endedAt: "2026-08-20T11:00:00Z",
              durationSeconds: 3600,
            },
            {
              externalId: "month",
              startedAt: "2026-08-01T10:00:00Z",
              endedAt: "2026-08-01T11:00:00Z",
              durationSeconds: 3600,
            },
            {
              externalId: "quarter",
              startedAt: "2026-06-15T10:00:00Z",
              endedAt: "2026-06-15T11:00:00Z",
              durationSeconds: 3600,
            },
            {
              externalId: "old",
              startedAt: "2026-04-01T10:00:00Z",
              endedAt: "2026-04-01T11:00:00Z",
              durationSeconds: 3600,
            },
          ],
        },
      ],
    };
    const saved = await saveImportPreview(
      "timeline-window",
      payloadSha256("timeline"),
      validateImportPayload(timelinePayload),
    );
    await commitImportBatch(saved.batchId);
    const now = new Date("2026-08-24T15:00:00Z");
    expect((await listRecentSessions(7, now)).map((item) => item.id)).toHaveLength(1);
    expect(await listRecentSessions(30, now)).toHaveLength(2);
    expect(await listRecentSessions(90, now)).toHaveLength(3);
  });

  it("keeps Nintendo cumulative observations out of the recent activity timeline", async () => {
    const activityPayload = {
      version: 1,
      games: [
        {
          externalId: "activity-game",
          title: "Activity Game",
          sessions: [
            {
              externalId: "activity-session",
              startedAt: "2026-08-23T10:00:00Z",
              endedAt: "2026-08-23T11:00:00Z",
              durationSeconds: 3600,
            },
          ],
          observations: [
            {
              externalId: "activity-observation-old",
              observedAt: "2026-08-22T08:00:00Z",
              totalSeconds: 5400,
              firstPlayedAt: "2026-08-01T08:00:00Z",
            },
            {
              externalId: "activity-observation-latest",
              observedAt: "2026-08-24T08:00:00Z",
              totalSeconds: 7200,
              firstPlayedAt: "2026-08-01T08:00:00Z",
            },
          ],
        },
      ],
    };
    const saved = await saveImportPreview(
      "recent-activity",
      payloadSha256("recent-activity"),
      validateImportPayload(activityPayload),
    );
    await commitImportBatch(saved.batchId, { source: "nintendo_connector" });

    expect((await listPlayGames("recent", "desc", "Activity Game"))[0]).toMatchObject({
      totalSeconds: 7200,
      timeSemantics: "snapshot_observation",
    });
    expect(await listRecentPlayActivity(7, new Date("2026-08-25T00:00:00Z"))).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        occurredAt: "2026-08-23T10:00:00.000Z",
        seconds: 3600,
        timeSemantics: "play_timeline",
      }),
    ]);
  });

  it("does not expose JSON import observations as cumulative Nintendo activity", async () => {
    const saved = await saveImportPreview(
      "recent-json-activity",
      payloadSha256("recent-json-activity"),
      validateImportPayload({
        version: 1,
        games: [
          {
            externalId: "json-activity-game",
            title: "JSON Activity Game",
            sessions: [
              {
                externalId: "json-activity-session",
                startedAt: "2026-08-23T10:00:00Z",
                endedAt: "2026-08-23T11:00:00Z",
                durationSeconds: 3600,
              },
            ],
            observations: [
              {
                externalId: "json-activity-observation",
                observedAt: "2026-08-24T08:00:00Z",
                totalSeconds: 7200,
                firstPlayedAt: "2026-08-01T08:00:00Z",
              },
            ],
          },
        ],
      }),
    );
    await commitImportBatch(saved.batchId);

    expect(await listRecentPlayActivity(7, new Date("2026-08-25T00:00:00Z"))).toEqual([
      expect.objectContaining({
        title: "JSON Activity Game",
        occurredAt: "2026-08-23T10:00:00.000Z",
        seconds: 3600,
        timeSemantics: "play_timeline",
      }),
    ]);
  });
});

async function seedPurchaseRecords(
  records: Array<Pick<GameRecord, "id" | "title"> & Partial<GameRecord>>,
) {
  await writeLedgerToSqlite({
    version: 1,
    updatedAt: new Date().toISOString(),
    records: records.map((record) => ({
      platform: "Nintendo Switch",
      price: 0,
      currency: "CNY",
      purchaseDate: "2026-08-24",
      region: "港版",
      format: "数字版",
      seller: "",
      coverUrl: "",
      officialUrl: "",
      notes: "",
      soldDate: "",
      soldPrice: 0,
      soldCurrency: "CNY",
      ...record,
    })),
  });
}
