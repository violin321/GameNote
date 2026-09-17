-- Retain Nintendo Store's rolling daily details and an immutable copy of each
-- successful cumulative snapshot. Missing days/titles in later responses are
-- not deletions: the upstream history is a rolling window and may shrink.
CREATE TABLE IF NOT EXISTS nintendo_store_sync_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  fetched_at TEXT NOT NULL,
  upstream_updated_at TEXT,
  authentication TEXT NOT NULL DEFAULT ''
    CHECK(authentication IN ('','access_token','id_token')),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  source_title_count INTEGER NOT NULL CHECK(source_title_count >= 0),
  imported_title_count INTEGER NOT NULL CHECK(imported_title_count >= 0),
  skipped_title_count INTEGER NOT NULL CHECK(skipped_title_count >= 0),
  imported_daily_count INTEGER NOT NULL CHECK(imported_daily_count >= 0),
  skipped_daily_count INTEGER NOT NULL CHECK(skipped_daily_count >= 0),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nintendo_store_sync_snapshots_fetched
  ON nintendo_store_sync_snapshots(fetched_at DESC, id);

CREATE TABLE IF NOT EXISTS nintendo_store_game_snapshots (
  snapshot_id TEXT NOT NULL REFERENCES nintendo_store_sync_snapshots(id) ON DELETE CASCADE,
  play_game_id TEXT REFERENCES play_games(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  title_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  platform TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  first_played_at TEXT NOT NULL,
  last_played_at TEXT NOT NULL,
  total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
  play_days INTEGER NOT NULL CHECK(play_days >= 0),
  PRIMARY KEY(snapshot_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_nintendo_store_game_snapshots_identity
  ON nintendo_store_game_snapshots(external_id, snapshot_id);
CREATE INDEX IF NOT EXISTS idx_nintendo_store_game_snapshots_game
  ON nintendo_store_game_snapshots(play_game_id, snapshot_id);

CREATE TABLE IF NOT EXISTS nintendo_store_daily_history (
  official_date TEXT NOT NULL CHECK(length(official_date)=10),
  external_id TEXT NOT NULL,
  play_game_id TEXT REFERENCES play_games(id) ON DELETE SET NULL,
  title_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  platform TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  total_seconds INTEGER NOT NULL CHECK(total_seconds >= 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_snapshot_id TEXT NOT NULL REFERENCES nintendo_store_sync_snapshots(id),
  PRIMARY KEY(official_date, external_id)
);
CREATE INDEX IF NOT EXISTS idx_nintendo_store_daily_history_recent
  ON nintendo_store_daily_history(official_date DESC, external_id);
CREATE INDEX IF NOT EXISTS idx_nintendo_store_daily_history_game
  ON nintendo_store_daily_history(play_game_id, official_date DESC);

UPDATE app_metadata SET value='5' WHERE key='schema_version';
