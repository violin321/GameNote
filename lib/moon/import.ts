import { createHash, randomUUID } from "node:crypto";
import { ensureSuggestedPurchaseLink, openPlayDatabase } from "../play-history/repository";
import type { PlayDatabase } from "../play-history/schema";
import { normalizeTitle } from "../play-history/validation";
import { ensureMoonSchema } from "./schema";
import type { MoonDailyGame, MoonDailyReport, MoonImportResult, MoonSnapshot } from "./types";

export class MoonSnapshotError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MoonSnapshotError";
  }
}

/** Import a validated snapshot atomically. Day revisions replace, never add. */
export async function importMoonSnapshot(input: MoonSnapshot): Promise<MoonImportResult> {
  const snapshot = validateMoonSnapshot(input);
  const hash = digest(snapshot);
  const db = await openPlayDatabase();
  try {
    ensureMoonSchema(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db
        .prepare(
          "SELECT last_fetched_at,payload_sha256 FROM moon_connector_accounts WHERE account_scope=?",
        )
        .get(snapshot.accountScope) as
        { last_fetched_at: string; payload_sha256: string } | undefined;
      if (previous && snapshot.fetchedAt <= previous.last_fetched_at) {
        if (snapshot.fetchedAt === previous.last_fetched_at && hash !== previous.payload_sha256)
          throw new MoonSnapshotError("snapshot_revision_conflict");
        const result = importResult(db, snapshot.accountScope, 0, 0);
        db.exec("COMMIT");
        return result;
      }
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO moon_connector_accounts(account_scope,last_fetched_at,payload_sha256,last_imported_at)
        VALUES(?,?,?,?) ON CONFLICT(account_scope) DO UPDATE SET
        last_fetched_at=excluded.last_fetched_at,payload_sha256=excluded.payload_sha256,last_imported_at=excluded.last_imported_at`,
      ).run(snapshot.accountScope, snapshot.fetchedAt, hash, now);
      for (const device of snapshot.devices)
        db.prepare(
          "INSERT OR IGNORE INTO moon_connector_devices(account_scope,device_id) VALUES(?,?)",
        ).run(snapshot.accountScope, device.id);

      let importedReports = 0;
      let importedGames = 0;
      const affected = new Set<string>();
      for (const report of snapshot.dailyReports) {
        const reportHash = digest(report);
        const existing = db
          .prepare(
            `SELECT id,payload_sha256,report_updated_at FROM moon_connector_reports
          WHERE account_scope=? AND device_id=? AND official_date=?`,
          )
          .get(snapshot.accountScope, report.deviceId, report.date) as
          | {
              id: string;
              payload_sha256: string;
              report_updated_at: string | null;
            }
          | undefined;
        if (existing?.payload_sha256 === reportHash) continue;
        // An upstream stale cache may appear inside a newer fetch. Keep the newer
        // revision when both payloads supply a comparable official update time.
        if (
          existing?.report_updated_at &&
          report.updatedAt &&
          report.updatedAt < existing.report_updated_at
        )
          continue;
        const reportId = existing?.id || randomUUID();
        if (existing) {
          for (const row of db
            .prepare("SELECT play_game_id FROM moon_connector_report_games WHERE report_id=?")
            .all(reportId) as Array<{ play_game_id: string }>)
            affected.add(row.play_game_id);
          db.prepare(
            `DELETE FROM play_observations
            WHERE source='moon_connector' AND source_id=? AND source_record_id=?`,
          ).run(snapshot.accountScope, reportId);
          db.prepare("DELETE FROM moon_connector_report_games WHERE report_id=?").run(reportId);
        }
        db.prepare(
          `INSERT INTO moon_connector_reports(id,account_scope,device_id,official_date,time_zone_offset_seconds,
          result,report_updated_at,total_seconds,fetched_at,imported_at,payload_sha256)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_scope,device_id,official_date) DO UPDATE SET
          time_zone_offset_seconds=excluded.time_zone_offset_seconds,result=excluded.result,
          report_updated_at=excluded.report_updated_at,total_seconds=excluded.total_seconds,
          fetched_at=excluded.fetched_at,imported_at=excluded.imported_at,payload_sha256=excluded.payload_sha256`,
        ).run(
          reportId,
          snapshot.accountScope,
          report.deviceId,
          report.date,
          report.timeZoneOffsetSeconds,
          report.result,
          report.updatedAt,
          report.totalSeconds,
          snapshot.fetchedAt,
          now,
          reportHash,
        );
        for (const game of report.games) {
          const mapped = upsertMoonGame(db, snapshot, report, game, now);
          importedGames += Number(mapped.inserted);
          affected.add(mapped.id);
          db.prepare(
            "INSERT INTO moon_connector_report_games(report_id,play_game_id,total_seconds) VALUES(?,?,?)",
          ).run(reportId, mapped.id, game.totalSeconds);
          upsertMoonObservation(db, snapshot, report, game, reportId, mapped.id, now);
        }
        importedReports += 1;
      }
      for (const gameId of affected) {
        // Daily totals are observations, never fabricated timeline sessions.
        db.prepare(
          `UPDATE play_games SET
          total_seconds=COALESCE((SELECT SUM(total_seconds) FROM moon_connector_report_games WHERE play_game_id=?),0),
          play_days=(SELECT COUNT(DISTINCT r.official_date) FROM moon_connector_report_games d
            JOIN moon_connector_reports r ON r.id=d.report_id WHERE d.play_game_id=? AND d.total_seconds>0),
          first_played_at=COALESCE((SELECT MIN(r.official_date) FROM moon_connector_report_games d
            JOIN moon_connector_reports r ON r.id=d.report_id WHERE d.play_game_id=? AND d.total_seconds>0),''),
          last_played_at=COALESCE((SELECT MAX(r.official_date) FROM moon_connector_report_games d
            JOIN moon_connector_reports r ON r.id=d.report_id WHERE d.play_game_id=? AND d.total_seconds>0),''),
          updated_at=? WHERE id=? AND source='moon_connector'`,
        ).run(gameId, gameId, gameId, gameId, now, gameId);
        // This helper is deliberately no-op for every existing decision,
        // including rejection and manually confirmed collection associations.
        ensureSuggestedPurchaseLink(db, gameId, now);
      }
      const result = importResult(db, snapshot.accountScope, importedReports, importedGames);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function readMoonImportStatus() {
  const db = await openPlayDatabase();
  try {
    ensureMoonSchema(db);
    const row = db
      .prepare(
        `SELECT
      (SELECT MAX(last_imported_at) FROM moon_connector_accounts) AS last_imported_at,
      MAX(official_date) AS latest_date,COUNT(*) AS report_count FROM moon_connector_reports`,
      )
      .get() as {
      last_imported_at: string | null;
      latest_date: string | null;
      report_count: number;
    };
    return {
      lastImportedAt: row.last_imported_at,
      latestDate: row.latest_date,
      reportCount: Number(row.report_count),
    };
  } finally {
    db.close();
  }
}

function upsertMoonObservation(
  db: PlayDatabase,
  snapshot: MoonSnapshot,
  report: MoonDailyReport,
  game: MoonDailyGame,
  reportId: string,
  gameId: string,
  now: string,
) {
  const key = digest([snapshot.accountScope, report.deviceId, report.date, game.externalId]);
  const id = `moon-observation:${key}`;
  const externalId = `daily:${key}`;
  db.prepare(
    `INSERT INTO play_observations(
      id,game_id,source,source_id,external_id,source_record_id,
      observed_date,observed_at,total_seconds,play_days,
      first_played_at,last_played_at,image_url,time_semantics,report_status,imported_at
    ) VALUES(?,?,'moon_connector',?,?,?,?,?,?,?, '', '',?,'daily_aggregate',?,?)
    ON CONFLICT(source,source_id,external_id) DO UPDATE SET
      game_id=excluded.game_id,source_record_id=excluded.source_record_id,
      observed_date=excluded.observed_date,observed_at=excluded.observed_at,
      total_seconds=excluded.total_seconds,play_days=excluded.play_days,
      image_url=excluded.image_url,report_status=excluded.report_status,
      imported_at=excluded.imported_at`,
  ).run(
    id,
    gameId,
    snapshot.accountScope,
    externalId,
    reportId,
    report.date,
    report.updatedAt || snapshot.fetchedAt,
    game.totalSeconds,
    Number(game.totalSeconds > 0),
    game.imageUrl,
    report.result,
    now,
  );
}

function importResult(
  db: PlayDatabase,
  accountScope: string,
  reports: number,
  games: number,
): MoonImportResult {
  const latest = db
    .prepare("SELECT MAX(official_date) AS date FROM moon_connector_reports WHERE account_scope=?")
    .get(accountScope) as { date: string | null };
  return {
    importedReports: reports,
    importedGames: games,
    replayed: reports === 0,
    latestDate: latest.date,
  };
}

function upsertMoonGame(
  db: PlayDatabase,
  snapshot: MoonSnapshot,
  report: MoonDailyReport,
  game: MoonDailyGame,
  now: string,
) {
  const previous = db
    .prepare(
      `SELECT play_game_id,metadata_fetched_at FROM moon_connector_games
    WHERE account_scope=? AND device_id=? AND external_id=?`,
    )
    .get(snapshot.accountScope, report.deviceId, game.externalId) as
    { play_game_id: string; metadata_fetched_at: string } | undefined;
  const id = previous?.play_game_id || randomUUID();
  if (!previous) {
    const externalId = `moon:${digest([snapshot.accountScope, report.deviceId, game.externalId])}`;
    db.prepare(
      `INSERT INTO play_games(
        id,source,source_id,external_id,title,normalized_title,title_id,official_url,platform,
        first_played_at,last_played_at,total_seconds,play_days,time_semantics,created_at,updated_at
      ) VALUES(?,'moon_connector',?,?,?,?,?,?,?,'','',0,0,'daily_aggregate',?,?)`,
    ).run(
      id,
      snapshot.accountScope,
      externalId,
      game.title,
      normalizeTitle(game.title),
      game.titleId,
      game.officialUrl,
      "Nintendo Switch",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO moon_connector_games(account_scope,device_id,external_id,play_game_id,image_url,metadata_fetched_at)
      VALUES(?,?,?,?,?,?)`,
    ).run(
      snapshot.accountScope,
      report.deviceId,
      game.externalId,
      id,
      game.imageUrl,
      snapshot.fetchedAt,
    );
  } else if (snapshot.fetchedAt >= previous.metadata_fetched_at) {
    db.prepare(
      "UPDATE play_games SET title=?,normalized_title=?,title_id=?,official_url=?,updated_at=? WHERE id=? AND source='moon_connector'",
    ).run(
      game.title,
      normalizeTitle(game.title),
      game.titleId || "",
      game.officialUrl || "",
      now,
      id,
    );
    db.prepare(
      "UPDATE moon_connector_games SET image_url=?,metadata_fetched_at=? WHERE play_game_id=?",
    ).run(game.imageUrl, snapshot.fetchedAt, id);
  }
  return { id, inserted: !previous };
}

/** Validate the whole envelope before opening a write transaction. */
export function validateMoonSnapshot(input: unknown): MoonSnapshot {
  if (!record(input) || input.schema !== "gamenote.moon.daily.v1") fail("invalid_snapshot_schema");
  const fetchedAt = timestamp(input.fetchedAt, "fetched_at");
  const accountScope = identifier(input.accountScope, "account_scope");
  if (!Array.isArray(input.devices) || input.devices.length > 100) fail("invalid_snapshot_devices");
  const deviceIds = new Set<string>();
  const devices = input.devices
    .map((device) => {
      if (!record(device)) fail("invalid_snapshot_device");
      const id = identifier(device.id, "device_id");
      if (deviceIds.has(id)) fail("invalid_snapshot_duplicate_device");
      deviceIds.add(id);
      return { id };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!Array.isArray(input.dailyReports) || input.dailyReports.length > 10_000)
    fail("invalid_snapshot_reports");
  const reportKeys = new Set<string>();
  let gameCount = 0;
  const dailyReports: MoonDailyReport[] = input.dailyReports
    .map((item) => {
      if (!record(item)) fail("invalid_snapshot_report");
      const deviceId = identifier(item.deviceId, "device_id");
      if (!deviceIds.has(deviceId)) fail("invalid_snapshot_report_device");
      if (
        typeof item.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(item.date) ||
        !Number.isFinite(Date.parse(`${item.date}T00:00:00.000Z`)) ||
        new Date(`${item.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== item.date
      )
        fail("invalid_snapshot_date");
      const key = JSON.stringify([deviceId, item.date]);
      if (reportKeys.has(key)) fail("invalid_snapshot_duplicate_report");
      reportKeys.add(key);
      if (
        !Number.isInteger(item.timeZoneOffsetSeconds) ||
        Number(item.timeZoneOffsetSeconds) < -50_400 ||
        Number(item.timeZoneOffsetSeconds) > 50_400
      )
        fail("invalid_snapshot_time_zone_offset");
      if (!["CALCULATING", "ACHIEVED", "UNACHIEVED", "UNKNOWN"].includes(String(item.result)))
        fail("invalid_snapshot_report_result");
      const updatedAt = item.updatedAt === null ? null : timestamp(item.updatedAt, "updated_at");
      if (!Array.isArray(item.games) || item.games.length > 500) fail("invalid_snapshot_games");
      gameCount += item.games.length;
      if (gameCount > 50_000) fail("invalid_snapshot_game_limit");
      const externalIds = new Set<string>();
      const games = item.games
        .map((entry): MoonDailyGame => {
          if (!record(entry)) fail("invalid_snapshot_game");
          const externalId = identifier(entry.externalId, "external_id");
          if (externalIds.has(externalId)) fail("invalid_snapshot_duplicate_game");
          externalIds.add(externalId);
          if (
            typeof entry.title !== "string" ||
            !entry.title.trim() ||
            entry.title.trim().length > 200 ||
            /[\u0000-\u001f]/.test(entry.title)
          )
            fail("invalid_snapshot_title");
          return {
            externalId,
            title: entry.title.trim(),
            titleId: entry.titleId === "" ? "" : identifier(entry.titleId, "title_id"),
            officialUrl: httpsUrl(entry.officialUrl),
            imageUrl: httpsUrl(entry.imageUrl),
            totalSeconds: seconds(entry.totalSeconds),
          };
        })
        .sort((a, b) => a.externalId.localeCompare(b.externalId));
      return {
        deviceId,
        date: item.date,
        timeZoneOffsetSeconds: Number(item.timeZoneOffsetSeconds),
        result: item.result as MoonDailyReport["result"],
        updatedAt,
        totalSeconds: seconds(item.totalSeconds),
        games,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.deviceId.localeCompare(b.deviceId));
  return { schema: "gamenote.moon.daily.v1", fetchedAt, accountScope, devices, dailyReports };
}

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function identifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(input))
    fail(`invalid_snapshot_${field}`);
  return input;
}
function timestamp(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
    !Number.isFinite(Date.parse(input))
  )
    fail(`invalid_snapshot_${field}`);
  return new Date(input).toISOString();
}
function seconds(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > 31_536_000)
    fail("invalid_snapshot_seconds");
  return input;
}
function httpsUrl(input: unknown): string {
  if (input === "") return "";
  if (typeof input !== "string" || input.length > 2048) fail("invalid_snapshot_url");
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) fail("invalid_snapshot_url");
    url.hash = "";
    return url.toString();
  } catch {
    fail("invalid_snapshot_url");
  }
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function fail(code: string): never {
  throw new MoonSnapshotError(code);
}
