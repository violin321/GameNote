-- Audit/history is user data. Refuse a marker-only downgrade after the new
-- tables have received a successful Store synchronization. Empty additive
-- tables are preserved so repeated down/up remains non-destructive.
BEGIN IMMEDIATE;
CREATE TEMP TABLE store_history_rollback_guard (safe INTEGER CHECK(safe=1));
INSERT INTO store_history_rollback_guard(safe)
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM nintendo_store_sync_snapshots) AND
  NOT EXISTS(SELECT 1 FROM nintendo_store_daily_history)
THEN 1 ELSE 0 END;
DROP TABLE store_history_rollback_guard;
DELETE FROM schema_migrations WHERE version=5;
UPDATE app_metadata SET value='4' WHERE key='schema_version';
COMMIT;
