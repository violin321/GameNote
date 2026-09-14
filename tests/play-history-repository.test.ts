import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLedgerDocument, type GameRecord } from "../lib/ledger/schema";
import { readLedgerFromSqlite, writeLedgerToSqlite } from "../lib/ledger/repository";
import {
  commitImportBatch,
  decidePurchaseLink,
  ImportConflictError,
  ImportInvalidError,
  listPlayGames,
  listRecentSessions,
  listUnlinkedPlayGames,
  migratePlayDatabase,
  openPlayDatabase,
  saveImportPreview,
} from "../lib/play-history/repository";
import { payloadSha256, validateImportPayload } from "../lib/play-history/validation";

let testDirectory = "";

const basePayload = {
  version: 1,
  games: [
    {
      externalId: "game-1",
      title: "Skyward Atlas",
      titleId: "TITLE0001",
      officialUrl: "https://example.com/title/TITLE0001",
      sessions: [
        {
          externalId: "session-1",
          startedAt: "2026-08-20T10:00:00Z",
          endedAt: "2026-08-20T11:00:00Z",
          durationSeconds: 3_600,
        },
        {
          externalId: "session-2",
          startedAt: "2026-08-21T10:00:00Z",
          endedAt: "2026-08-21T10:30:00Z",
          durationSeconds: 1_800,
        },
      ],
    },
  ],
};

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "gamenote-play-"));
  process.env.APP_DATABASE_FILE = join(testDirectory, "gamenote.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(testDirectory, { recursive: true, force: true });
});

describe("play-history repository", () => {
  it("keeps connector audit tables out of the generic schema", async () => {
    const db = await openPlayDatabase();
    try {
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      );
      expect(tables.has("play_observations")).toBe(true);
      expect(tables.has("moon_connector_accounts")).toBe(false);
      expect(tables.has("nintendo_store_sync_snapshots")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("replays preview and commit idempotently and ignores repeated sessions across batches", async () => {
    const raw = JSON.stringify(basePayload);
    const preview = validateImportPayload(basePayload);
    const saved = await saveImportPreview("preview-idem-0001", payloadSha256(raw), preview);

    expect(saved.replayed).toBe(false);
    await expect(
      saveImportPreview("preview-idem-0001", payloadSha256(raw), preview),
    ).resolves.toMatchObject({ batchId: saved.batchId, replayed: true });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      insertedGames: 1,
      insertedSessions: 2,
      replayed: false,
    });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      insertedSessions: 0,
      replayed: true,
    });

    const repeatedSessionPayload = {
      ...basePayload,
      games: [
        {
          ...basePayload.games[0],
          sessions: [
            basePayload.games[0].sessions[0],
            {
              externalId: "session-3",
              startedAt: "2026-08-22T10:00:00Z",
              endedAt: "2026-08-22T10:15:00Z",
              durationSeconds: 900,
            },
          ],
        },
      ],
    };
    const repeated = await saveImportPreview(
      "preview-idem-0002",
      payloadSha256(JSON.stringify(repeatedSessionPayload)),
      validateImportPayload(repeatedSessionPayload),
    );

    await expect(commitImportBatch(repeated.batchId)).resolves.toMatchObject({
      insertedGames: 0,
      insertedSessions: 1,
    });
    await expect(listPlayGames("recent", "desc", "Skyward")).resolves.toEqual([
      expect.objectContaining({
        totalSeconds: 6_300,
        playDays: 3,
        sessionCount: 3,
      }),
    ]);
  });

  it("rejects reuse of an idempotency key for a different payload", async () => {
    const preview = validateImportPayload(basePayload);
    await saveImportPreview("preview-conflict", payloadSha256("first"), preview);

    await expect(
      saveImportPreview("preview-conflict", payloadSha256("second"), preview),
    ).rejects.toBeInstanceOf(ImportConflictError);
  });

  it("adds and backfills source/date columns for databases created by the earlier schema", async () => {
    const legacy = await openPlayDatabase();
    legacy.exec(`
      DROP INDEX IF EXISTS idx_play_games_source_identity;
      DROP INDEX IF EXISTS idx_play_sessions_source_identity;
      DROP INDEX IF EXISTS idx_play_sessions_played_date;
      ALTER TABLE play_games DROP COLUMN source_id;
      ALTER TABLE import_batches DROP COLUMN source_id;
      ALTER TABLE play_sessions DROP COLUMN source_id;
      ALTER TABLE play_sessions DROP COLUMN played_date;

      INSERT INTO play_games(
        id, source, external_id, title, normalized_title, title_id,
        official_url, platform, first_played_at, last_played_at,
        total_seconds, play_days, created_at, updated_at
      ) VALUES(
        'legacy-game', 'json_import', 'legacy-game', 'Legacy Game', 'legacygame', '',
        '', 'Nintendo Switch', '2026-08-20T16:30:00.000Z', '2026-08-20T17:00:00.000Z',
        1800, 1, '2026-08-20T17:00:00.000Z', '2026-08-20T17:00:00.000Z'
      );
      INSERT INTO play_sessions(
        id, game_id, source, external_id, started_at, ended_at,
        duration_seconds, imported_at
      ) VALUES(
        'legacy-session', 'legacy-game', 'json_import', 'legacy-session',
        '2026-08-20T16:30:00.000Z', '2026-08-20T17:00:00.000Z', 1800,
        '2026-08-20T17:00:00.000Z'
      );
    `);
    legacy.close();

    await migratePlayDatabase();
    const migrated = await openPlayDatabase();
    try {
      const gameColumns = migrated.prepare("PRAGMA table_info(play_games)").all() as Array<{
        name: string;
      }>;
      const sessionColumns = migrated.prepare("PRAGMA table_info(play_sessions)").all() as Array<{
        name: string;
      }>;
      expect(gameColumns.map((column) => column.name)).toContain("source_id");
      expect(sessionColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["source_id", "played_date"]),
      );
      expect(
        migrated
          .prepare("SELECT source_id, played_date FROM play_sessions WHERE id = 'legacy-session'")
          .get(),
      ).toEqual({ source_id: "default", played_date: "2026-08-20" });
    } finally {
      migrated.close();
    }

    const correction = {
      version: 1,
      games: [
        {
          externalId: "legacy-game",
          title: "Legacy Game",
          sessions: [
            {
              externalId: "legacy-session",
              startedAt: "2026-08-21T00:30:00+08:00",
              endedAt: "2026-08-21T01:00:00+08:00",
              durationSeconds: 1_800,
            },
          ],
        },
      ],
    };
    const saved = await saveImportPreview(
      "legacy-date-correction",
      payloadSha256(JSON.stringify(correction)),
      validateImportPayload(correction),
    );
    expect(saved.preview).toMatchObject({ valid: true, existingSessions: 1 });
    await expect(commitImportBatch(saved.batchId)).resolves.toMatchObject({
      insertedSessions: 0,
    });
    const corrected = await openPlayDatabase();
    try {
      expect(
        corrected
          .prepare("SELECT played_date FROM play_sessions WHERE id = 'legacy-session'")
          .get(),
      ).toEqual({ played_date: "2026-08-21" });
    } finally {
      corrected.close();
    }
  });

  it("sorts history independently by recent activity and total duration", async () => {
    const payload = {
      version: 1,
      games: [
        {
          externalId: "older-long-game",
          title: "Amber Expedition",
          sessions: [
            {
              externalId: "older-long-session",
              startedAt: "2026-08-01T10:00:00Z",
              endedAt: "2026-08-01T13:00:00Z",
              durationSeconds: 10_800,
            },
          ],
        },
        {
          externalId: "newer-short-game",
          title: "Blue Horizon",
          sessions: [
            {
              externalId: "newer-short-session",
              startedAt: "2026-09-10T10:00:00Z",
              endedAt: "2026-09-10T10:30:00Z",
              durationSeconds: 1_800,
            },
          ],
        },
      ],
    };
    await importPayload("history-sorting", payload);

    expect((await listPlayGames("recent", "desc", "")).map((game) => game.title)).toEqual([
      "Blue Horizon",
      "Amber Expedition",
    ]);
    expect((await listPlayGames("total", "desc", "")).map((game) => game.title)).toEqual([
      "Amber Expedition",
      "Blue Horizon",
    ]);
    expect((await listPlayGames("title", "asc", "")).map((game) => game.title)).toEqual([
      "Amber Expedition",
      "Blue Horizon",
    ]);
    expect((await listPlayGames("title", "", "")).map((game) => game.title)).toEqual([
      "Amber Expedition",
      "Blue Horizon",
    ]);
  });

  it("sorts first-played independently from the latest activity", async () => {
    await importPayload("first-played-sorting", {
      version: 1,
      games: [
        {
          externalId: "long-running-game",
          title: "Long Running",
          sessions: [
            session("long-running-first", "2026-01-01T10:00:00Z"),
            session("long-running-latest", "2026-09-10T10:00:00Z"),
          ],
        },
        {
          externalId: "newly-started-game",
          title: "Newly Started",
          sessions: [session("newly-started-only", "2026-08-01T10:00:00Z")],
        },
      ],
    });

    expect((await listPlayGames("recent", "desc", "")).map((game) => game.title)).toEqual([
      "Long Running",
      "Newly Started",
    ]);
    expect((await listPlayGames("first", "desc", "")).map((game) => game.title)).toEqual([
      "Newly Started",
      "Long Running",
    ]);
  });

  it("returns a newest-first session timeline in the 7, 30 and 90 day windows", async () => {
    await importPayload("recent-windows", {
      version: 1,
      games: [
        {
          externalId: "timeline-game",
          title: "Timeline Fixture",
          sessions: [
            session("within-seven", "2026-09-10T10:00:00Z"),
            session("within-thirty", "2026-08-24T10:00:00Z"),
            session("within-ninety", "2026-07-01T10:00:00Z"),
            session("outside-ninety", "2026-05-01T10:00:00Z"),
          ],
        },
      ],
    });
    const now = new Date("2026-09-14T12:00:00Z");

    expect((await listRecentSessions(7, now)).map((item) => item.startedAt)).toEqual([
      "2026-09-10T10:00:00.000Z",
    ]);
    expect((await listRecentSessions(30, now)).map((item) => item.startedAt)).toEqual([
      "2026-09-10T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
    ]);
    expect((await listRecentSessions(90, now)).map((item) => item.startedAt)).toEqual([
      "2026-09-10T10:00:00.000Z",
      "2026-08-24T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
    ]);
  });

  it("unions exact sessions with daily observations and excludes lifetime snapshots", async () => {
    await importPayload("recent-observation-timeline", {
      version: 1,
      games: [
        {
          externalId: "timeline-observation-fixture",
          title: "Timeline Observation Fixture",
          titleId: "TIMELINE0001",
          sessions: [session("timeline-recent", "2026-09-14T10:00:00Z")],
        },
      ],
    });
    const db = await openPlayDatabase();
    try {
      db.exec(`
        INSERT INTO play_games(
          id,source,source_id,external_id,title,normalized_title,title_id,official_url,platform,
          first_played_at,last_played_at,total_seconds,play_days,time_semantics,created_at,updated_at
        ) VALUES
          ('daily-game','moon_connector','fixture-account','daily-game','Shared Observation Fixture',
           'sharedobservationfixture','SHARED0001','','Nintendo Switch','2026-09-13','2026-09-13',
           1800,1,'daily_aggregate','2026-09-14T01:00:00Z','2026-09-14T01:00:00Z'),
          ('snapshot-game','nintendo_store','official-store','snapshot-game','Shared Observation Fixture',
           'sharedobservationfixture','SHARED0001','','Nintendo Switch','2026-01-01','2026-09-13',
           12000,5,'snapshot_observation','2026-09-14T01:00:00Z','2026-09-14T01:00:00Z');

        INSERT INTO play_observations(
          id,game_id,source,source_id,external_id,source_record_id,observed_date,observed_at,
          total_seconds,play_days,first_played_at,last_played_at,image_url,time_semantics,
          report_status,imported_at
        ) VALUES
          ('daily-observation','daily-game','moon_connector','fixture-account','daily-1','report-1',
           '2026-09-13','2026-09-14T01:00:00Z',1800,1,'','',
           'https://example.com/daily.jpg','daily_aggregate','ACHIEVED','2026-09-14T01:00:00Z'),
          ('snapshot-observation','snapshot-game','nintendo_store','official-store','snapshot-1',
           'snapshot-1','2026-09-14','2026-09-14T01:00:00Z',12000,5,
           '2026-01-01','2026-09-13','','snapshot_observation','','2026-09-14T01:00:00Z');
      `);
    } finally {
      db.close();
    }

    expect(await listRecentSessions(7, new Date("2026-09-14T12:00:00Z"))).toEqual([
      expect.objectContaining({
        title: "Timeline Observation Fixture",
        startedAt: "2026-09-14T10:00:00.000Z",
        endedAt: "2026-09-14T10:30:00.000Z",
        timeSemantics: "play_timeline",
      }),
      expect.objectContaining({
        title: "Shared Observation Fixture",
        playedDate: "2026-09-13",
        durationSeconds: 1800,
        startedAt: null,
        endedAt: null,
        coverUrl: "https://example.com/daily.jpg",
        timeSemantics: "daily_aggregate",
        reportStatus: "ACHIEVED",
      }),
    ]);

    const shared = await listPlayGames("title", "asc", "Shared Observation");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((game) => game.aggregateKey)).size).toBe(1);
    expect(shared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "moon_connector",
          sessionCount: 0,
          observationCount: 1,
        }),
        expect.objectContaining({
          source: "nintendo_store",
          sessionCount: 0,
          observationCount: 1,
        }),
      ]),
    );
  });

  it("uses the source-local played date for both timeline groups and play-day totals", async () => {
    await importPayload("source-local-day", {
      version: 1,
      games: [
        {
          externalId: "local-day-game",
          title: "Local Day Fixture",
          sessions: [
            {
              externalId: "local-day-early",
              startedAt: "2026-08-21T00:30:00+08:00",
              endedAt: "2026-08-21T01:00:00+08:00",
              durationSeconds: 1_800,
            },
            {
              externalId: "local-day-late",
              startedAt: "2026-08-21T23:00:00+08:00",
              endedAt: "2026-08-21T23:30:00+08:00",
              durationSeconds: 1_800,
            },
          ],
        },
      ],
    });

    expect((await listPlayGames("recent", "desc", "Local Day"))[0].playDays).toBe(1);
    const recent = await listRecentSessions(90, new Date("2026-09-14T12:00:00Z"));
    expect(recent.map((item) => item.playedDate)).toEqual(["2026-08-21", "2026-08-21"]);
  });

  it("namespaces identical external IDs by sourceId and reports stored duplicates or conflicts", async () => {
    const payloadFor = (sourceId: string) => ({
      ...basePayload,
      sourceId,
    });
    await importPayload("source-a-import", payloadFor("console-a"));
    await importPayload("source-b-import", payloadFor("console-b"));

    const games = await listPlayGames("title", "", "Skyward");
    expect(games).toHaveLength(2);
    expect(new Set(games.map((game) => game.sourceId))).toEqual(
      new Set(["console-a", "console-b"]),
    );

    const duplicatePayload = payloadFor("console-a");
    const duplicateSaved = await saveImportPreview(
      "source-a-duplicate",
      payloadSha256(JSON.stringify(duplicatePayload)),
      validateImportPayload(duplicatePayload),
    );
    expect(duplicateSaved.preview).toMatchObject({
      valid: true,
      existingGames: 1,
      existingSessions: 2,
      conflictingGames: 0,
      conflictingSessions: 0,
    });

    const conflictingPayload = {
      ...duplicatePayload,
      games: [
        {
          ...duplicatePayload.games[0],
          sessions: [
            {
              ...duplicatePayload.games[0].sessions[0],
              endedAt: "2026-08-20T11:15:00Z",
              durationSeconds: 4_500,
            },
          ],
        },
      ],
    };
    const conflictSaved = await saveImportPreview(
      "source-a-conflict",
      payloadSha256(JSON.stringify(conflictingPayload)),
      validateImportPayload(conflictingPayload),
    );
    expect(conflictSaved.preview).toMatchObject({
      valid: false,
      existingGames: 1,
      existingSessions: 1,
      conflictingSessions: 1,
    });
    await expect(commitImportBatch(conflictSaved.batchId)).rejects.toBeInstanceOf(
      ImportInvalidError,
    );
  });

  it("keeps canonical import items aligned when earlier input games are invalid", async () => {
    const payload = {
      version: 1,
      games: [
        { externalId: "invalid-first", title: "Invalid First", sessions: [] },
        basePayload.games[0],
      ],
    };
    const preview = validateImportPayload(payload);
    expect(preview.valid).toBe(false);
    expect(preview.games[0].itemIndex).toBe(1);
    const saved = await saveImportPreview(
      "invalid-item-alignment",
      payloadSha256(JSON.stringify(payload)),
      preview,
    );
    const db = await openPlayDatabase();
    try {
      const items = db
        .prepare(
          `SELECT item_index, external_id, status, canonical_json
          FROM import_items WHERE batch_id = ? ORDER BY item_index`,
        )
        .all(saved.batchId) as Array<Record<string, unknown>>;
      expect(items).toEqual([
        expect.objectContaining({ item_index: 0, status: "invalid", canonical_json: null }),
        expect.objectContaining({ item_index: 1, status: "valid", external_id: "game-1" }),
      ]);
      expect(JSON.parse(String(items[1].canonical_json))).toMatchObject({
        itemIndex: 1,
        externalId: "game-1",
      });
    } finally {
      db.close();
    }
  });

  it("suggests, confirms, rejects and replaces collection links", async () => {
    await replacePurchases([
      purchaseRecord({
        id: "purchase-auto",
        title: "Skyward Atlas",
        officialUrl: "https://example.com/title/TITLE0001",
      }),
      purchaseRecord({ id: "purchase-other", title: "Alternate Edition" }),
    ]);
    await importPayload("link-lifecycle", basePayload);
    const [game] = await listPlayGames("recent", "desc", "Skyward");

    expect(game.link).toMatchObject({
      status: "suggested",
      method: "official_url",
      purchaseRecordId: "purchase-auto",
    });
    expect(game.aggregateKey).toBe("title-id:Nintendo Switch:title0001");
    expect(await listUnlinkedPlayGames()).toHaveLength(1);

    await decidePurchaseLink(game.id, "confirm", "purchase-auto", "owner");
    const confirmed = (await listPlayGames("recent", "desc", "Skyward"))[0];
    expect(confirmed.link).toMatchObject({
      status: "confirmed",
      method: "manual",
      purchaseRecordId: "purchase-auto",
    });
    expect(confirmed.aggregateKey).toBe("purchase:purchase-auto");
    expect(await listUnlinkedPlayGames()).toHaveLength(0);

    await decidePurchaseLink(game.id, "reject", null, "owner");
    const rejected = (await listPlayGames("recent", "desc", "Skyward"))[0];
    expect(rejected.link).toMatchObject({
      status: "rejected",
      purchaseRecordId: null,
    });
    expect(rejected.aggregateKey).toBe("title-id:Nintendo Switch:title0001");
    expect(await listUnlinkedPlayGames()).toHaveLength(1);

    await decidePurchaseLink(game.id, "confirm", "purchase-other", "owner");
    const replaced = (await listPlayGames("recent", "desc", "Skyward"))[0];
    expect(replaced.link).toMatchObject({
      status: "confirmed",
      method: "manual",
      purchaseRecordId: "purchase-other",
      purchaseTitle: "Alternate Edition",
    });
    expect(replaced.aggregateKey).toBe("purchase:purchase-other");
  });

  it("only creates automatic collection suggestions within the same platform", async () => {
    await replacePurchases([
      purchaseRecord({
        id: "purchase-wrong-platform",
        platform: "PlayStation",
        title: "Skyward Atlas",
        officialUrl: "https://example.com/title/TITLE0001",
      }),
      purchaseRecord({
        id: "purchase-correct-platform",
        title: "Skyward Atlas",
        officialUrl: "https://example.com/title/TITLE0001",
      }),
    ]);
    await importPayload("platform-scoped-link", basePayload);

    expect((await listPlayGames("recent", "desc", "Skyward"))[0].link).toMatchObject({
      status: "suggested",
      purchaseRecordId: "purchase-correct-platform",
    });
  });

  it("keeps play history safe when a linked collection record is deleted", async () => {
    const linkedPurchase = purchaseRecord({
      id: "purchase-linked",
      title: "Skyward Atlas",
      officialUrl: "https://example.com/title/TITLE0001",
    });
    await replacePurchases([linkedPurchase]);
    await importPayload("deleted-link", basePayload);
    const [game] = await listPlayGames("recent", "desc", "Skyward");
    await decidePurchaseLink(game.id, "confirm", linkedPurchase.id, "owner");

    await replacePurchases([]);

    expect((await listPlayGames("recent", "desc", "Skyward"))[0]).toMatchObject({
      id: game.id,
      totalSeconds: 5_400,
      link: {
        status: "confirmed",
        purchaseRecordId: "purchase-linked",
      },
    });
    await expect(
      decidePurchaseLink(game.id, "confirm", linkedPurchase.id, "owner"),
    ).rejects.toBeInstanceOf(ImportInvalidError);
  });
});

async function importPayload(idempotencyKey: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const preview = validateImportPayload(payload);
  expect(preview.valid).toBe(true);
  const saved = await saveImportPreview(idempotencyKey, payloadSha256(raw), preview);
  return commitImportBatch(saved.batchId);
}

async function replacePurchases(records: GameRecord[]) {
  const current = await readLedgerFromSqlite();
  const next = createLedgerDocument(records);
  await writeLedgerToSqlite(next, current.updatedAt);
}

function purchaseRecord(overrides: Pick<GameRecord, "id" | "title"> & Partial<GameRecord>) {
  const { id, title, ...optionalFields } = overrides;
  return {
    id,
    platform: "Nintendo Switch",
    title,
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
    ...optionalFields,
  } satisfies GameRecord;
}

function session(externalId: string, startedAt: string) {
  return {
    externalId,
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + 30 * 60 * 1_000).toISOString(),
    durationSeconds: 1_800,
  };
}
