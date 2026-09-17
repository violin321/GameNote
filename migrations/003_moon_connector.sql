-- The migration runner widens play_games.source with foreign keys disabled
-- outside its transaction; all child rows and extension columns are retained.
-- These names deliberately do not collide with legacy deployment-specific moon_* tables.
CREATE TABLE IF NOT EXISTS moon_connector_accounts (
  account_scope TEXT PRIMARY KEY NOT NULL,
  last_fetched_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  last_imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moon_connector_devices (
  account_scope TEXT NOT NULL REFERENCES moon_connector_accounts(account_scope),
  device_id TEXT NOT NULL,
  PRIMARY KEY(account_scope, device_id)
);
CREATE TABLE IF NOT EXISTS moon_connector_reports (
  id TEXT PRIMARY KEY NOT NULL,
  account_scope TEXT NOT NULL,
  device_id TEXT NOT NULL,
  official_date TEXT NOT NULL CHECK(length(official_date)=10),
  time_zone_offset_seconds INTEGER NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('CALCULATING','ACHIEVED','UNACHIEVED','UNKNOWN')),
  report_updated_at TEXT,
  total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
  fetched_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  UNIQUE(account_scope, device_id, official_date),
  FOREIGN KEY(account_scope, device_id) REFERENCES moon_connector_devices(account_scope, device_id)
);
CREATE INDEX IF NOT EXISTS idx_moon_connector_reports_date ON moon_connector_reports(official_date DESC);
CREATE TABLE IF NOT EXISTS moon_connector_games (
  account_scope TEXT NOT NULL,
  device_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  play_game_id TEXT NOT NULL UNIQUE REFERENCES play_games(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL DEFAULT '',
  metadata_fetched_at TEXT NOT NULL,
  PRIMARY KEY(account_scope, device_id, external_id),
  FOREIGN KEY(account_scope, device_id) REFERENCES moon_connector_devices(account_scope, device_id)
);
CREATE TABLE IF NOT EXISTS moon_connector_report_games (
  report_id TEXT NOT NULL REFERENCES moon_connector_reports(id) ON DELETE CASCADE,
  play_game_id TEXT NOT NULL REFERENCES moon_connector_games(play_game_id) ON DELETE CASCADE,
  total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
  PRIMARY KEY(report_id, play_game_id)
);
CREATE INDEX IF NOT EXISTS idx_moon_connector_report_games_game ON moon_connector_report_games(play_game_id);
UPDATE app_metadata SET value = '3' WHERE key = 'schema_version';
