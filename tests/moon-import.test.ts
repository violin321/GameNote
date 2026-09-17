import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importMoonSnapshot, readMoonImportStatus, validateMoonSnapshot } from "../lib/moon/import";
import type { MoonDailyReport, MoonSnapshot } from "../lib/moon/types";
import {
  commitImportBatch,
  decidePurchaseLink,
  getDashboardStats,
  getPlayGameDetail,
  getPlayTableCounts,
  listPlayGames,
  listPurchasePlaySummaries,
  listRecentPlayActivity,
  listUnlinkedPlayGames,
  migratePlayDatabase,
  saveImportPreview,
} from "../lib/play-history/repository";
import { payloadSha256, validateImportPayload } from "../lib/play-history/validation";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-moon-import-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  await migratePlayDatabase();
});
afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

function report(date = "2026-09-12", seconds = 1800): MoonDailyReport {
  return {
    deviceId: "device-a",
    date,
    timeZoneOffsetSeconds: 28_800,
    result: "ACHIEVED",
    updatedAt: "2026-09-12T03:00:00.000Z",
    totalSeconds: seconds,
    games: [
      {
        externalId: "moon:0100abcdefabcdef",
        title: "Moon Game",
        titleId: "0100abcdefabcdef",
        officialUrl: "https://example.com/title/0100abcdefabcdef",
        imageUrl: "https://example.com/moon.jpg",
        totalSeconds: seconds,
      },
    ],
  };
}
function snapshot(reports = [report()], fetchedAt = "2026-09-12T04:00:00.000Z"): MoonSnapshot {
  return {
    schema: "gamenote.moon.daily.v1",
    fetchedAt,
    accountScope: "account-a",
    devices: [{ id: "device-a" }],
    dailyReports: reports,
  };
}
function withDatabase<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    return run(db);
  } finally {
    db.close();
  }
}
function seedPurchase() {
  withDatabase((db) =>
    db
      .prepare(
        `INSERT INTO purchase_records(id,title,title_id,normalized_title,raw_json,imported_at,platform_family,cover_url)
    VALUES('purchase-moon','Moon Game','0100abcdefabcdef','moon game','{}','2026-09-12T00:00:00Z','Nintendo','https://example.com/collection.jpg')`,
      )
      .run(),
  );
}

describe("Moon calendar-day import", () => {
  it("matches Nintendo application IDs across uppercase collection and lowercase Moon spellings", async () => {
    seedPurchase();
    withDatabase((db) =>
      db
        .prepare(
          "UPDATE purchase_records SET title_id='0100ABCDEFABCDEF',normalized_title='different language',title='Different language'",
        )
        .run(),
    );
    await importMoonSnapshot(snapshot());
    expect((await listUnlinkedPlayGames())[0].link).toMatchObject({
      status: "suggested",
      method: "title_id",
      purchaseRecordId: "purchase-moon",
    });
  });

  it("stores exact days and creates history, detail and collection suggestions without fake sessions", async () => {
    seedPurchase();
    expect(await importMoonSnapshot(snapshot([report("2026-09-11", 900), report()]))).toEqual({
      importedReports: 2,
      importedGames: 1,
      replayed: false,
      latestDate: "2026-09-12",
    });
    const [game] = await listPlayGames("recent", "desc", "Moon");
    expect(game).toMatchObject({
      source: "moon_connector",
      totalSeconds: 2700,
      playDays: 2,
      firstPlayedAt: "2026-09-11",
      lastPlayedAt: "2026-09-12",
      timeSemantics: "daily_aggregate",
      sessionCount: 0,
      link: { status: "suggested", method: "title_id", purchaseRecordId: "purchase-moon" },
    });
    expect(await getPlayTableCounts()).toMatchObject({
      play_games: 1,
      play_sessions: 0,
      play_observations: 0,
      import_batches: 0,
    });
    expect(await listUnlinkedPlayGames()).toHaveLength(1);
    expect(await getPlayGameDetail(game.id)).toMatchObject({
      sessions: [],
      dailyReports: [
        {
          date: "2026-09-12",
          deviceId: "device-a",
          seconds: 1800,
          reportStatus: "ACHIEVED",
          timeZoneOffsetSeconds: 28800,
        },
        { date: "2026-09-11", seconds: 900 },
      ],
    });
    expect(await listRecentPlayActivity(7, new Date("2026-09-12T04:00:00Z"))).toEqual([
      expect.objectContaining({
        gameId: game.entityId,
        date: "2026-09-12",
        occurredAt: "2026-09-12",
        endedAt: null,
        source: "moon_connector",
        timeSemantics: "daily_aggregate",
        seconds: 1800,
        coverUrl: "https://example.com/moon.jpg",
      }),
      expect.objectContaining({ date: "2026-09-11", seconds: 900 }),
    ]);
    await decidePurchaseLink(game.id, "confirm", "purchase-moon", "admin");
    expect(await listUnlinkedPlayGames()).toHaveLength(0);
    expect(await listPurchasePlaySummaries()).toEqual([
      {
        purchaseRecordId: "purchase-moon",
        totalSeconds: 2700,
        firstPlayedAt: "2026-09-11",
        lastPlayedAt: "2026-09-12",
        timeSemantics: "daily_aggregate",
      },
    ]);
    expect((await listRecentPlayActivity(7, new Date("2026-09-12T04:00:00Z")))[0].coverUrl).toBe(
      "https://example.com/collection.jpg",
    );
    expect((await getDashboardStats(true)).play).toEqual({
      games: 1,
      totalSeconds: 2700,
      sessions: 0,
      lastPlayedAt: "2026-09-12",
      timeSemantics: "daily_aggregate",
    });
    expect(await readMoonImportStatus()).toEqual({
      lastImportedAt: expect.any(String),
      latestDate: "2026-09-12",
      reportCount: 2,
    });
  });

  it("prefers a Nintendo Store cumulative snapshot while retaining Moon daily evidence", async () => {
    await importMoonSnapshot(snapshot([report("2026-09-11", 900), report("2026-09-12", 1800)]));
    const [moonOnlyGame] = await listPlayGames("total", "desc", "Moon Game");

    // Store play history is an account-level cumulative counter. It is the
    // canonical game row when present; Moon's day-level evidence remains
    // available in details and is not added to the Store counter.
    withDatabase((db) =>
      db
        .prepare(
          `INSERT INTO play_games(
            id,source,external_id,title,normalized_title,title_id,platform,
            first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "store-game",
          "nintendo_store",
          "0100abcdefabcdef",
          "Moon Game",
          "moongame",
          "0100abcdefabcdef",
          "Nintendo Switch",
          "2026-01-01T00:00:00.000Z",
          "2026-09-12T00:00:00.000Z",
          18_000,
          42,
          "2026-09-12T05:00:00.000Z",
          "2026-09-12T05:00:00.000Z",
        ),
    );

    const games = await listPlayGames("total", "desc", "Moon Game");
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      id: moonOnlyGame.id,
      entityId: moonOnlyGame.id,
      sourceGameId: "store-game",
      source: "nintendo_store",
      totalSeconds: 18_000,
      playDays: 42,
      timeSemantics: "snapshot_observation",
    });
    expect(await getPlayGameDetail("store-game")).toMatchObject({
      id: moonOnlyGame.id,
      entityId: moonOnlyGame.id,
      sourceGameId: "store-game",
      dailyReports: [
        expect.objectContaining({ date: "2026-09-12", seconds: 1800 }),
        expect.objectContaining({ date: "2026-09-11", seconds: 900 }),
      ],
    });

    // Replaying Moon's identical daily payload must not alter the Store
    // counter or make the hidden Moon row reappear.
    await expect(
      importMoonSnapshot(snapshot([report("2026-09-11", 900), report("2026-09-12", 1800)])),
    ).resolves.toMatchObject({ replayed: true, importedReports: 0 });
    expect((await listPlayGames("total", "desc", "Moon Game"))[0]).toMatchObject({
      id: moonOnlyGame.id,
      sourceGameId: "store-game",
      totalSeconds: 18_000,
    });
  });

  it("uses the Store total even when it is lower and carries a Moon decision through the identity", async () => {
    seedPurchase();
    const chineseReport = report("2026-09-11", 900);
    chineseReport.games[0] = {
      ...chineseReport.games[0],
      title: "集合啦！动物森友会",
    };
    const latestChineseReport = report("2026-09-12", 1800);
    latestChineseReport.games[0] = {
      ...latestChineseReport.games[0],
      title: "集合啦！动物森友会",
    };
    await importMoonSnapshot(snapshot([chineseReport, latestChineseReport]));
    const [moonGame] = await listPlayGames("recent", "desc", "集合啦动物森友会");
    await decidePurchaseLink(moonGame.id, "confirm", "purchase-moon", "admin");

    withDatabase((db) => {
      db.prepare(
        `INSERT INTO play_games(
          id,source,external_id,title,normalized_title,title_id,platform,
          first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        "store-animal-crossing",
        "nintendo_store",
        "store:0100abcdefabcdef:nintendoswitch",
        "Animal Crossing: New Horizons",
        "animalcrossingnewhorizons",
        "0100ABCDEFABCDEF",
        "Nintendo Switch",
        "2026-01-01T00:00:00.000Z",
        "2026-09-10T17:25:47.000Z",
        600,
        1,
        "2026-09-12T05:00:00.000Z",
        "2026-09-12T05:00:00.000Z",
      );
      // This reproduces an older Store import that created its own automatic
      // suggestion before Store/Moon association copying was implemented.
      db.prepare(
        `INSERT INTO play_purchase_links(
          id,play_game_id,purchase_record_id,status,match_method,confidence,created_at,updated_at
        ) VALUES('store-suggestion','store-animal-crossing','purchase-moon','suggested','title_id',1,
          '2026-09-12T05:00:00.000Z','2026-09-12T05:00:00.000Z')`,
      ).run();
    });

    // The hidden Chinese Moon title remains a searchable alias for the English
    // Store representative, including the Store-specific platform metadata.
    const mergedGames = await listPlayGames("total", "desc", "集合啦动物森友会");
    const mergedEntityId = mergedGames[0].entityId;
    expect(mergedEntityId).toMatch(
      /^game-entity:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mergedGames).toEqual([
      expect.objectContaining({
        id: mergedEntityId,
        sourceGameId: "store-animal-crossing",
        source: "nintendo_store",
        platform: "Nintendo Switch",
        totalSeconds: 600,
        playDays: 1,
        lastPlayedAt: "2026-09-12",
        link: expect.objectContaining({
          status: "confirmed",
          method: "manual",
          purchaseRecordId: "purchase-moon",
        }),
      }),
    ]);
    expect(await listUnlinkedPlayGames()).toEqual([]);
    expect(await getPlayGameDetail("store-animal-crossing")).toMatchObject({
      id: mergedEntityId,
      sourceGameId: "store-animal-crossing",
      totalSeconds: 600,
      lastPlayedAt: "2026-09-12",
      platform: "Nintendo Switch",
      link: { status: "confirmed", purchaseRecordId: "purchase-moon" },
      dailyReports: [
        { date: "2026-09-12", seconds: 1800 },
        { date: "2026-09-11", seconds: 900 },
      ],
    });
    expect(await listPurchasePlaySummaries()).toEqual([
      {
        purchaseRecordId: "purchase-moon",
        totalSeconds: 600,
        firstPlayedAt: "2026-01-01T00:00:00.000Z",
        lastPlayedAt: "2026-09-10T17:25:47.000Z",
        timeSemantics: "snapshot_observation",
      },
    ]);
    expect((await getDashboardStats(true)).play).toEqual({
      games: 1,
      totalSeconds: 600,
      sessions: 0,
      lastPlayedAt: "2026-09-10T17:25:47.000Z",
      timeSemantics: "snapshot_observation",
    });
    expect(await listRecentPlayActivity(7, new Date("2026-09-12T04:00:00Z"))).toEqual([
      expect.objectContaining({ source: "moon_connector", date: "2026-09-12", seconds: 1800 }),
      expect.objectContaining({ source: "moon_connector", date: "2026-09-11", seconds: 900 }),
    ]);

    // A later manual decision on the visible Store row becomes the identity's
    // decision; the hidden Moon confirmation must not keep collection stats linked.
    await decidePurchaseLink("store-animal-crossing", "reject", null, "admin");
    expect(await listPurchasePlaySummaries()).toEqual([]);
    expect(await listUnlinkedPlayGames("集合啦动物森友会")).toEqual([
      expect.objectContaining({
        id: mergedEntityId,
        sourceGameId: "store-animal-crossing",
        link: expect.objectContaining({ status: "rejected", method: "manual" }),
      }),
    ]);
    expect(await listUnlinkedPlayGames("塞尔达")).toEqual([]);
    expect((await getDashboardStats(true)).purchases).toMatchObject({ linked: 0, unlinked: 1 });
  });

  it("replays reordered payloads and serializes concurrent imports idempotently", async () => {
    const source = snapshot([report("2026-09-11"), report()]);
    const results = await Promise.all(Array.from({ length: 8 }, () => importMoonSnapshot(source)));
    expect(results.filter((item) => !item.replayed)).toHaveLength(1);
    expect(
      await importMoonSnapshot({ ...source, dailyReports: [...source.dailyReports].reverse() }),
    ).toMatchObject({ replayed: true, importedReports: 0 });
    expect((await listPlayGames("recent", "desc", ""))[0].totalSeconds).toBe(3600);
    expect((await readMoonImportStatus()).reportCount).toBe(2);
  });

  it("replaces a day revision, retains absent historical days and manual decisions", async () => {
    seedPurchase();
    await importMoonSnapshot(snapshot([report("2026-09-11", 900), report()]));
    const [game] = await listPlayGames("recent", "desc", "");
    await decidePurchaseLink(game.id, "confirm", "purchase-moon", "admin");
    const revised = { ...report("2026-09-12", 600), updatedAt: "2026-09-12T05:00:00Z" };
    expect(await importMoonSnapshot(snapshot([revised], "2026-09-12T06:00:00Z"))).toMatchObject({
      importedReports: 1,
      importedGames: 0,
    });
    expect((await listPlayGames("total", "desc", ""))[0]).toMatchObject({
      id: game.id,
      totalSeconds: 1500,
      playDays: 2,
      link: { status: "confirmed", method: "manual", purchaseRecordId: "purchase-moon" },
    });
    await decidePurchaseLink(game.id, "reject", null, "admin");
    await importMoonSnapshot(
      snapshot(
        [{ ...revised, totalSeconds: 300, games: [{ ...revised.games[0], totalSeconds: 300 }] }],
        "2026-09-12T07:00:00Z",
      ),
    );
    expect((await listUnlinkedPlayGames())[0]).toMatchObject({
      id: game.id,
      totalSeconds: 1200,
      link: { status: "rejected", method: "manual" },
    });
  });

  it("stores zero-play and CALCULATING reports and removes invalidated game-day totals", async () => {
    const pending = { ...report(), result: "CALCULATING" as const };
    await importMoonSnapshot(snapshot([pending]));
    const [game] = await listPlayGames("recent", "desc", "");
    expect((await getPlayGameDetail(game.id))?.dailyReports[0].reportStatus).toBe("CALCULATING");
    const zero = { ...report(), totalSeconds: 0, games: [], updatedAt: "2026-09-12T05:00:00Z" };
    await importMoonSnapshot(snapshot([zero], "2026-09-12T06:00:00Z"));
    expect(await getPlayGameDetail(game.id)).toMatchObject({
      totalSeconds: 0,
      playDays: 0,
      firstPlayedAt: "",
      lastPlayedAt: "",
      dailyReports: [],
      sessions: [],
    });
    expect((await readMoonImportStatus()).reportCount).toBe(1);
    expect(await listRecentPlayActivity(7, new Date("2026-09-12T07:00:00Z"))).toEqual([]);
    expect(
      withDatabase((db) =>
        db.prepare("SELECT total_seconds,result FROM moon_connector_reports").get(),
      ),
    ).toEqual({ total_seconds: 0, result: "ACHIEVED" });
  });

  it("preserves explicit zero-minute game rows without counting them as played days", async () => {
    await importMoonSnapshot(snapshot([{ ...report("2026-09-12", 0), result: "CALCULATING" }]));
    expect((await listPlayGames("recent", "desc", ""))[0]).toMatchObject({
      totalSeconds: 0,
      playDays: 0,
      firstPlayedAt: "",
    });
    expect((await listRecentPlayActivity(7, new Date("2026-09-12T04:00:00Z")))[0]).toMatchObject({
      seconds: 0,
      date: "2026-09-12",
      reportStatus: "CALCULATING",
    });
  });

  it("keeps account/device source rows while resolving their shared title id to one entity", async () => {
    const first = snapshot();
    await importMoonSnapshot(first);
    await importMoonSnapshot({ ...first, accountScope: "account-b" });
    await importMoonSnapshot({
      ...snapshot([report(), { ...report(), deviceId: "device-b" }], "2026-09-12T05:00:00Z"),
      devices: [{ id: "device-a" }, { id: "device-b" }],
    });
    const games = await listPlayGames("title", "asc", "");
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      source: "moon_connector",
      totalSeconds: 5_400,
      playDays: 1,
      entityId: games[0].entityId,
    });
    expect(
      withDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM moon_connector_games").get()),
    ).toEqual({ count: 3 });
    expect(
      withDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM source_bindings").get()),
    ).toEqual({ count: 3 });
    expect(withDatabase((db) => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
  });

  it("rejects equal-clock conflicting snapshots and ignores stale envelopes and stale report revisions", async () => {
    await importMoonSnapshot(snapshot());
    await expect(importMoonSnapshot(snapshot([report("2026-09-12", 300)]))).rejects.toThrow(
      "snapshot_revision_conflict",
    );
    expect(
      await importMoonSnapshot(snapshot([report("2026-09-12", 300)], "2026-09-12T02:00:00Z")),
    ).toMatchObject({ replayed: true });
    expect(
      await importMoonSnapshot(
        snapshot(
          [{ ...report("2026-09-12", 300), updatedAt: "2026-09-12T01:00:00Z" }],
          "2026-09-12T05:00:00Z",
        ),
      ),
    ).toMatchObject({ importedReports: 0 });
    expect((await listPlayGames("total", "desc", ""))[0].totalSeconds).toBe(1800);
  });

  it("uses official-offset calendar windows, including a new local day before UTC midnight", async () => {
    const reports = [
      report("2026-09-05"),
      report("2026-09-06"),
      report("2026-09-12"),
      report("2026-09-13"),
    ];
    await importMoonSnapshot(snapshot(reports));
    const rows = await listRecentPlayActivity(7, new Date("2026-09-11T17:15:00Z"));
    expect(rows.map((row) => row.date)).toEqual(["2026-09-12", "2026-09-06"]);
    expect(rows[0].occurredAt).toBe("2026-09-12");
  });

  it("validates the full envelope before mutating even when a later report is malformed", async () => {
    const invalid = snapshot([report(), { ...report("2026-09-11"), totalSeconds: -1 }]);
    await expect(importMoonSnapshot(invalid)).rejects.toThrow("invalid_snapshot_seconds");
    expect(await getPlayTableCounts()).toMatchObject({ play_games: 0 });
    expect(await readMoonImportStatus()).toEqual({
      lastImportedAt: null,
      latestDate: null,
      reportCount: 0,
    });
  });

  it("rolls report replacement and account high-water mark back on a database write failure", async () => {
    await importMoonSnapshot(snapshot());
    withDatabase((db) =>
      db.exec(`CREATE TRIGGER fail_moon_rows BEFORE INSERT ON moon_connector_report_games
      BEGIN SELECT RAISE(ABORT,'INJECTED_MOON_FAILURE'); END`),
    );
    await expect(
      importMoonSnapshot(snapshot([report("2026-09-12", 900)], "2026-09-12T05:00:00Z")),
    ).rejects.toThrow("INJECTED_MOON_FAILURE");
    expect((await listPlayGames("total", "desc", ""))[0].totalSeconds).toBe(1800);
    expect(
      withDatabase((db) => db.prepare("SELECT last_fetched_at FROM moon_connector_accounts").get()),
    ).toEqual({ last_fetched_at: "2026-09-12T04:00:00.000Z" });
    withDatabase((db) => db.exec("DROP TRIGGER fail_moon_rows"));
    await expect(
      importMoonSnapshot(snapshot([report("2026-09-12", 900)], "2026-09-12T05:00:00Z")),
    ).resolves.toMatchObject({ importedReports: 1 });
  });

  it("does not add an overlapping Coral lifetime counter to confirmed Moon collection totals", async () => {
    seedPurchase();
    const payload = {
      version: 1,
      games: [
        {
          externalId: "nintendo:same-title",
          title: "Moon Game",
          titleId: "0100abcdefabcdef",
          sessions: [],
          observations: [
            {
              externalId: "obs",
              observedAt: "2026-09-12T04:00:00Z",
              totalSeconds: 50_000,
              firstPlayedAt: "2025-01-01T00:00:00Z",
            },
          ],
        },
      ],
    };
    const preview = await saveImportPreview(
      "moon-mixed-source",
      payloadSha256(JSON.stringify(payload)),
      validateImportPayload(payload),
    );
    await commitImportBatch(preview.batchId, { source: "nintendo_connector" });
    await importMoonSnapshot(snapshot());
    for (const game of await listPlayGames("title", "asc", ""))
      await decidePurchaseLink(game.id, "confirm", "purchase-moon", "admin");
    expect(await listPlayGames("title", "asc", "")).toHaveLength(1);
    expect(
      withDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM source_bindings").get()),
    ).toEqual({ count: 2 });
    expect((await listPurchasePlaySummaries())[0]).toMatchObject({
      totalSeconds: 1800,
      timeSemantics: "daily_aggregate",
      lastPlayedAt: "2026-09-12",
    });
    expect((await getDashboardStats(true)).play).toMatchObject({
      games: 1,
      totalSeconds: 1800,
      sessions: 0,
      timeSemantics: "daily_aggregate",
    });
  });

  it.each([
    [
      "duplicate report",
      (value: MoonSnapshot) => {
        value.dailyReports.push(report());
      },
    ],
    [
      "duplicate game",
      (value: MoonSnapshot) => {
        value.dailyReports[0].games.push(value.dailyReports[0].games[0]);
      },
    ],
    [
      "unknown device",
      (value: MoonSnapshot) => {
        value.dailyReports[0].deviceId = "missing";
      },
    ],
    [
      "invalid day",
      (value: MoonSnapshot) => {
        value.dailyReports[0].date = "2026-02-30";
      },
    ],
    [
      "script URL",
      (value: MoonSnapshot) => {
        value.dailyReports[0].games[0].officialUrl = "javascript:alert(1)";
      },
    ],
    [
      "credentials in URL",
      (value: MoonSnapshot) => {
        value.dailyReports[0].games[0].imageUrl = "https://user:secret@example.com/a";
      },
    ],
    [
      "fractional seconds",
      (value: MoonSnapshot) => {
        value.dailyReports[0].games[0].totalSeconds = 1.5;
      },
    ],
    [
      "missing timestamp zone",
      (value: MoonSnapshot) => {
        value.fetchedAt = "2026-09-12T12:00:00";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const value = snapshot();
    mutate(value);
    expect(() => validateMoonSnapshot(value)).toThrow(/invalid_snapshot/);
  });
});
