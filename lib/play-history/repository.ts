import { randomUUID } from "node:crypto";
import { openLedgerDatabase } from "@/lib/ledger/repository";
import { normalizeRecords, type GameRecord, type GamePlatform } from "@/lib/ledger/schema";
import { ensurePlayHistorySchema, type PlayDatabase } from "./schema";
import type {
  CanonicalPlayGame,
  CanonicalPlaySession,
  ImportPreview,
  PlayGameSummary,
  PlayPurchaseLink,
  PlaySource,
  RecentPlaySession,
} from "./types";
import { defaultPlaySourceId } from "./types";
import { normalizeOfficialUrl, normalizeTitle } from "./validation";

type BatchRow = {
  id: string;
  payload_sha256: string;
  status: string;
  preview_json: string;
};

type SummaryRow = Record<string, unknown> & {
  id: string;
  source: string;
  source_id: string;
  title: string;
  normalized_title: string;
  title_id: string;
  platform: string;
  official_url: string;
  total_seconds: number | bigint;
  play_days: number | bigint;
  first_played_at: string;
  last_played_at: string;
  time_semantics: string;
  session_count: number | bigint;
  observation_count: number | bigint;
  link_status?: string | null;
  match_method?: string | null;
  confidence?: number | null;
  purchase_record_id?: string | null;
};

type LinkColumns = {
  link_status?: string | null;
  match_method?: string | null;
  confidence?: number | null;
  purchase_record_id?: string | null;
};

export class ImportConflictError extends Error {
  constructor(message = "IDEMPOTENCY_CONFLICT") {
    super(message);
    this.name = "ImportConflictError";
  }
}

export class ImportNotFoundError extends Error {
  constructor(message = "NOT_FOUND") {
    super(message);
    this.name = "ImportNotFoundError";
  }
}

export class ImportInvalidError extends Error {
  constructor(message = "INVALID_IMPORT") {
    super(message);
    this.name = "ImportInvalidError";
  }
}

/**
 * Creates the play-history tables in GameNote's existing SQLite database.
 * Every public repository function also calls this lazily, so deployments do
 * not need a separate migration command.
 */
export async function migratePlayDatabase() {
  const db = await openPlayDatabase();
  db.close();
}

export async function saveImportPreview(
  idempotencyKey: string,
  sha256: string,
  preview: ImportPreview,
) {
  const db = await openPlayDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = findBatchByIdempotencyKey(db, idempotencyKey);
      if (existing) {
        const replay = replayPreview(existing, sha256);
        db.exec("COMMIT");
        return replay;
      }

      const storedPreview = preview.valid ? inspectExistingImport(db, preview) : preview;
      const batchId = randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(
          `INSERT INTO import_batches(
            id, idempotency_key, source_id, payload_sha256, status, item_count,
            error_count, preview_json, created_at
          ) VALUES(?, ?, ?, ?, 'previewed', ?, ?, ?, ?)`,
        ).run(
          batchId,
          idempotencyKey,
          storedPreview.sourceId,
          sha256,
          storedPreview.itemCount,
          storedPreview.issues.length,
          JSON.stringify(storedPreview),
          now,
        );
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const winner = findBatchByIdempotencyKey(db, idempotencyKey);
        if (!winner) throw new ImportConflictError("IDEMPOTENCY_RACE");
        const replay = replayPreview(winner, sha256);
        db.exec("COMMIT");
        return replay;
      }

      const issuesByIndex = new Map<number, string[]>();
      for (const issue of storedPreview.issues) {
        issuesByIndex.set(issue.index, [
          ...(issuesByIndex.get(issue.index) || []),
          `${issue.path}: ${issue.message}`,
        ]);
      }
      const insertItem = db.prepare(
        `INSERT INTO import_items(
          id, batch_id, item_index, external_id, status, error,
          canonical_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const gamesByItemIndex = new Map(
        storedPreview.games.map((game) => [game.itemIndex, game] as const),
      );
      for (let index = 0; index < storedPreview.itemCount; index += 1) {
        const game = gamesByItemIndex.get(index);
        const errors = issuesByIndex.get(index) || [];
        insertItem.run(
          randomUUID(),
          batchId,
          index,
          game?.externalId || null,
          errors.length ? "invalid" : "valid",
          errors.join("; ") || null,
          game ? JSON.stringify(game) : null,
          now,
        );
      }

      db.exec("COMMIT");
      return { batchId, status: "previewed" as const, replayed: false, preview: storedPreview };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function commitImportBatch(batchId: string) {
  const db = await openPlayDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const batch = db
        .prepare("SELECT id, payload_sha256, status, preview_json FROM import_batches WHERE id = ?")
        .get(batchId) as BatchRow | undefined;
      if (!batch) throw new ImportNotFoundError("IMPORT_BATCH_NOT_FOUND");
      if (batch.status === "committed") {
        db.exec("COMMIT");
        return {
          batchId,
          status: "committed" as const,
          replayed: true,
          insertedGames: 0,
          insertedSessions: 0,
        };
      }
      if (batch.status !== "previewed") {
        throw new ImportConflictError("IMPORT_STATUS_CONFLICT");
      }

      const preview = parseStoredPreview(batch.preview_json);
      if (!preview.valid) throw new ImportInvalidError("IMPORT_PREVIEW_INVALID");

      const source: PlaySource = "json_import";
      const sourceId = preview.sourceId;
      const now = new Date().toISOString();
      const records = readLedgerRecords(db);
      let insertedGames = 0;
      let insertedSessions = 0;

      for (const game of preview.games) {
        const gameResult = upsertPlayGame(db, game, source, sourceId, now);
        if (gameResult.inserted) insertedGames += 1;
        let itemChanged = gameResult.inserted;

        for (const session of game.sessions) {
          const sessionResult = insertPlaySession(
            db,
            gameResult.id,
            source,
            sourceId,
            session,
            now,
          );
          if (sessionResult.inserted) insertedSessions += 1;
          itemChanged ||= sessionResult.changed;
        }
        refreshGameAggregate(db, gameResult.id, now);
        createSuggestedPurchaseLink(db, gameResult.id, records, now);
        db.prepare("UPDATE import_items SET status = ? WHERE batch_id = ? AND item_index = ?").run(
          itemChanged ? "inserted" : "duplicate",
          batchId,
          game.itemIndex,
        );
      }

      db.prepare(
        "UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ?",
      ).run(now, batchId);
      db.exec("COMMIT");
      return {
        batchId,
        status: "committed" as const,
        replayed: false,
        insertedGames,
        insertedSessions,
      };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function listPlayGames(sort: string, direction: string, query: string) {
  const db = await openPlayDatabase();
  try {
    const records = readLedgerRecords(db);
    const rows = querySummaryRows(db, sort, direction);
    const normalizedQuery = normalizeTitle(query.slice(0, 100));
    return rows
      .map((row) => toSummary(row, records))
      .filter(
        (game) =>
          !normalizedQuery ||
          normalizeTitle(game.title).includes(normalizedQuery) ||
          game.titleId.toLowerCase().includes(normalizedQuery),
      );
  } finally {
    db.close();
  }
}

export async function listRecentSessions(days: 7 | 30 | 90, now = new Date()) {
  const db = await openPlayDatabase();
  try {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const firstCalendarDay = new Date(now.getTime() - (days - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const lastCalendarDay = now.toISOString().slice(0, 10);
    const records = readLedgerRecords(db);
    const rows = db
      .prepare(
        `WITH recent_activity AS (
          SELECT s.id, s.game_id, s.source, s.source_id,
            s.started_at, s.ended_at,
            COALESCE(NULLIF(s.played_date, ''), substr(s.started_at, 1, 10)) AS played_date,
            s.duration_seconds AS total_seconds,
            'play_timeline' AS time_semantics, '' AS report_status,
            '' AS image_url, s.started_at AS sort_at
          FROM play_sessions s
          WHERE s.time_semantics = 'play_timeline'
            AND s.started_at >= ? AND s.started_at <= ?

          UNION ALL

          SELECT o.id, o.game_id, o.source, o.source_id,
            NULL AS started_at, NULL AS ended_at, o.observed_date AS played_date,
            o.total_seconds, o.time_semantics, o.report_status,
            o.image_url, o.observed_at AS sort_at
          FROM play_observations o
          WHERE o.time_semantics = 'daily_aggregate'
            AND o.total_seconds > 0
            AND o.observed_date BETWEEN ? AND ?
        )
        SELECT a.id, a.game_id, a.source, a.source_id, g.title,
          a.started_at, a.ended_at, a.played_date, a.time_semantics, a.report_status,
          a.total_seconds, a.image_url, l.status AS link_status,
          l.match_method, l.confidence, l.purchase_record_id
        FROM recent_activity a
        JOIN play_games g ON g.id = a.game_id
        LEFT JOIN play_purchase_links l ON l.play_game_id = g.id
        ORDER BY a.played_date DESC, a.sort_at DESC, a.id ASC
        LIMIT 2000`,
      )
      .all(cutoff, now.toISOString(), firstCalendarDay, lastCalendarDay) as Array<
      Record<string, unknown> & LinkColumns
    >;
    return rows.map((row): RecentPlaySession => {
      const link = toLink(row, records);
      const common = {
        id: String(row.id),
        gameId: String(row.game_id),
        sourceId: String(row.source_id || defaultPlaySourceId),
        title: String(row.title),
        coverUrl: coverForLink(link, records) || String(row.image_url || ""),
        playedDate: String(row.played_date),
        durationSeconds: Number(row.total_seconds),
        source: normalizeSource(row.source),
        link,
      };
      if (row.time_semantics === "daily_aggregate")
        return {
          ...common,
          startedAt: null,
          endedAt: null,
          timeSemantics: "daily_aggregate",
          reportStatus: normalizeReportStatus(row.report_status),
        };
      return {
        ...common,
        startedAt: String(row.started_at),
        endedAt: String(row.ended_at),
        timeSemantics: "play_timeline",
        reportStatus: null,
      };
    });
  } finally {
    db.close();
  }
}

export async function listUnlinkedPlayGames(query = "") {
  const db = await openPlayDatabase();
  try {
    const records = readLedgerRecords(db);
    const normalizedQuery = normalizeTitle(query.slice(0, 100));
    return querySummaryRows(db, "recent", "desc")
      .map((row) => toSummary(row, records))
      .filter((game) => {
        const linkedRecordExists =
          game.link?.status === "confirmed" &&
          Boolean(game.link.purchaseRecordId && game.link.purchaseTitle);
        if (linkedRecordExists) return false;
        return (
          !normalizedQuery ||
          normalizeTitle(game.title).includes(normalizedQuery) ||
          game.titleId.toLowerCase().includes(normalizedQuery)
        );
      });
  } finally {
    db.close();
  }
}

export async function decidePurchaseLink(
  playGameId: string,
  action: "confirm" | "reject",
  purchaseRecordId: string | null,
  decidedBy: string,
) {
  const db = await openPlayDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!db.prepare("SELECT id FROM play_games WHERE id = ?").get(playGameId)) {
        throw new ImportNotFoundError("PLAY_GAME_NOT_FOUND");
      }

      const records = readLedgerRecords(db);
      if (
        action === "confirm" &&
        (!purchaseRecordId || !records.some((record) => record.id === purchaseRecordId))
      ) {
        throw new ImportInvalidError("PURCHASE_RECORD_NOT_FOUND");
      }

      const now = new Date().toISOString();
      const status = action === "confirm" ? "confirmed" : "rejected";
      const selectedRecordId = action === "confirm" ? purchaseRecordId : null;
      db.prepare(
        `INSERT INTO play_purchase_links(
          id, play_game_id, purchase_record_id, status, match_method,
          confidence, decided_at, decided_by, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 'manual', 1, ?, ?, ?, ?)
        ON CONFLICT(play_game_id) DO UPDATE SET
          purchase_record_id = excluded.purchase_record_id,
          status = excluded.status,
          match_method = 'manual',
          confidence = 1,
          decided_at = excluded.decided_at,
          decided_by = excluded.decided_by,
          updated_at = excluded.updated_at`,
      ).run(
        randomUUID(),
        playGameId,
        selectedRecordId,
        status,
        now,
        decidedBy.slice(0, 100),
        now,
        now,
      );
      db.exec("COMMIT");
      return { playGameId, purchaseRecordId: selectedRecordId, status };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function getPlayTableCounts() {
  const db = await openPlayDatabase();
  try {
    const tableNames = [
      "play_games",
      "play_sessions",
      "play_observations",
      "play_purchase_links",
      "import_batches",
      "import_items",
    ] as const;
    return Object.fromEntries(
      tableNames.map((name) => [
        name,
        Number(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number | bigint })
            .count,
        ),
      ]),
    );
  } finally {
    db.close();
  }
}

export async function openPlayDatabase() {
  const { db: ledgerDatabase } = await openLedgerDatabase();
  const db = ledgerDatabase as unknown as PlayDatabase;
  try {
    ensurePlayHistorySchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function upsertPlayGame(
  db: PlayDatabase,
  game: CanonicalPlayGame,
  source: PlaySource,
  sourceId: string,
  now: string,
) {
  const externalId = scopedExternalId(sourceId, game.externalId);
  const existing = db
    .prepare("SELECT id FROM play_games WHERE source = ? AND source_id = ? AND external_id = ?")
    .get(source, sourceId, externalId) as { id?: unknown } | undefined;
  if (existing?.id) {
    const id = String(existing.id);
    db.prepare(
      `UPDATE play_games SET title = ?, normalized_title = ?, title_id = ?,
        official_url = ?, platform = ?, updated_at = ? WHERE id = ?`,
    ).run(game.title, game.normalizedTitle, game.titleId, game.officialUrl, game.platform, now, id);
    return { id, inserted: false };
  }

  const id = randomUUID();
  const dates = initialGameDates(game, now);
  db.prepare(
    `INSERT INTO play_games(
      id, source, source_id, external_id, title, normalized_title, title_id,
      official_url, platform, first_played_at, last_played_at,
      total_seconds, play_days, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(
    id,
    source,
    sourceId,
    externalId,
    game.title,
    game.normalizedTitle,
    game.titleId,
    game.officialUrl,
    game.platform,
    dates.firstPlayedAt,
    dates.lastPlayedAt,
    now,
    now,
  );
  return { id, inserted: true };
}

function insertPlaySession(
  db: PlayDatabase,
  gameId: string,
  source: PlaySource,
  sourceId: string,
  session: CanonicalPlaySession,
  now: string,
) {
  const externalId = scopedExternalId(sourceId, session.externalId);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO play_sessions(
        id, game_id, source, source_id, external_id, started_at, ended_at,
        played_date, duration_seconds, imported_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      gameId,
      source,
      sourceId,
      externalId,
      session.startedAt,
      session.endedAt,
      session.playedDate,
      session.durationSeconds,
      now,
    );
  if (Number(result.changes || 0) > 0) return { inserted: true, changed: true };

  const corrected = db
    .prepare(
      `UPDATE play_sessions SET played_date = ?
      WHERE game_id = ? AND source = ? AND source_id = ? AND external_id = ?
        AND started_at = ? AND ended_at = ? AND duration_seconds = ?
        AND played_date <> ?`,
    )
    .run(
      session.playedDate,
      gameId,
      source,
      sourceId,
      externalId,
      session.startedAt,
      session.endedAt,
      session.durationSeconds,
      session.playedDate,
    );
  return { inserted: false, changed: Number(corrected.changes || 0) > 0 };
}

function refreshGameAggregate(db: PlayDatabase, gameId: string, now: string) {
  const session = db
    .prepare(
      `SELECT COALESCE(SUM(duration_seconds), 0) AS total_seconds,
        COUNT(DISTINCT COALESCE(NULLIF(played_date, ''), substr(started_at, 1, 10))) AS play_days,
        MIN(started_at) AS first_played_at,
        MAX(ended_at) AS last_played_at
      FROM play_sessions WHERE game_id = ?`,
    )
    .get(gameId) as Record<string, unknown>;
  const sessionTotal = Number(session.total_seconds || 0);
  const firstPlayedAt = typeof session.first_played_at === "string" ? session.first_played_at : "";
  const lastPlayedAt = typeof session.last_played_at === "string" ? session.last_played_at : "";
  db.prepare(
    `UPDATE play_games SET total_seconds = ?, play_days = ?,
      first_played_at = COALESCE(NULLIF(?, ''), first_played_at),
      last_played_at = COALESCE(NULLIF(?, ''), last_played_at),
      updated_at = ? WHERE id = ?`,
  ).run(sessionTotal, Number(session.play_days || 0), firstPlayedAt, lastPlayedAt, now, gameId);
}

function createSuggestedPurchaseLink(
  db: PlayDatabase,
  gameId: string,
  records: GameRecord[],
  now: string,
) {
  if (db.prepare("SELECT id FROM play_purchase_links WHERE play_game_id = ?").get(gameId)) return;
  const game = db
    .prepare("SELECT official_url, normalized_title, platform FROM play_games WHERE id = ?")
    .get(gameId) as
    { official_url?: unknown; normalized_title?: unknown; platform?: unknown } | undefined;
  if (!game) return;

  const platform = normalizePlatform(game.platform);
  const platformRecords = records.filter((record) => record.platform === platform);
  const officialUrl = normalizeOfficialUrl(String(game.official_url || ""));
  let matches = officialUrl
    ? platformRecords.filter((record) => normalizeOfficialUrl(record.officialUrl) === officialUrl)
    : [];
  let method: PlayPurchaseLink["method"] = "official_url";
  let confidence = 0.98;
  if (matches.length !== 1) {
    const normalizedTitle = String(game.normalized_title || "");
    matches = normalizedTitle
      ? platformRecords.filter((record) => normalizeTitle(record.title) === normalizedTitle)
      : [];
    method = "normalized_title";
    confidence = 0.9;
  }
  if (matches.length !== 1) return;

  db.prepare(
    `INSERT INTO play_purchase_links(
      id, play_game_id, purchase_record_id, status, match_method,
      confidence, created_at, updated_at
    ) VALUES(?, ?, ?, 'suggested', ?, ?, ?, ?)`,
  ).run(randomUUID(), gameId, matches[0].id, method, confidence, now, now);
}

function querySummaryRows(
  db: PlayDatabase,
  sort: string,
  direction: string,
  where = "",
  values: unknown[] = [],
) {
  const orderBy =
    sort === "title"
      ? "g.normalized_title"
      : sort === "first"
        ? "g.first_played_at"
        : sort === "total" || sort === "time"
          ? "g.total_seconds"
          : sort === "days"
            ? "g.play_days"
            : "g.last_played_at";
  const order =
    direction === "asc" ? "ASC" : direction === "desc" ? "DESC" : sort === "title" ? "ASC" : "DESC";
  const rows = db
    .prepare(
      `SELECT g.id, g.source, g.source_id, g.title, g.normalized_title, g.title_id, g.platform,
        g.official_url, g.total_seconds, g.play_days,
        g.first_played_at, g.last_played_at, g.time_semantics,
        COUNT(DISTINCT s.id) AS session_count,
        COUNT(DISTINCT o.id) AS observation_count,
        l.status AS link_status, l.match_method, l.confidence,
        l.purchase_record_id
      FROM play_games g
      LEFT JOIN play_sessions s ON s.game_id = g.id
      LEFT JOIN play_observations o ON o.game_id = g.id
      LEFT JOIN play_purchase_links l ON l.play_game_id = g.id
      ${where ? `WHERE ${where}` : ""}
      GROUP BY g.id
      ORDER BY ${orderBy} ${order}, g.id ASC`,
    )
    .all(...values) as SummaryRow[];
  return rows;
}

function toSummary(row: SummaryRow, records: GameRecord[]): PlayGameSummary {
  const link = toLink(row, records);
  const sessionCount = Number(row.session_count || 0);
  const observationCount = Number(row.observation_count || 0);
  const platform = normalizePlatform(row.platform);
  return {
    id: String(row.id),
    source: normalizeSource(row.source),
    sourceId: String(row.source_id || defaultPlaySourceId),
    aggregateKey: playAggregateKey(row, link, platform),
    title: String(row.title),
    titleId: String(row.title_id || ""),
    platform,
    officialUrl: String(row.official_url || ""),
    coverUrl: coverForLink(link, records),
    totalSeconds: Number(row.total_seconds || 0),
    playDays: Number(row.play_days || 0),
    firstPlayedAt: String(row.first_played_at || ""),
    lastPlayedAt: String(row.last_played_at || ""),
    timeSemantics: normalizeTimeSemantics(row.time_semantics),
    sessionCount,
    observationCount,
    link,
  };
}

function playAggregateKey(row: SummaryRow, link: PlayPurchaseLink | null, platform: GamePlatform) {
  if (link?.status === "confirmed" && link.purchaseRecordId)
    return `purchase:${link.purchaseRecordId}`;
  const titleId = String(row.title_id || "")
    .trim()
    .toLowerCase();
  if (titleId) return `title-id:${platform}:${titleId}`;
  const title = String(row.normalized_title || normalizeTitle(String(row.title)));
  return `title:${platform}:${title}`;
}

export function ensureSuggestedPurchaseLink(db: PlayDatabase, gameId: string, now: string) {
  createSuggestedPurchaseLink(db, gameId, readLedgerRecords(db), now);
}

function toLink(row: LinkColumns, records: GameRecord[]): PlayPurchaseLink | null {
  const status = row.link_status;
  if (status !== "suggested" && status !== "confirmed" && status !== "rejected") return null;
  const method = row.match_method;
  const normalizedMethod: PlayPurchaseLink["method"] =
    method === "official_url" || method === "normalized_title" || method === "manual"
      ? method
      : "manual";
  const purchaseRecordId = row.purchase_record_id ? String(row.purchase_record_id) : null;
  const purchase = purchaseRecordId
    ? records.find((record) => record.id === purchaseRecordId)
    : undefined;
  return {
    status,
    method: normalizedMethod,
    confidence: Math.max(0, Math.min(1, Number(row.confidence || 0))),
    purchaseRecordId,
    purchaseTitle: purchase?.title || null,
  };
}

function coverForLink(link: PlayPurchaseLink | null, records: GameRecord[]) {
  if (!link || link.status === "rejected" || !link.purchaseRecordId) return "";
  return records.find((record) => record.id === link.purchaseRecordId)?.coverUrl || "";
}

function readLedgerRecords(db: PlayDatabase) {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_documents'")
    .get();
  if (!tableExists) return [];
  const row = db.prepare("SELECT records FROM ledger_documents WHERE id = 'default'").get() as
    { records?: unknown } | undefined;
  if (typeof row?.records !== "string" || !row.records) return [];
  try {
    const parsed = JSON.parse(row.records) as unknown;
    return normalizeRecords(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function initialGameDates(game: CanonicalPlayGame, fallback: string) {
  const firstPlayedAt = earliestDate(...game.sessions.map((session) => session.startedAt));
  const lastPlayedAt = latestDate(...game.sessions.map((session) => session.endedAt));
  return {
    firstPlayedAt: firstPlayedAt || fallback,
    lastPlayedAt: lastPlayedAt || fallback,
  };
}

function earliestDate(...values: string[]) {
  return values.filter(Boolean).sort()[0] || "";
}

function latestDate(...values: string[]) {
  return values.filter(Boolean).sort().at(-1) || "";
}

function normalizePlatform(value: unknown): GamePlatform {
  return value === "PlayStation" ? "PlayStation" : "Nintendo Switch";
}

function normalizeSource(value: unknown): PlaySource {
  if (value === "manual" || value === "moon_connector" || value === "nintendo_store") return value;
  return "json_import";
}

function normalizeTimeSemantics(value: unknown): PlayGameSummary["timeSemantics"] {
  if (value === "daily_aggregate" || value === "snapshot_observation") return value;
  return "play_timeline";
}

function normalizeReportStatus(value: unknown): RecentPlaySession["reportStatus"] {
  if (
    value === "CALCULATING" ||
    value === "ACHIEVED" ||
    value === "UNACHIEVED" ||
    value === "UNKNOWN"
  )
    return value;
  return null;
}

function parseStoredPreview(value: string) {
  try {
    const preview = JSON.parse(value) as Partial<ImportPreview> & {
      games?: Array<CanonicalPlayGame & { itemIndex?: number }>;
    };
    if (!preview || typeof preview !== "object" || !Array.isArray(preview.games)) {
      throw new Error("invalid preview");
    }
    return {
      ...preview,
      sourceId:
        typeof preview.sourceId === "string" && preview.sourceId
          ? preview.sourceId
          : defaultPlaySourceId,
      existingGames: numberOrZero(preview.existingGames),
      existingSessions: numberOrZero(preview.existingSessions),
      conflictingGames: numberOrZero(preview.conflictingGames),
      conflictingSessions: numberOrZero(preview.conflictingSessions),
      games: preview.games.map((game, index) => ({
        ...game,
        itemIndex: Number.isInteger(game.itemIndex) ? Number(game.itemIndex) : index,
        sessions: game.sessions.map((session) => ({
          ...session,
          playedDate: session.playedDate || session.startedAt.slice(0, 10),
        })),
      })),
    } as ImportPreview;
  } catch {
    throw new ImportInvalidError("IMPORT_PREVIEW_CORRUPT");
  }
}

function inspectExistingImport(db: PlayDatabase, preview: ImportPreview): ImportPreview {
  const issues = [...preview.issues];
  let existingGames = 0;
  let existingSessions = 0;
  let conflictingGames = 0;
  let conflictingSessions = 0;
  const findGame = db.prepare(
    `SELECT id, platform FROM play_games
      WHERE source = 'json_import' AND source_id = ? AND external_id = ?`,
  );
  const findSession = db.prepare(
    `SELECT game_id, started_at, ended_at, played_date, duration_seconds
      FROM play_sessions
      WHERE source = 'json_import' AND source_id = ? AND external_id = ?`,
  );

  for (const game of preview.games) {
    const storedGame = findGame.get(
      preview.sourceId,
      scopedExternalId(preview.sourceId, game.externalId),
    ) as { id?: unknown; platform?: unknown } | undefined;
    if (storedGame?.id) {
      existingGames += 1;
      if (normalizePlatform(storedGame.platform) !== game.platform) {
        conflictingGames += 1;
        issues.push({
          index: game.itemIndex,
          path: `$.games[${game.itemIndex}].platform`,
          message: "同一 sourceId 与 externalId 已用于不同平台",
        });
      }
    }

    for (const session of game.sessions) {
      const storedSession = findSession.get(
        preview.sourceId,
        scopedExternalId(preview.sourceId, session.externalId),
      ) as Record<string, unknown> | undefined;
      if (!storedSession) continue;
      existingSessions += 1;
      const belongsToGame = Boolean(
        storedGame?.id && String(storedSession.game_id) === storedGame.id,
      );
      if (
        !belongsToGame ||
        String(storedSession.started_at) !== session.startedAt ||
        String(storedSession.ended_at) !== session.endedAt ||
        Number(storedSession.duration_seconds) !== session.durationSeconds
      ) {
        conflictingSessions += 1;
        issues.push({
          index: game.itemIndex,
          path: `$.games[${game.itemIndex}].sessions`,
          message: `会话 ${session.externalId} 已存在但内容不同`,
        });
      }
    }
  }

  return {
    ...preview,
    valid: issues.length === 0,
    existingGames,
    existingSessions,
    conflictingGames,
    conflictingSessions,
    issues: issues.slice(0, 100),
  };
}

function scopedExternalId(sourceId: string, externalId: string) {
  return sourceId === defaultPlaySourceId ? externalId : `${sourceId}/${externalId}`;
}

function numberOrZero(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function findBatchByIdempotencyKey(db: PlayDatabase, idempotencyKey: string) {
  return db
    .prepare(
      `SELECT id, payload_sha256, status, preview_json
      FROM import_batches WHERE idempotency_key = ?`,
    )
    .get(idempotencyKey) as BatchRow | undefined;
}

function replayPreview(existing: BatchRow, sha256: string) {
  if (existing.payload_sha256 !== sha256) throw new ImportConflictError();
  return {
    batchId: existing.id,
    status: existing.status,
    replayed: true,
    preview: parseStoredPreview(existing.preview_json),
  };
}

function rollback(db: PlayDatabase) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The original database error is more useful than a secondary rollback error.
  }
}

function isUniqueConstraint(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("code" in error && String((error as { code?: unknown }).code).includes("CONSTRAINT")) ||
      ("message" in error &&
        String((error as { message?: unknown }).message)
          .toLowerCase()
          .includes("unique")))
  );
}
