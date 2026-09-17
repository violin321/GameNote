import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { registerPurchaseProjectionSqlFunctions } from "../../scripts/purchase-projection-json.mjs";
import { widenMoonGameSource } from "../../scripts/moon-migration.mjs";
import { widenStoreGameSource } from "../../scripts/store-migration.mjs";
import {
  ensureAllPlayGameEntityBindings,
  ensurePlayGameEntityBinding,
  gameEntityStrongKey,
  resolveGameEntityId,
  upsertGameEntityPurchaseLink,
} from "./entities";
import { ns2DatabaseIdentity, ns2SchemaVersion, playDatabaseFilePath } from "./database-config";
import type {
  CanonicalPlayGame,
  DashboardStats,
  ImportPreview,
  ManualPlayEntryInput,
  PlayGameDetail,
  PlayGameSummary,
  PurchasePlaySummary,
  RecentPlayActivity,
  RecentPlaySession,
} from "./types";
import { normalizeTitle } from "./validation";

export type StatementSync = {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  all(...values: unknown[]): unknown[];
};
export type DatabaseSync = {
  readonly isTransaction: boolean;
  close(): void;
  exec(sql: string): void;
  function(
    name: string,
    options: { deterministic: boolean },
    callback: (value: unknown) => string,
  ): void;
  prepare(sql: string): StatementSync;
};
type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };

export class ImportConflictError extends Error {
  constructor(message = "IDEMPOTENCY_CONFLICT") {
    super(message);
    this.name = "ImportConflictError";
  }
}
export class ImportNotFoundError extends Error {}
export class ImportInvalidError extends Error {}

export async function migratePlayDatabase() {
  const db = await openDatabase({ allowUninitialized: true });
  try {
    registerPurchaseProjectionSqlFunctions(db);
    // Must be disabled before BEGIN: replacing a parent with FK checking ON
    // would cascade-delete sessions, observations and manual purchase decisions.
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    try {
      const existingTables = Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get() as { count?: number | bigint } | undefined
        )?.count || 0,
      );
      if (existingTables > 0) assertCompatibleNs2Database(db);
      await applyMigration(db, 1, "play_history", "001_play_history.sql");
      await applyMigration(db, 2, "purchase_projection", "002_purchase_projection.sql");
      await applyMigration(db, 3, "moon_connector", "003_moon_connector.sql");
      await applyMigration(db, 4, "nintendo_store", "004_nintendo_store.sql");
      await applyMigration(db, 5, "nintendo_store_history", "005_nintendo_store_history.sql");
      await applyMigration(db, 6, "game_entities", "006_game_entities.sql");
      db.prepare("UPDATE app_metadata SET value=? WHERE key='schema_version'").run(
        String(ns2SchemaVersion),
      );
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("NS2 migration would leave invalid foreign keys");
      assertDatabaseIdentity(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
    db.close();
  }
}

async function applyMigration(db: DatabaseSync, version: number, name: string, fileName: string) {
  const migrationTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (
    migrationTable &&
    db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)
  ) {
    if (version === 6) await reconcileGameEntitySchema(db);
    return;
  }

  // The V2 down migration intentionally preserves projection columns so V1 can
  // ignore them and repeated down is harmless. Re-up therefore only restores
  // the marker when the complete V2 shape is already present.
  if (version === 2 && hasPurchaseProjectionSchema(db)) {
    const reconcileSql = await readFile(
      resolve(process.cwd(), "migrations", "002_purchase_projection.reconcile.sql"),
      "utf8",
    );
    db.exec(reconcileSql);
  } else {
    if (version === 3) widenMoonGameSource(db);
    if (version === 4) widenStoreGameSource(db);
    const sql = await readFile(resolve(process.cwd(), "migrations", fileName), "utf8");
    db.exec(sql);
  }
  db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)").run(
    version,
    name,
    new Date().toISOString(),
  );
  if (version === 6) await reconcileGameEntitySchema(db);
}

async function reconcileGameEntitySchema(db: DatabaseSync) {
  const sql = await readFile(
    resolve(process.cwd(), "migrations", "006_game_entities.reconcile.sql"),
    "utf8",
  );
  db.exec(sql);
}

function hasPurchaseProjectionSchema(db: DatabaseSync) {
  const columns = new Set(
    (
      db.prepare("SELECT name FROM pragma_table_info('purchase_records')").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  return [
    "source_updated_at",
    "projection_hash",
    "deleted_at",
    "platform_family",
    "platform_variant",
    "cover_url",
    "purchase_date",
    "source_document_id",
  ].every((column) => columns.has(column));
}

export async function saveImportPreview(
  idempotencyKey: string,
  sha256: string,
  preview: ImportPreview,
) {
  const db = await openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = findBatchByIdempotencyKey(db, idempotencyKey);
      if (existing) {
        const replay = replayPreview(existing, sha256);
        db.exec("COMMIT");
        return replay;
      }

      const batchId = randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(
          `INSERT INTO import_batches(id, idempotency_key, payload_sha256, status, item_count, error_count, preview_json, created_at)
          VALUES(?, ?, ?, 'previewed', ?, ?, ?, ?)`,
        ).run(
          batchId,
          idempotencyKey,
          sha256,
          preview.itemCount,
          preview.issues.length,
          JSON.stringify(preview),
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

      const insertItem =
        db.prepare(`INSERT INTO import_items(id, batch_id, item_index, external_id, status, error, canonical_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`);
      const issuesByIndex = new Map<number, string[]>();
      for (const issue of preview.issues)
        issuesByIndex.set(issue.index, [
          ...(issuesByIndex.get(issue.index) || []),
          `${issue.path}: ${issue.message}`,
        ]);
      for (let index = 0; index < preview.itemCount; index += 1) {
        const game = preview.games[index];
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
      return { batchId, status: "previewed", replayed: false, preview };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

type CommitOptions = {
  injectFailureAfterSession?: number;
  source?: "json_import" | "nintendo_connector";
};
export async function commitImportBatch(batchId: string, options: CommitOptions = {}) {
  const db = await openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const batch = db
        .prepare("SELECT id, status, preview_json FROM import_batches WHERE id = ?")
        .get(batchId) as BatchRow | undefined;
      if (!batch) throw new ImportNotFoundError("IMPORT_BATCH_NOT_FOUND");
      if (batch.status === "committed") {
        db.exec("COMMIT");
        return {
          batchId,
          status: "committed",
          replayed: true,
          insertedGames: 0,
          insertedSessions: 0,
          insertedObservations: 0,
        };
      }
      if (batch.status !== "previewed") throw new ImportConflictError("IMPORT_STATUS_CONFLICT");
      const preview = JSON.parse(batch.preview_json) as ImportPreview;
      if (!preview.valid) throw new ImportInvalidError("IMPORT_PREVIEW_INVALID");
      let insertedGames = 0;
      let insertedSessions = 0;
      let insertedObservations = 0;
      const now = new Date().toISOString();
      const source = options.source ?? "json_import";
      for (const game of preview.games) {
        const gameId = upsertPlayGame(db, game, now, source);
        if (gameId.inserted) insertedGames += 1;
        for (const session of game.sessions) {
          const sessionResult = upsertPlaySession(db, gameId.id, source, session, now);
          if (sessionResult.inserted) insertedSessions += 1;
          if (sessionResult.changed) {
            db.prepare(
              `INSERT INTO play_observations(id, game_id, observed_at, total_seconds, source, import_batch_id, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              randomUUID(),
              gameId.id,
              session.endedAt,
              session.durationSeconds,
              source,
              batchId,
              now,
            );
            insertedObservations += 1;
            if (
              options.injectFailureAfterSession &&
              insertedSessions >= options.injectFailureAfterSession
            )
              throw new Error("INJECTED_IMPORT_FAILURE");
          }
        }
        for (const observation of game.observations) {
          const result = db
            .prepare(
              `INSERT OR IGNORE INTO play_observations(id, game_id, observed_at, total_seconds, source, import_batch_id, created_at)
              VALUES(?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              gameId.id,
              observation.observedAt,
              observation.totalSeconds,
              source,
              batchId,
              now,
            );
          insertedObservations += Number(result.changes || 0);
        }
        refreshGameAggregate(db, gameId.id, now, source);
        ensurePlayGameEntityBinding(db, gameId.id, now);
        createSuggestedPurchaseLink(db, gameId.id, now);
      }
      const claimed = db
        .prepare(
          "UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ? AND status = 'previewed'",
        )
        .run(now, batchId);
      if (Number(claimed.changes || 0) !== 1)
        throw new ImportConflictError("IMPORT_COMMIT_CAS_CONFLICT");
      db.prepare(
        "UPDATE import_items SET status = 'inserted' WHERE batch_id = ? AND status = 'valid'",
      ).run(batchId);
      db.exec("COMMIT");
      return {
        batchId,
        status: "committed",
        replayed: false,
        insertedGames,
        insertedSessions,
        insertedObservations,
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
  const sortColumns: Record<string, string> = {
    recent: "e.entity_last_activity_at",
    total: "e.entity_total_seconds",
    days: "e.entity_play_days",
    first: "e.entity_first_played_at",
    title: "e.normalized_title",
  };
  const column = sortColumns[sort] || sortColumns.recent;
  const order = direction === "asc" ? "ASC" : "DESC";
  const normalizedQuery = normalizeTitle(query);
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const rows = db
      .prepare(
        `${effectivePlayGamesSql}, matched_identities AS (
          SELECT DISTINCT identity_key FROM source_games
          WHERE (? = '' OR normalized_title LIKE '%' || ? || '%'
            OR gamenote_normalize_title(title) LIKE '%' || ? || '%'
            OR lower(COALESCE(title_id,'')) = lower(?))
        )
        SELECT e.id,e.identity_key AS entity_id,e.id AS source_game_id,
          e.source,e.entity_title AS title,
          e.entity_title_id AS title_id,e.entity_official_url AS official_url,
          e.entity_platform AS platform,${playGameCoverSql("e")} AS cover_url,
          e.entity_total_seconds AS total_seconds,e.entity_play_days AS play_days,
          e.entity_first_played_at AS first_played_at,
          e.entity_last_activity_at AS last_played_at,COUNT(s.id) AS session_count,
          selected_link.status AS link_status, selected_link.match_method,
          selected_link.confidence, selected_link.purchase_record_id, selected_link.purchase_title
        FROM effective_games e
        JOIN matched_identities matched ON matched.identity_key=e.identity_key
        LEFT JOIN source_bindings session_binding ON session_binding.entity_id=e.identity_key
        LEFT JOIN play_sessions s ON s.game_id=session_binding.play_game_id
        LEFT JOIN effective_identity_links selected_link ON selected_link.identity_key=e.identity_key
        GROUP BY e.id
      ORDER BY ${column} ${order}, e.id ASC LIMIT 500`,
      )
      .all(normalizedQuery, normalizedQuery, normalizedQuery, normalizedQuery) as Array<
      Record<string, unknown>
    >;
    return rows.map(toSummary);
  } finally {
    db.close();
  }
}

export async function listRecentSessions(days: 7 | 30 | 90, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const rows = db
      .prepare(
        `SELECT s.id,b.entity_id AS game_id,entity.canonical_title AS title,
          COALESCE(NULLIF(p.cover_url,''),${entityCoverSql("b.entity_id")},'') AS cover_url,
          s.started_at, s.ended_at, s.duration_seconds
        FROM play_sessions s
        JOIN play_games g ON g.id = s.game_id
        JOIN source_bindings b ON b.play_game_id=g.id
        JOIN game_entities entity ON entity.id=b.entity_id
        LEFT JOIN game_entity_purchase_links l
          ON l.entity_id=b.entity_id AND l.status='confirmed'
        LEFT JOIN purchase_records p ON p.id = l.purchase_record_id
        WHERE s.started_at >= ? AND g.source != 'nintendo_store'
        ORDER BY s.started_at DESC, s.id ASC
        LIMIT 2000`,
      )
      .all(cutoff) as Array<Record<string, unknown>>;
    return rows.map(
      (row): RecentPlaySession => ({
        id: String(row.id),
        gameId: String(row.game_id),
        title: String(row.title),
        coverUrl: String(row.cover_url || ""),
        startedAt: String(row.started_at),
        endedAt: String(row.ended_at),
        durationSeconds: Number(row.duration_seconds),
      }),
    );
  } finally {
    db.close();
  }
}

export async function listRecentPlayActivity(days: 7 | 30 | 90, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const rows = db
      .prepare(
        `WITH recent_activity AS (
        SELECT s.id,b.entity_id AS game_id,entity.canonical_title AS title,
          entity.platform,
          COALESCE(NULLIF(p.cover_url,''),${entityCoverSql("b.entity_id")},'') AS cover_url,
          s.started_at AS occurred_at, s.ended_at, s.duration_seconds AS seconds,
          'play_timeline' AS time_semantics, s.source, NULL AS official_date, NULL AS report_status
        FROM play_sessions s
        JOIN play_games g ON g.id = s.game_id
        JOIN source_bindings b ON b.play_game_id=g.id
        JOIN game_entities entity ON entity.id=b.entity_id
        LEFT JOIN game_entity_purchase_links l
          ON l.entity_id=b.entity_id AND l.status='confirmed'
        LEFT JOIN purchase_records p ON p.id = l.purchase_record_id
        WHERE s.started_at >= ?
        UNION ALL
        SELECT 'moon-daily:' || r.id || ':' || b.entity_id AS id,b.entity_id AS game_id,
          entity.canonical_title AS title,
          entity.platform,
          COALESCE(NULLIF(p.cover_url, ''), m.image_url, '') AS cover_url,
          r.official_date AS occurred_at, NULL AS ended_at, d.total_seconds AS seconds,
          'daily_aggregate' AS time_semantics, g.source, r.official_date, r.result AS report_status
        FROM moon_connector_report_games d
        JOIN moon_connector_reports r ON r.id=d.report_id
        JOIN moon_connector_games m ON m.play_game_id=d.play_game_id
        JOIN play_games g ON g.id=d.play_game_id
        JOIN source_bindings b ON b.play_game_id=g.id
        JOIN game_entities entity ON entity.id=b.entity_id
        LEFT JOIN game_entity_purchase_links l ON l.entity_id=b.entity_id AND l.status='confirmed'
        LEFT JOIN purchase_records p ON p.id=l.purchase_record_id
        WHERE r.official_date >= date(?, printf('%+d seconds',r.time_zone_offset_seconds), ?)
          AND r.official_date <= date(?, printf('%+d seconds',r.time_zone_offset_seconds))
        )
        SELECT * FROM recent_activity
        ORDER BY occurred_at DESC, id ASC
        LIMIT 2000`,
      )
      .all(cutoff, now.toISOString(), `-${days - 1} days`, now.toISOString()) as Array<
      Record<string, unknown>
    >;
    return rows.map(
      (row): RecentPlayActivity => ({
        id: String(row.id),
        gameId: String(row.game_id),
        title: String(row.title),
        platform: String(row.platform || ""),
        coverUrl: String(row.cover_url || ""),
        occurredAt: String(row.occurred_at),
        endedAt: row.ended_at ? String(row.ended_at) : null,
        seconds: Number(row.seconds),
        timeSemantics: row.time_semantics as RecentPlayActivity["timeSemantics"],
        source: row.source as RecentPlayActivity["source"],
        date: row.official_date ? String(row.official_date) : null,
        reportStatus: row.report_status as RecentPlayActivity["reportStatus"],
      }),
    );
  } finally {
    db.close();
  }
}

export async function getPlayGameDetail(gameId: string) {
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const entityId = resolveGameEntityId(db, gameId);
    if (!entityId) return null;
    const row = db
      .prepare(
        `${effectivePlayGamesSql}
        SELECT g.id,g.identity_key AS entity_id,g.id AS source_game_id,
          g.source,g.entity_title AS title,
          g.entity_title_id AS title_id,g.entity_platform AS platform,
          g.entity_official_url AS official_url,
          ${playGameCoverSql("g")} AS cover_url,g.entity_total_seconds AS total_seconds,
          g.entity_play_days AS play_days,g.entity_first_played_at AS first_played_at,
          g.entity_last_activity_at AS last_played_at,COUNT(s.id) AS session_count,
          selected_link.status AS link_status, selected_link.match_method, selected_link.confidence,
          selected_link.purchase_record_id, selected_link.purchase_title
        FROM effective_games g
        LEFT JOIN source_bindings session_binding ON session_binding.entity_id=g.identity_key
        LEFT JOIN play_sessions s ON s.game_id=session_binding.play_game_id
        LEFT JOIN effective_identity_links selected_link ON selected_link.identity_key=g.identity_key
        WHERE g.identity_key=? GROUP BY g.id`,
      )
      .get(entityId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sessions = db
      .prepare(
        `SELECT s.id,s.source,s.started_at,s.ended_at,s.duration_seconds
         FROM source_bindings b JOIN play_sessions s ON s.game_id=b.play_game_id
         WHERE b.entity_id=? ORDER BY s.started_at DESC`,
      )
      .all(entityId) as Array<Record<string, unknown>>;
    const source = String(row.source);
    const titleId = String(row.title_id || "");
    let dailyReports: Array<Record<string, unknown>> = [];
    const dailyReportSql = `SELECT r.id,r.official_date,r.device_id,r.result,
      r.time_zone_offset_seconds,d.total_seconds FROM moon_connector_report_games d
      JOIN moon_connector_reports r ON r.id=d.report_id`;
    if (source === "nintendo_store" || source === "moon_connector" || titleId)
      dailyReports = db
        .prepare(
          `${dailyReportSql}
           JOIN source_bindings moon_binding ON moon_binding.play_game_id=d.play_game_id
           WHERE moon_binding.entity_id=? ORDER BY r.official_date DESC,r.device_id ASC`,
        )
        .all(entityId) as Array<Record<string, unknown>>;
    return {
      ...toSummary(row),
      sessions: sessions.map((session) => ({
        id: String(session.id),
        source: session.source as PlayGameDetail["sessions"][number]["source"],
        startedAt: String(session.started_at),
        endedAt: String(session.ended_at),
        durationSeconds: Number(session.duration_seconds),
      })),
      dailyReports: dailyReports.map((report) => ({
        id: String(report.id),
        date: String(report.official_date),
        deviceId: String(report.device_id),
        seconds: Number(report.total_seconds),
        reportStatus: report.result as NonNullable<RecentPlayActivity["reportStatus"]>,
        timeZoneOffsetSeconds: Number(report.time_zone_offset_seconds),
      })),
    } satisfies PlayGameDetail;
  } finally {
    db.close();
  }
}

export async function listUnlinkedPlayGames(query = "") {
  const normalizedQuery = normalizeTitle(query);
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const rows = db
      .prepare(
        `${effectivePlayGamesSql}, matched_identities AS (
          SELECT DISTINCT identity_key FROM source_games
          WHERE (? = '' OR normalized_title LIKE '%' || ? || '%'
            OR gamenote_normalize_title(title) LIKE '%' || ? || '%'
            OR lower(COALESCE(title_id,'')) = lower(?))
        )
        SELECT e.id,e.identity_key AS entity_id,e.id AS source_game_id,
          e.source,e.entity_title AS title,
          e.entity_title_id AS title_id,e.entity_official_url AS official_url,
          e.entity_platform AS platform,${playGameCoverSql("e")} AS cover_url,
          e.entity_total_seconds AS total_seconds,e.entity_play_days AS play_days,
          e.entity_first_played_at AS first_played_at,
          e.entity_last_activity_at AS last_played_at,COUNT(s.id) AS session_count,
          selected_link.status AS link_status, selected_link.match_method,
          selected_link.confidence, selected_link.purchase_record_id, selected_link.purchase_title
        FROM effective_games e
        JOIN matched_identities matched ON matched.identity_key=e.identity_key
        LEFT JOIN source_bindings session_binding ON session_binding.entity_id=e.identity_key
        LEFT JOIN play_sessions s ON s.game_id=session_binding.play_game_id
        LEFT JOIN effective_identity_links selected_link ON selected_link.identity_key=e.identity_key
        WHERE COALESCE(selected_link.status, '') != 'confirmed'
        GROUP BY e.id ORDER BY e.entity_last_activity_at DESC,e.id ASC`,
      )
      .all(normalizedQuery, normalizedQuery, normalizedQuery, normalizedQuery) as Array<
      Record<string, unknown>
    >;
    return rows.map(toSummary);
  } finally {
    db.close();
  }
}

export async function listPurchasePlaySummaries() {
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const rows = db
      .prepare(
        `${effectivePlayGamesSql}, linked_candidates AS (
          SELECT e.id,e.source,e.entity_total_seconds AS total_seconds,
            e.entity_first_played_at AS first_played_at,
            e.entity_last_played_at AS last_played_at,
            e.identity_key,acquisition.purchase_record_id
          FROM effective_games e
          JOIN game_entity_acquisitions acquisition ON acquisition.entity_id=e.identity_key
          JOIN purchase_records purchase
            ON purchase.id=acquisition.purchase_record_id AND purchase.deleted_at IS NULL
        ), effective_linked_games AS (
          SELECT candidate.*
          FROM linked_candidates candidate
          WHERE candidate.source IN ('nintendo_store','moon_connector')
            OR NOT EXISTS (
              SELECT 1
              FROM effective_games stronger
              JOIN game_entity_acquisitions stronger_link
                ON stronger_link.entity_id=stronger.identity_key
                AND stronger_link.purchase_record_id=candidate.purchase_record_id
              WHERE stronger.source IN ('nintendo_store','moon_connector')
                AND stronger.identity_key != candidate.identity_key
                AND (stronger.source='nintendo_store' OR EXISTS(
                  SELECT 1 FROM moon_connector_report_games daily
                  WHERE daily.play_game_id=stronger.id
                ))
            )
        )
        SELECT purchase_record_id,
          SUM(total_seconds) AS total_seconds,
          MIN(NULLIF(first_played_at,'')) AS first_played_at,
          MAX(NULLIF(last_played_at,'')) AS last_played_at,
          GROUP_CONCAT(DISTINCT source) AS sources
        FROM effective_linked_games
        GROUP BY purchase_record_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(
      (row): PurchasePlaySummary => ({
        purchaseRecordId: String(row.purchase_record_id),
        totalSeconds: Number(row.total_seconds || 0),
        firstPlayedAt: String(row.first_played_at || ""),
        lastPlayedAt: String(row.last_played_at || ""),
        timeSemantics: combinedTimeSemantics(String(row.sources || "")),
      }),
    );
  } finally {
    db.close();
  }
}

export async function getDashboardStats(includePlay: boolean): Promise<DashboardStats> {
  const db = await openDatabase();
  try {
    ensureAllPlayGameEntityBindings(db, new Date().toISOString());
    const purchases = db
      .prepare(
        `${effectivePlayGamesSql}
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN platform_family = 'Nintendo' THEN 1 ELSE 0 END) AS nintendo,
          SUM(CASE WHEN platform_family = 'PlayStation' THEN 1 ELSE 0 END) AS play_station,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM game_entity_acquisitions acquisition
            WHERE acquisition.purchase_record_id=purchase_records.id
          ) THEN 1 ELSE 0 END) AS linked
        FROM purchase_records WHERE deleted_at IS NULL`,
      )
      .get() as Record<string, unknown>;
    const total = Number(purchases.total || 0);
    const linked = Number(purchases.linked || 0);
    let play: DashboardStats["play"] = null;
    if (includePlay) {
      const row = db
        .prepare(
          `${effectivePlayGamesSql}, dashboard_games AS (
            SELECT e.*
            FROM effective_games e
            LEFT JOIN effective_identity_links selected_link ON selected_link.identity_key=e.identity_key
            WHERE e.source IN ('nintendo_store','moon_connector')
              OR NOT EXISTS (
                SELECT 1
                FROM effective_games stronger
                JOIN effective_identity_links stronger_link ON stronger_link.identity_key=stronger.identity_key
                WHERE stronger_link.status='confirmed'
                  AND selected_link.status='confirmed'
                  AND stronger_link.purchase_record_id=selected_link.purchase_record_id
                  AND stronger.source IN ('nintendo_store','moon_connector')
                  AND stronger.identity_key != e.identity_key
                  AND (stronger.source='nintendo_store' OR EXISTS(
                    SELECT 1 FROM moon_connector_report_games daily WHERE daily.play_game_id=stronger.id
                  ))
              )
          )
          SELECT COUNT(*) AS games,
            COALESCE(SUM(g.entity_total_seconds),0) AS total_seconds,
            COALESCE(SUM((SELECT COUNT(*) FROM source_bindings session_binding
              JOIN play_sessions s ON s.game_id=session_binding.play_game_id
              WHERE session_binding.entity_id=g.identity_key)),0) AS sessions,
            MAX(NULLIF(g.entity_last_played_at,'')) AS last_played_at,
            GROUP_CONCAT(DISTINCT CASE WHEN g.source IN ('moon_connector','nintendo_store','nintendo_connector') THEN g.source
              WHEN EXISTS(SELECT 1 FROM play_sessions s WHERE s.game_id=g.id) THEN 'manual' END) AS sources
          FROM dashboard_games g`,
        )
        .get() as Record<string, unknown>;
      play = {
        games: Number(row.games || 0),
        totalSeconds: Number(row.total_seconds || 0),
        sessions: Number(row.sessions || 0),
        lastPlayedAt: row.last_played_at ? String(row.last_played_at) : null,
        timeSemantics: combinedTimeSemantics(String(row.sources || "")),
      };
    }
    return {
      purchases: {
        total,
        nintendo: Number(purchases.nintendo || 0),
        playStation: Number(purchases.play_station || 0),
        linked,
        unlinked: Math.max(0, total - linked),
      },
      play,
    };
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
  const db = await openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      ensureAllPlayGameEntityBindings(db, now);
      const entityId = resolveGameEntityId(db, playGameId);
      if (!entityId) throw new ImportNotFoundError("PLAY_GAME_NOT_FOUND");
      if (
        action === "confirm" &&
        (!purchaseRecordId ||
          !db
            .prepare("SELECT id FROM purchase_records WHERE id = ? AND deleted_at IS NULL")
            .get(purchaseRecordId))
      )
        throw new ImportInvalidError("PURCHASE_RECORD_NOT_FOUND");
      const status = action === "confirm" ? "confirmed" : "rejected";
      const previous = db
        .prepare("SELECT purchase_record_id FROM game_entity_purchase_links WHERE entity_id=?")
        .get(entityId) as { purchase_record_id: string | null } | undefined;
      if (previous?.purchase_record_id && previous.purchase_record_id !== purchaseRecordId)
        db.prepare(
          "DELETE FROM game_entity_acquisitions WHERE entity_id=? AND purchase_record_id=?",
        ).run(entityId, previous.purchase_record_id);
      upsertGameEntityPurchaseLink(db, {
        entityId,
        purchase_record_id: action === "confirm" ? purchaseRecordId : null,
        status,
        match_method: "manual",
        confidence: 1,
        decided_at: now,
        decided_by: decidedBy,
        updated_at: now,
      });
      db.exec("COMMIT");
      return { playGameId, entityId, status };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function createManualPlayEntry(input: ManualPlayEntryInput, decidedBy: string) {
  const db = await openDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const startedAt = new Date(input.startedAt);
      const endedAt = new Date(startedAt.getTime() + input.durationSeconds * 1000).toISOString();
      const normalizedInputTitle = normalizeTitle(input.title);
      ensureAllPlayGameEntityBindings(db, now);
      let purchase: Record<string, unknown> | undefined;
      if (input.purchaseRecordId) {
        purchase = db
          .prepare(
            `SELECT id,title,title_id,official_url,normalized_title,platform_variant
             FROM purchase_records WHERE id=? AND deleted_at IS NULL`,
          )
          .get(input.purchaseRecordId) as Record<string, unknown> | undefined;
        if (!purchase) throw new ImportInvalidError("PURCHASE_RECORD_NOT_FOUND");
      }

      let entityId = input.playGameId ? resolveGameEntityId(db, input.playGameId) : null;
      if (input.playGameId && !entityId) throw new ImportNotFoundError("PLAY_GAME_NOT_FOUND");

      if (!entityId && purchase) {
        const linked = db
          .prepare(
            `SELECT entity_id FROM game_entity_purchase_links
             WHERE purchase_record_id=? AND status IN ('confirmed','suggested')
             ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END,
               updated_at DESC LIMIT 1`,
          )
          .get(input.purchaseRecordId) as { entity_id: string } | undefined;
        entityId = linked?.entity_id || null;
      }

      if (!entityId && purchase) {
        const titleId = String(purchase.title_id || "");
        const officialUrl = String(purchase.official_url || "");
        const strongKey = gameEntityStrongKey(titleId, purchase.platform_variant);
        const strong = strongKey
          ? (db.prepare("SELECT id FROM game_entities WHERE strong_key=?").get(strongKey) as
              | { id: string }
              | undefined)
          : undefined;
        const official =
          !strong?.id && officialUrl
            ? (db
                .prepare(
                  `SELECT id FROM game_entities WHERE official_url=?
                 ORDER BY updated_at DESC,id ASC LIMIT 2`,
                )
                .all(officialUrl) as Array<{ id: string }>)
            : [];
        entityId = strong?.id || (official.length === 1 ? official[0].id : null);
      }

      const entity = entityId
        ? (db
            .prepare(
              `SELECT canonical_title,title_id,official_url,platform
               FROM game_entities WHERE id=?`,
            )
            .get(entityId) as Record<string, unknown> | undefined)
        : undefined;
      const title = String(purchase?.title || input.title || entity?.canonical_title || "").trim();
      const normalizedTitle = normalizeTitle(title) || normalizedInputTitle;
      const platform = String(
        purchase?.platform_variant || entity?.platform || input.platform || "Nintendo Switch",
      );
      let target = entityId
        ? (db
            .prepare(
              `SELECT g.id,g.source FROM source_bindings b
               JOIN play_games g ON g.id=b.play_game_id
               WHERE b.entity_id=? AND g.source='manual'
               ORDER BY g.updated_at DESC,g.id ASC LIMIT 1`,
            )
            .get(entityId) as Record<string, unknown> | undefined)
        : undefined;

      if (!target) {
        const gameId = randomUUID();
        db.prepare(
          `INSERT INTO play_games(
            id,source,external_id,title,normalized_title,title_id,official_url,platform,
            first_played_at,last_played_at,total_seconds,play_days,created_at,updated_at
          ) VALUES(?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        ).run(
          gameId,
          `manual-game:${randomUUID()}`,
          title,
          normalizedTitle,
          purchase?.title_id || entity?.title_id || null,
          purchase?.official_url || entity?.official_url || null,
          platform,
          input.startedAt,
          endedAt,
          now,
          now,
        );
        target = { id: gameId, source: "manual" };
        entityId = ensurePlayGameEntityBinding(
          db,
          gameId,
          now,
          entityId ? { entityId } : undefined,
        );
      }

      const gameId = String(target.id);
      entityId ||= ensurePlayGameEntityBinding(db, gameId, now);
      const sessionId = randomUUID();
      db.prepare(
        `INSERT INTO play_sessions(
          id,game_id,source,external_id,started_at,ended_at,duration_seconds,imported_at
        ) VALUES(?, ?, 'manual', ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        gameId,
        `manual-session:${sessionId}`,
        input.startedAt,
        endedAt,
        input.durationSeconds,
        now,
      );

      if (String(target.source) === "manual" || String(target.source) === "json_import")
        refreshGameAggregate(db, gameId, now, String(target.source) as "manual" | "json_import");
      else db.prepare("UPDATE play_games SET updated_at=? WHERE id=?").run(now, gameId);

      if (input.purchaseRecordId)
        upsertGameEntityPurchaseLink(db, {
          entityId,
          purchase_record_id: input.purchaseRecordId,
          status: "confirmed",
          match_method: "manual",
          confidence: 1,
          decided_at: now,
          decided_by: decidedBy,
          updated_at: now,
        });
      else createSuggestedPurchaseLink(db, gameId, now);

      db.exec("COMMIT");
      return {
        gameId,
        entityId,
        sessionId,
        linkedPurchaseRecordId: input.purchaseRecordId,
      };
    } catch (error) {
      rollback(db);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function getPlayTableCounts() {
  const db = await openDatabase();
  try {
    const names = [
      "play_games",
      "play_sessions",
      "play_observations",
      "play_purchase_links",
      "import_batches",
      "import_items",
      "purchase_records",
    ];
    return Object.fromEntries(
      names.map((name) => [
        name,
        Number(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }).count,
        ),
      ]),
    );
  } finally {
    db.close();
  }
}

function upsertPlayGame(
  db: DatabaseSync,
  game: CanonicalPlayGame,
  now: string,
  source: "json_import" | "nintendo_connector",
) {
  const observationTimes = game.observations.map((item) => item.observedAt).sort();
  const reportedFirstPlayedAt = game.observations
    .map((item) => item.firstPlayedAt)
    .filter(Boolean)
    .sort()[0];
  const sessionFirst = game.sessions.map((item) => item.startedAt).sort()[0];
  const sessionLast = game.sessions
    .map((item) => item.endedAt)
    .sort()
    .at(-1);
  const first = sessionFirst || reportedFirstPlayedAt || observationTimes[0] || now;
  const last = sessionLast || observationTimes.at(-1) || first;
  const existing = db
    .prepare("SELECT id FROM play_games WHERE source = ? AND external_id = ?")
    .get(source, game.externalId) as { id?: string } | undefined;
  if (existing?.id) {
    db.prepare(
      `UPDATE play_games SET title=?, normalized_title=?, title_id=?, official_url=?,
        first_played_at=CASE WHEN ? < first_played_at THEN ? ELSE first_played_at END,
        last_played_at=CASE WHEN ? > last_played_at THEN ? ELSE last_played_at END,
        updated_at=? WHERE id=?`,
    ).run(
      game.title,
      game.normalizedTitle,
      game.titleId || null,
      game.officialUrl || null,
      first,
      first,
      last,
      last,
      now,
      existing.id,
    );
    return { id: existing.id, inserted: false };
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO play_games(id, source, external_id, title, normalized_title, title_id, official_url, first_played_at, last_played_at, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    source,
    game.externalId,
    game.title,
    game.normalizedTitle,
    game.titleId || null,
    game.officialUrl || null,
    first,
    last,
    now,
    now,
  );
  return { id, inserted: true };
}
function refreshGameAggregate(
  db: DatabaseSync,
  gameId: string,
  now: string,
  source: "json_import" | "manual" | "nintendo_connector",
) {
  if (source === "nintendo_connector") {
    db.prepare(
      `UPDATE play_games SET
        total_seconds=COALESCE((SELECT total_seconds FROM play_observations WHERE game_id=? ORDER BY observed_at DESC, created_at DESC LIMIT 1),0),
        play_days=COALESCE((SELECT COUNT(DISTINCT substr(started_at,1,10)) FROM play_sessions WHERE game_id=?),0),
        first_played_at=COALESCE((SELECT MIN(started_at) FROM play_sessions WHERE game_id=?),first_played_at),
        last_played_at=COALESCE((SELECT MAX(observed_at) FROM play_observations WHERE game_id=?),last_played_at),
        updated_at=? WHERE id=?`,
    ).run(gameId, gameId, gameId, gameId, now, gameId);
    return;
  }
  db.prepare(
    `UPDATE play_games SET total_seconds=COALESCE((SELECT SUM(duration_seconds) FROM play_sessions WHERE game_id=?),0),
    play_days=COALESCE((SELECT COUNT(DISTINCT substr(started_at,1,10)) FROM play_sessions WHERE game_id=?),0),
    first_played_at=COALESCE((SELECT MIN(started_at) FROM play_sessions WHERE game_id=?),first_played_at),
    last_played_at=COALESCE((SELECT MAX(ended_at) FROM play_sessions WHERE game_id=?),last_played_at), updated_at=? WHERE id=?`,
  ).run(gameId, gameId, gameId, gameId, now, gameId);
}
function upsertPlaySession(
  db: DatabaseSync,
  gameId: string,
  source: "json_import" | "nintendo_connector",
  session: CanonicalPlayGame["sessions"][number],
  now: string,
) {
  const existing = db
    .prepare(
      `SELECT id, game_id, started_at, ended_at, duration_seconds
      FROM play_sessions WHERE source = ? AND external_id = ?`,
    )
    .get(source, session.externalId) as Record<string, unknown> | undefined;
  if (existing && source === "nintendo_connector") {
    const changed =
      String(existing.game_id) !== gameId ||
      String(existing.started_at) !== session.startedAt ||
      String(existing.ended_at) !== session.endedAt ||
      Number(existing.duration_seconds) !== session.durationSeconds;
    if (changed)
      db.prepare(
        `UPDATE play_sessions SET game_id=?, started_at=?, ended_at=?, duration_seconds=?, imported_at=?
        WHERE id=?`,
      ).run(gameId, session.startedAt, session.endedAt, session.durationSeconds, now, existing.id);
    return { inserted: false, changed };
  }
  if (existing) return { inserted: false, changed: false };
  db.prepare(
    `INSERT INTO play_sessions(id, game_id, source, external_id, started_at, ended_at, duration_seconds, imported_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    gameId,
    source,
    session.externalId,
    session.startedAt,
    session.endedAt,
    session.durationSeconds,
    now,
  );
  return { inserted: true, changed: true };
}
export function createSuggestedPurchaseLink(db: DatabaseSync, gameId: string, now: string) {
  const entityId = ensurePlayGameEntityBinding(db, gameId, now);
  if (db.prepare("SELECT id FROM game_entity_purchase_links WHERE entity_id=?").get(entityId))
    return;
  const game = db
    .prepare("SELECT title_id, official_url, normalized_title FROM play_games WHERE id=?")
    .get(gameId) as Record<string, unknown>;
  const methods: Array<[string, unknown, number]> = [
    ["title_id", game.title_id, 1],
    ["official_url", game.official_url, 0.95],
    ["normalized_title", game.normalized_title, 0.8],
  ];
  for (const [column, value, confidence] of methods) {
    if (!value) continue;
    // Moon emits canonical lowercase application IDs while collection exports
    // commonly retain Nintendo's uppercase spelling of the same 16-hex ID.
    const comparison =
      column === "title_id" && typeof value === "string" && /^[a-fA-F0-9]{16}$/.test(value)
        ? `${column} = ? COLLATE NOCASE`
        : `${column} = ?`;
    const purchase = db
      .prepare(
        `SELECT id FROM purchase_records WHERE ${comparison} AND deleted_at IS NULL ORDER BY imported_at DESC LIMIT 1`,
      )
      .get(value) as { id?: string } | undefined;
    if (!purchase?.id) continue;
    upsertGameEntityPurchaseLink(db, {
      entityId,
      purchase_record_id: purchase.id,
      status: "suggested",
      match_method: column as "title_id" | "official_url" | "normalized_title",
      confidence,
      decided_at: null,
      decided_by: null,
      updated_at: now,
    });
    return;
  }
}
// A Store row is the account-level cumulative authority for a title when it
// exists. Moon rows remain the daily evidence source; they are hidden from the
// aggregate list only when an exact Store title-id match is available. Other
// sources keep their own identities so an NSO snapshot cannot silently replace
// a real session timeline.
const effectivePlayGamesSql = `WITH source_games AS (
  SELECT g.*, b.entity_id AS identity_key,
    entity.canonical_title AS entity_title,
    entity.normalized_title AS entity_normalized_title,
    entity.title_id AS entity_title_id,
    entity.official_url AS entity_official_url,
    entity.platform AS entity_platform,
    CASE
      WHEN g.source='nintendo_store' THEN 5
      WHEN g.source='moon_connector' THEN 4
      WHEN g.source='nintendo_connector' THEN 3
      WHEN g.source='json_import' THEN 2
      ELSE 1
    END AS source_priority
  FROM play_games g
  JOIN source_bindings b ON b.play_game_id=g.id
  JOIN game_entities entity ON entity.id=b.entity_id
), ranked_games AS (
  SELECT sg.*,
    ROW_NUMBER() OVER (
      PARTITION BY sg.identity_key
      ORDER BY sg.source_priority DESC, sg.updated_at DESC, sg.id ASC
    ) AS game_position
  FROM source_games sg
), representative_games AS (
  SELECT * FROM ranked_games WHERE game_position=1
), entity_activity AS (
  SELECT activity.entity_id,MAX(activity.occurred_at) AS last_activity_at
  FROM (
    SELECT binding.entity_id,NULLIF(store_game.last_played_at,'') AS occurred_at
    FROM source_bindings binding
    JOIN play_games store_game ON store_game.id=binding.play_game_id
    WHERE store_game.source='nintendo_store'
    UNION ALL
    SELECT binding.entity_id,report.official_date AS occurred_at
    FROM source_bindings binding
    JOIN moon_connector_report_games daily ON daily.play_game_id=binding.play_game_id
    JOIN moon_connector_reports report ON report.id=daily.report_id
    WHERE daily.total_seconds>0
    UNION ALL
    SELECT binding.entity_id,NULLIF(session.ended_at,'') AS occurred_at
    FROM source_bindings binding
    JOIN play_sessions session ON session.game_id=binding.play_game_id
  ) activity
  WHERE activity.occurred_at IS NOT NULL
  GROUP BY activity.entity_id
), effective_games AS (
  SELECT representative.*,
    CASE
      WHEN representative.source='nintendo_store' THEN representative.total_seconds
      WHEN representative.source='moon_connector' THEN COALESCE((
        SELECT SUM(daily.total_seconds)
        FROM source_bindings moon_binding
        JOIN moon_connector_report_games daily ON daily.play_game_id=moon_binding.play_game_id
        WHERE moon_binding.entity_id=representative.identity_key
      ),0)
      WHEN representative.source='nintendo_connector' THEN COALESCE((
        SELECT observation.total_seconds
        FROM source_bindings snapshot_binding
        JOIN play_observations observation ON observation.game_id=snapshot_binding.play_game_id
        JOIN play_games snapshot_game ON snapshot_game.id=snapshot_binding.play_game_id
        WHERE snapshot_binding.entity_id=representative.identity_key
          AND snapshot_game.source='nintendo_connector'
        ORDER BY observation.observed_at DESC,observation.created_at DESC LIMIT 1
      ),representative.total_seconds)
      ELSE COALESCE((
        SELECT SUM(session.duration_seconds)
        FROM source_bindings timeline_binding
        JOIN play_sessions session ON session.game_id=timeline_binding.play_game_id
        WHERE timeline_binding.entity_id=representative.identity_key
      ),0)
    END AS entity_total_seconds,
    CASE
      WHEN representative.source='nintendo_store' THEN representative.play_days
      WHEN representative.source='moon_connector' THEN COALESCE((
        SELECT COUNT(DISTINCT report.official_date)
        FROM source_bindings moon_binding
        JOIN moon_connector_report_games daily ON daily.play_game_id=moon_binding.play_game_id
        JOIN moon_connector_reports report ON report.id=daily.report_id
        WHERE moon_binding.entity_id=representative.identity_key AND daily.total_seconds>0
      ),0)
      WHEN representative.source='nintendo_connector' THEN COALESCE((
        SELECT MAX(snapshot_game.play_days)
        FROM source_bindings snapshot_binding
        JOIN play_games snapshot_game ON snapshot_game.id=snapshot_binding.play_game_id
        WHERE snapshot_binding.entity_id=representative.identity_key
          AND snapshot_game.source='nintendo_connector'
      ),representative.play_days)
      ELSE COALESCE((
        SELECT COUNT(DISTINCT substr(session.started_at,1,10))
        FROM source_bindings timeline_binding
        JOIN play_sessions session ON session.game_id=timeline_binding.play_game_id
        WHERE timeline_binding.entity_id=representative.identity_key
      ),0)
    END AS entity_play_days,
    CASE
      WHEN representative.source='nintendo_store' THEN representative.first_played_at
      WHEN representative.source='moon_connector' THEN COALESCE((
        SELECT MIN(report.official_date)
        FROM source_bindings moon_binding
        JOIN moon_connector_report_games daily ON daily.play_game_id=moon_binding.play_game_id
        JOIN moon_connector_reports report ON report.id=daily.report_id
        WHERE moon_binding.entity_id=representative.identity_key AND daily.total_seconds>0
      ),'')
      WHEN representative.source='nintendo_connector' THEN COALESCE((
        SELECT MIN(NULLIF(snapshot_game.first_played_at,''))
        FROM source_bindings snapshot_binding
        JOIN play_games snapshot_game ON snapshot_game.id=snapshot_binding.play_game_id
        WHERE snapshot_binding.entity_id=representative.identity_key
          AND snapshot_game.source='nintendo_connector'
      ),representative.first_played_at)
      ELSE COALESCE((
        SELECT MIN(session.started_at)
        FROM source_bindings timeline_binding
        JOIN play_sessions session ON session.game_id=timeline_binding.play_game_id
        WHERE timeline_binding.entity_id=representative.identity_key
      ),representative.first_played_at)
    END AS entity_first_played_at,
    CASE
      WHEN representative.source='nintendo_store' THEN representative.last_played_at
      WHEN representative.source='moon_connector' THEN COALESCE((
        SELECT MAX(report.official_date)
        FROM source_bindings moon_binding
        JOIN moon_connector_report_games daily ON daily.play_game_id=moon_binding.play_game_id
        JOIN moon_connector_reports report ON report.id=daily.report_id
        WHERE moon_binding.entity_id=representative.identity_key AND daily.total_seconds>0
      ),'')
      WHEN representative.source='nintendo_connector' THEN COALESCE((
        SELECT MAX(observation.observed_at)
        FROM source_bindings snapshot_binding
        JOIN play_observations observation ON observation.game_id=snapshot_binding.play_game_id
        JOIN play_games snapshot_game ON snapshot_game.id=snapshot_binding.play_game_id
        WHERE snapshot_binding.entity_id=representative.identity_key
          AND snapshot_game.source='nintendo_connector'
      ),representative.last_played_at)
      ELSE COALESCE((
        SELECT MAX(session.ended_at)
        FROM source_bindings timeline_binding
        JOIN play_sessions session ON session.game_id=timeline_binding.play_game_id
        WHERE timeline_binding.entity_id=representative.identity_key
      ),representative.last_played_at)
    END AS entity_last_played_at,
    COALESCE(activity.last_activity_at,'') AS entity_last_activity_at
  FROM representative_games representative
  LEFT JOIN entity_activity activity ON activity.entity_id=representative.identity_key
), effective_identity_links AS (
  SELECT l.entity_id AS identity_key,l.status,l.match_method,l.confidence,l.purchase_record_id,
    p.title AS purchase_title
  FROM game_entity_purchase_links l
  LEFT JOIN purchase_records p ON p.id=l.purchase_record_id
)`;

function sourceTimeSemantics(source: string): PlayGameSummary["timeSemantics"] {
  return source === "moon_connector"
    ? "daily_aggregate"
    : source === "nintendo_connector" || source === "nintendo_store"
      ? "snapshot_observation"
      : "play_timeline";
}
function combinedTimeSemantics(sources: string): PurchasePlaySummary["timeSemantics"] {
  const semantics = new Set(sources.split(",").filter(Boolean).map(sourceTimeSemantics));
  return semantics.size > 1 ? "mixed" : [...semantics][0] || "play_timeline";
}
function toSummary(row: Record<string, unknown>): PlayGameSummary {
  const entityId = String(row.entity_id || row.id);
  return {
    id: entityId,
    entityId,
    sourceGameId: String(row.source_game_id || row.id),
    source: row.source as PlayGameSummary["source"],
    title: String(row.title),
    titleId: String(row.title_id || ""),
    platform: String(row.platform || "Nintendo Switch"),
    officialUrl: String(row.official_url || ""),
    coverUrl: String(row.cover_url || ""),
    totalSeconds: Number(row.total_seconds),
    playDays: Number(row.play_days),
    firstPlayedAt: String(row.first_played_at),
    lastPlayedAt: String(row.last_played_at),
    timeSemantics: sourceTimeSemantics(String(row.source)),
    sessionCount: Number(row.session_count),
    link: row.link_status
      ? {
          status: row.link_status as "suggested" | "confirmed" | "rejected",
          method: row.match_method as "title_id" | "official_url" | "normalized_title" | "manual",
          confidence: Number(row.confidence),
          purchaseRecordId: row.purchase_record_id ? String(row.purchase_record_id) : null,
          purchaseTitle: row.purchase_title ? String(row.purchase_title) : null,
        }
      : null,
  };
}

function playGameCoverSql(alias: string) {
  return entityCoverSql(`${alias}.identity_key`);
}

function entityCoverSql(entityIdExpression: string) {
  return `COALESCE(
    (SELECT NULLIF(snapshot.image_url,'')
      FROM source_bindings cover_binding
      JOIN nintendo_store_game_snapshots snapshot
        ON snapshot.play_game_id=cover_binding.play_game_id
      JOIN nintendo_store_sync_snapshots sync ON sync.id=snapshot.snapshot_id
      WHERE cover_binding.entity_id=${entityIdExpression}
      ORDER BY sync.fetched_at DESC,snapshot.snapshot_id DESC LIMIT 1),
    (SELECT NULLIF(moon.image_url,'')
      FROM source_bindings cover_binding
      JOIN moon_connector_games moon ON moon.play_game_id=cover_binding.play_game_id
      WHERE cover_binding.entity_id=${entityIdExpression}
      ORDER BY moon.metadata_fetched_at DESC LIMIT 1),
    ''
  )`;
}
export async function verifyPlayDatabaseHealth() {
  const db = await openDatabase();
  try {
    assertDatabaseIdentity(db);
    const migration = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ? AND name = ?")
      .get(ns2SchemaVersion, "game_entities");
    if (!migration) throw new Error("NS2 schema migration is missing");
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
}

export async function openDatabase(options: { allowUninitialized?: boolean } = {}) {
  const [{ DatabaseSync }, { mkdir }] = await Promise.all([
    import("node:sqlite") as unknown as Promise<SqliteModule>,
    import("node:fs/promises"),
  ]);
  const file = playDatabaseFilePath();
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.function("gamenote_normalize_title", { deterministic: true }, (value) =>
    typeof value === "string" ? normalizeTitle(value) : "",
  );
  try {
    if (!options.allowUninitialized) assertDatabaseIdentity(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function assertDatabaseIdentity(db: DatabaseSync) {
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = db
      .prepare(
        "SELECT key, value FROM app_metadata WHERE key IN ('database_identity','schema_version')",
      )
      .all() as Array<{ key: string; value: string }>;
  } catch {
    throw new Error("NS2 database marker is missing");
  }
  const metadata = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (metadata.database_identity !== ns2DatabaseIdentity)
    throw new Error("NS2 database identity is invalid");
  if (metadata.schema_version !== String(ns2SchemaVersion))
    throw new Error("NS2 schema version is invalid");
}

function assertCompatibleNs2Database(db: DatabaseSync) {
  let identity: unknown;
  let version: unknown;
  try {
    identity = db.prepare("SELECT value FROM app_metadata WHERE key = 'database_identity'").get();
    version = db.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get();
  } catch {
    throw new Error("existing database has no NS2 identity marker");
  }
  const identityValue = (identity as { value?: unknown } | undefined)?.value;
  const versionNumber = Number((version as { value?: unknown } | undefined)?.value);
  if (
    identityValue !== ns2DatabaseIdentity ||
    !Number.isInteger(versionNumber) ||
    versionNumber < 1 ||
    versionNumber > ns2SchemaVersion
  )
    throw new Error("existing database has an incompatible NS2 identity marker/version");
}

function findBatchByIdempotencyKey(db: DatabaseSync, idempotencyKey: string) {
  return db
    .prepare(
      "SELECT id, payload_sha256, status, preview_json FROM import_batches WHERE idempotency_key = ?",
    )
    .get(idempotencyKey) as BatchRow | undefined;
}

function replayPreview(existing: BatchRow, sha256: string) {
  if (existing.payload_sha256 !== sha256) throw new ImportConflictError();
  return {
    batchId: existing.id,
    status: existing.status,
    replayed: true,
    preview: JSON.parse(existing.preview_json) as ImportPreview,
  };
}

function rollback(db: DatabaseSync) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The original error is more useful when SQLite has already ended the transaction.
  }
}

function isUniqueConstraint(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      ("code" in error &&
        String((error as Error & { code?: unknown }).code).includes("CONSTRAINT")))
  );
}

type BatchRow = { id: string; payload_sha256: string; status: string; preview_json: string };
