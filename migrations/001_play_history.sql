PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_metadata(key, value) VALUES('database_identity', 'gamenote-ns2');
INSERT OR IGNORE INTO app_metadata(key, value) VALUES('schema_version', '1');

-- Baseline GameNote persists purchase records as one JSON document. Keeping the
-- table in this independent database makes the copied purchase export visible
-- without sharing or attaching the production database.
CREATE TABLE IF NOT EXISTS ledger_documents (
  id TEXT PRIMARY KEY NOT NULL,
  records TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS app_cache (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_records (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  title_id TEXT,
  official_url TEXT,
  normalized_title TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_records_title_id ON purchase_records(title_id);
CREATE INDEX IF NOT EXISTS idx_purchase_records_official_url ON purchase_records(official_url);
CREATE INDEX IF NOT EXISTS idx_purchase_records_normalized_title ON purchase_records(normalized_title);

CREATE TABLE IF NOT EXISTS play_games (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('json_import','manual','nintendo_connector')),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  normalized_title TEXT NOT NULL,
  title_id TEXT,
  official_url TEXT,
  platform TEXT NOT NULL DEFAULT 'Nintendo Switch 2',
  first_played_at TEXT NOT NULL,
  last_played_at TEXT NOT NULL,
  total_seconds INTEGER NOT NULL DEFAULT 0 CHECK(total_seconds >= 0),
  play_days INTEGER NOT NULL DEFAULT 0 CHECK(play_days >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_play_games_recent ON play_games(last_played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_games_title_id ON play_games(title_id);
CREATE INDEX IF NOT EXISTS idx_play_games_normalized_title ON play_games(normalized_title);

CREATE TABLE IF NOT EXISTS play_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES play_games(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('json_import','manual','nintendo_connector')),
  external_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 0 AND 31536000),
  imported_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_play_sessions_game_started ON play_sessions(game_id, started_at DESC);

CREATE TABLE IF NOT EXISTS play_observations (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL REFERENCES play_games(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
  source TEXT NOT NULL,
  import_batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS play_purchase_links (
  id TEXT PRIMARY KEY NOT NULL,
  play_game_id TEXT NOT NULL UNIQUE REFERENCES play_games(id) ON DELETE CASCADE,
  purchase_record_id TEXT REFERENCES purchase_records(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected')),
  match_method TEXT NOT NULL CHECK(match_method IN ('title_id','official_url','normalized_title','manual')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_purchase_links_status ON play_purchase_links(status);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('previewed','committed','failed')),
  item_count INTEGER NOT NULL CHECK(item_count >= 0),
  error_count INTEGER NOT NULL CHECK(error_count >= 0),
  preview_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS import_items (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL CHECK(item_index >= 0),
  external_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('valid','invalid','inserted','duplicate','failed')),
  error TEXT,
  canonical_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, item_index)
);
