export type PlayStatement = {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  all(...values: unknown[]): unknown[];
};

export type PlayDatabase = {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): PlayStatement;
};

export function ensurePlayHistorySchema(db: PlayDatabase) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS play_games (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT 'default',
      external_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      normalized_title TEXT NOT NULL,
      title_id TEXT NOT NULL DEFAULT '',
      official_url TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'Nintendo Switch',
      first_played_at TEXT NOT NULL,
      last_played_at TEXT NOT NULL,
      total_seconds INTEGER NOT NULL DEFAULT 0 CHECK(total_seconds >= 0),
      play_days INTEGER NOT NULL DEFAULT 0 CHECK(play_days >= 0),
      time_semantics TEXT NOT NULL DEFAULT 'play_timeline'
        CHECK(time_semantics IN ('play_timeline','daily_aggregate','snapshot_observation')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_play_games_recent
      ON play_games(last_played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_play_games_normalized_title
      ON play_games(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_play_games_title_id
      ON play_games(title_id);

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL DEFAULT 'default',
      payload_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('previewed', 'committed', 'failed')),
      item_count INTEGER NOT NULL CHECK(item_count >= 0),
      error_count INTEGER NOT NULL CHECK(error_count >= 0),
      preview_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      committed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS play_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL REFERENCES play_games(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT 'default',
      external_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      played_date TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 0 AND 31536000),
      time_semantics TEXT NOT NULL DEFAULT 'play_timeline'
        CHECK(time_semantics IN ('play_timeline','daily_aggregate')),
      report_status TEXT NOT NULL DEFAULT ''
        CHECK(report_status IN ('','CALCULATING','ACHIEVED','UNACHIEVED','UNKNOWN')),
      imported_at TEXT NOT NULL,
      UNIQUE(source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_play_sessions_game_started
      ON play_sessions(game_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_started
      ON play_sessions(started_at DESC);

    CREATE TABLE IF NOT EXISTS play_observations (
      id TEXT PRIMARY KEY NOT NULL,
      game_id TEXT NOT NULL REFERENCES play_games(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL DEFAULT 'default',
      external_id TEXT NOT NULL,
      source_record_id TEXT NOT NULL DEFAULT '',
      observed_date TEXT NOT NULL CHECK(length(observed_date) = 10),
      observed_at TEXT NOT NULL,
      total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
      play_days INTEGER NOT NULL DEFAULT 0 CHECK(play_days >= 0),
      first_played_at TEXT NOT NULL DEFAULT '',
      last_played_at TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      time_semantics TEXT NOT NULL
        CHECK(time_semantics IN ('daily_aggregate','snapshot_observation')),
      report_status TEXT NOT NULL DEFAULT ''
        CHECK(report_status IN ('','CALCULATING','ACHIEVED','UNACHIEVED','UNKNOWN')),
      imported_at TEXT NOT NULL,
      UNIQUE(source, source_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_play_observations_game_date
      ON play_observations(game_id, observed_date DESC);
    CREATE INDEX IF NOT EXISTS idx_play_observations_recent
      ON play_observations(time_semantics, observed_date DESC);
    CREATE INDEX IF NOT EXISTS idx_play_observations_source_record
      ON play_observations(source, source_id, source_record_id);

    CREATE TABLE IF NOT EXISTS play_purchase_links (
      id TEXT PRIMARY KEY NOT NULL,
      play_game_id TEXT NOT NULL UNIQUE REFERENCES play_games(id) ON DELETE CASCADE,
      purchase_record_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
      match_method TEXT NOT NULL CHECK(match_method IN ('official_url', 'normalized_title', 'manual')),
      confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      decided_at TEXT,
      decided_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_play_purchase_links_status
      ON play_purchase_links(status);
    CREATE INDEX IF NOT EXISTS idx_play_purchase_links_purchase
      ON play_purchase_links(purchase_record_id);

    CREATE TABLE IF NOT EXISTS import_items (
      id TEXT PRIMARY KEY NOT NULL,
      batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      item_index INTEGER NOT NULL CHECK(item_index >= 0),
      external_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('valid', 'invalid', 'inserted', 'duplicate', 'failed')),
      error TEXT,
      canonical_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(batch_id, item_index)
    );

    CREATE INDEX IF NOT EXISTS idx_import_items_batch
      ON import_items(batch_id, item_index);

  `);

  ensureColumn(db, "play_games", "source_id", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "play_games", "time_semantics", "TEXT NOT NULL DEFAULT 'play_timeline'");
  ensureColumn(db, "import_batches", "source_id", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "play_sessions", "source_id", "TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "play_sessions", "played_date", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "play_sessions", "time_semantics", "TEXT NOT NULL DEFAULT 'play_timeline'");
  ensureColumn(db, "play_sessions", "report_status", "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    UPDATE play_games SET source_id = 'default' WHERE source_id = '';
    UPDATE import_batches SET source_id = 'default' WHERE source_id = '';
    UPDATE play_sessions SET source_id = 'default' WHERE source_id = '';
    UPDATE play_sessions
      SET played_date = substr(started_at, 1, 10)
      WHERE played_date = '';

    CREATE INDEX IF NOT EXISTS idx_play_games_source_identity
      ON play_games(source, source_id, external_id);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_source_identity
      ON play_sessions(source, source_id, external_id);
    CREATE INDEX IF NOT EXISTS idx_play_sessions_played_date
      ON play_sessions(played_date DESC);
  `);
}

function ensureColumn(db: PlayDatabase, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
