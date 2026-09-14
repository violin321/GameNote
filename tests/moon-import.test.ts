import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importMoonSnapshot, readMoonImportStatus, validateMoonSnapshot } from "../lib/moon/import";
import type { MoonDailyReport, MoonSnapshot } from "../lib/moon/types";
import { listRecentSessions, migratePlayDatabase } from "../lib/play-history/repository";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-moon-import-"));
  process.env.APP_DATABASE_FILE = join(directory, "records.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

function report(
  date = "2026-09-12",
  seconds = 1800,
  updatedAt = `${date}T03:00:00.000Z`,
): MoonDailyReport {
  return {
    deviceId: "fixture-device",
    date,
    timeZoneOffsetSeconds: 28_800,
    result: "ACHIEVED",
    updatedAt,
    totalSeconds: seconds,
    games: [
      {
        externalId: "0100abcdefabcdef",
        title: "Moon Fixture Game",
        titleId: "0100abcdefabcdef",
        officialUrl: "https://example.com/title/0100abcdefabcdef",
        imageUrl: "https://example.com/moon-fixture.jpg",
        totalSeconds: seconds,
      },
    ],
  };
}

function snapshot(dailyReports = [report()], fetchedAt = "2026-09-12T04:00:00.000Z"): MoonSnapshot {
  return {
    schema: "gamenote.moon.daily.v1",
    fetchedAt,
    accountScope: "fixture-account",
    devices: [{ id: "fixture-device" }],
    dailyReports,
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

function seedCollectionRecord() {
  const record = {
    id: "fixture-purchase",
    platform: "Nintendo Switch",
    title: "Moon Fixture Game",
    price: 0,
    currency: "CNY",
    purchaseDate: "2026-09-01",
    region: "其他",
    format: "数字版",
    seller: "",
    coverUrl: "https://example.com/collection-fixture.jpg",
    officialUrl: "https://example.com/title/0100abcdefabcdef",
    notes: "",
    soldDate: "",
    soldPrice: 0,
    soldCurrency: "CNY",
  };
  withDatabase((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ledger_documents (
      id TEXT PRIMARY KEY NOT NULL,
      records TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO ledger_documents(id,records,updated_at) VALUES('default',?,?)").run(
      JSON.stringify([record]),
      "2026-09-12T00:00:00.000Z",
    );
  });
}

describe("Moon calendar-day import", () => {
  it("stores exact official days, avoids fake sessions, and suggests an existing collection item", async () => {
    seedCollectionRecord();

    await expect(
      importMoonSnapshot(snapshot([report("2026-09-11", 900), report("2026-09-12", 1800)])),
    ).resolves.toEqual({
      importedReports: 2,
      importedGames: 1,
      replayed: false,
      latestDate: "2026-09-12",
    });

    const state = withDatabase((db) => ({
      game: db
        .prepare(
          `SELECT source,source_id,title,title_id,official_url,platform,first_played_at,
            last_played_at,total_seconds,play_days,time_semantics
          FROM play_games`,
        )
        .get(),
      reports: db
        .prepare(
          `SELECT official_date,total_seconds,result,time_zone_offset_seconds
          FROM moon_connector_reports ORDER BY official_date`,
        )
        .all(),
      reportGames: db.prepare("SELECT COUNT(*) AS count FROM moon_connector_report_games").get(),
      sessions: db.prepare("SELECT COUNT(*) AS count FROM play_sessions").get(),
      observations: db
        .prepare(
          `SELECT observed_date,total_seconds,time_semantics,report_status,image_url
          FROM play_observations ORDER BY observed_date`,
        )
        .all(),
      link: db
        .prepare("SELECT status,match_method,purchase_record_id FROM play_purchase_links")
        .get(),
    }));

    expect(state.game).toEqual({
      source: "moon_connector",
      source_id: "fixture-account",
      title: "Moon Fixture Game",
      title_id: "0100abcdefabcdef",
      official_url: "https://example.com/title/0100abcdefabcdef",
      platform: "Nintendo Switch",
      first_played_at: "2026-09-11",
      last_played_at: "2026-09-12",
      total_seconds: 2700,
      play_days: 2,
      time_semantics: "daily_aggregate",
    });
    expect(state.reports).toEqual([
      {
        official_date: "2026-09-11",
        total_seconds: 900,
        result: "ACHIEVED",
        time_zone_offset_seconds: 28_800,
      },
      {
        official_date: "2026-09-12",
        total_seconds: 1800,
        result: "ACHIEVED",
        time_zone_offset_seconds: 28_800,
      },
    ]);
    expect(state.reportGames).toEqual({ count: 2 });
    expect(state.sessions).toEqual({ count: 0 });
    expect(state.observations).toEqual([
      {
        observed_date: "2026-09-11",
        total_seconds: 900,
        time_semantics: "daily_aggregate",
        report_status: "ACHIEVED",
        image_url: "https://example.com/moon-fixture.jpg",
      },
      {
        observed_date: "2026-09-12",
        total_seconds: 1800,
        time_semantics: "daily_aggregate",
        report_status: "ACHIEVED",
        image_url: "https://example.com/moon-fixture.jpg",
      },
    ]);
    expect(state.link).toEqual({
      status: "suggested",
      match_method: "official_url",
      purchase_record_id: "fixture-purchase",
    });
    expect(await readMoonImportStatus()).toMatchObject({
      latestDate: "2026-09-12",
      reportCount: 2,
    });
    expect(await listRecentSessions(7, new Date("2026-09-12T12:00:00.000Z"))).toEqual([
      expect.objectContaining({
        title: "Moon Fixture Game",
        playedDate: "2026-09-12",
        durationSeconds: 1800,
        startedAt: null,
        endedAt: null,
        timeSemantics: "daily_aggregate",
        reportStatus: "ACHIEVED",
      }),
      expect.objectContaining({ playedDate: "2026-09-11", durationSeconds: 900 }),
    ]);
  });

  it("replays idempotently and replaces revised days instead of adding lifetime totals", async () => {
    const initial = snapshot([report("2026-09-11", 900), report("2026-09-12", 1800)]);
    await importMoonSnapshot(initial);

    await expect(importMoonSnapshot(initial)).resolves.toMatchObject({
      importedReports: 0,
      importedGames: 0,
      replayed: true,
    });

    await expect(
      importMoonSnapshot(
        snapshot(
          [report("2026-09-11", 900), report("2026-09-12", 300, "2026-09-12T05:00:00.000Z")],
          "2026-09-12T06:00:00.000Z",
        ),
      ),
    ).resolves.toMatchObject({ importedReports: 1, importedGames: 0, replayed: false });

    expect(
      withDatabase((db) =>
        db
          .prepare("SELECT total_seconds,play_days,first_played_at,last_played_at FROM play_games")
          .get(),
      ),
    ).toEqual({
      total_seconds: 1200,
      play_days: 2,
      first_played_at: "2026-09-11",
      last_played_at: "2026-09-12",
    });
    expect(
      withDatabase((db) =>
        db
          .prepare(
            "SELECT observed_date,total_seconds FROM play_observations ORDER BY observed_date",
          )
          .all(),
      ),
    ).toEqual([
      { observed_date: "2026-09-11", total_seconds: 900 },
      { observed_date: "2026-09-12", total_seconds: 300 },
    ]);

    await importMoonSnapshot(
      snapshot(
        [report("2026-09-11", 900), report("2026-09-12", 0, "2026-09-12T07:00:00.000Z")],
        "2026-09-12T08:00:00.000Z",
      ),
    );
    expect(
      withDatabase((db) =>
        db
          .prepare("SELECT total_seconds,play_days,first_played_at,last_played_at FROM play_games")
          .get(),
      ),
    ).toEqual({
      total_seconds: 900,
      play_days: 1,
      first_played_at: "2026-09-11",
      last_played_at: "2026-09-11",
    });
    expect(
      withDatabase((db) =>
        db
          .prepare(
            "SELECT observed_date,total_seconds FROM play_observations ORDER BY observed_date",
          )
          .all(),
      ),
    ).toEqual([
      { observed_date: "2026-09-11", total_seconds: 900 },
      { observed_date: "2026-09-12", total_seconds: 0 },
    ]);
    expect(await listRecentSessions(7, new Date("2026-09-12T12:00:00.000Z"))).toEqual([
      expect.objectContaining({ playedDate: "2026-09-11", durationSeconds: 900 }),
    ]);
  });

  it("keeps a newer official report revision when a later fetch contains stale data", async () => {
    await importMoonSnapshot(snapshot([report("2026-09-12", 1800, "2026-09-12T05:00:00.000Z")]));
    await expect(
      importMoonSnapshot(
        snapshot(
          [report("2026-09-12", 300, "2026-09-12T03:00:00.000Z")],
          "2026-09-12T06:00:00.000Z",
        ),
      ),
    ).resolves.toMatchObject({ importedReports: 0, replayed: true });
    expect(withDatabase((db) => db.prepare("SELECT total_seconds FROM play_games").get())).toEqual({
      total_seconds: 1800,
    });

    await expect(
      importMoonSnapshot(snapshot([report("2026-09-12", 600)], "2026-09-12T06:00:00.000Z")),
    ).rejects.toThrow("snapshot_revision_conflict");
    expect(withDatabase((db) => db.prepare("SELECT total_seconds FROM play_games").get())).toEqual({
      total_seconds: 1800,
    });
  });

  it("accepts empty optional metadata without writing null into the shared game table", async () => {
    const emptyMetadata = report();
    emptyMetadata.games[0] = {
      ...emptyMetadata.games[0],
      titleId: "",
      officialUrl: "",
      imageUrl: "",
    };
    await importMoonSnapshot(snapshot([emptyMetadata]));

    const revised = structuredClone(emptyMetadata);
    revised.games[0].title = "Moon Fixture Game Renamed";
    revised.updatedAt = "2026-09-12T05:00:00.000Z";
    await importMoonSnapshot(snapshot([revised], "2026-09-12T06:00:00.000Z"));

    expect(
      withDatabase((db) => db.prepare("SELECT title,title_id,official_url FROM play_games").get()),
    ).toEqual({
      title: "Moon Fixture Game Renamed",
      title_id: "",
      official_url: "",
    });
  });

  it("validates the whole envelope before writing anything", async () => {
    const invalid = snapshot([report(), { ...report("2026-09-11"), totalSeconds: -1 }]);
    await expect(importMoonSnapshot(invalid)).rejects.toThrow("invalid_snapshot_seconds");
    expect(
      withDatabase((db) => db.prepare("SELECT COUNT(*) AS count FROM play_games").get()),
    ).toEqual({ count: 0 });
    expect(await readMoonImportStatus()).toEqual({
      lastImportedAt: null,
      latestDate: null,
      reportCount: 0,
    });
  });

  it.each([
    ["duplicate report", (value: MoonSnapshot) => value.dailyReports.push(report())],
    [
      "duplicate game",
      (value: MoonSnapshot) => value.dailyReports[0].games.push(value.dailyReports[0].games[0]),
    ],
    ["unknown device", (value: MoonSnapshot) => (value.dailyReports[0].deviceId = "missing")],
    ["invalid day", (value: MoonSnapshot) => (value.dailyReports[0].date = "2026-02-30")],
    [
      "script URL",
      (value: MoonSnapshot) => (value.dailyReports[0].games[0].officialUrl = "javascript:alert(1)"),
    ],
    [
      "credentials in URL",
      (value: MoonSnapshot) =>
        (value.dailyReports[0].games[0].imageUrl = "https://fixture:secret@example.com/a"),
    ],
    [
      "fractional seconds",
      (value: MoonSnapshot) => (value.dailyReports[0].games[0].totalSeconds = 1.5),
    ],
    ["missing timestamp zone", (value: MoonSnapshot) => (value.fetchedAt = "2026-09-12T12:00:00")],
  ])("rejects %s", (_label, mutate) => {
    const value = snapshot();
    mutate(value);
    expect(() => validateMoonSnapshot(value)).toThrow(/invalid_snapshot/);
  });
});
