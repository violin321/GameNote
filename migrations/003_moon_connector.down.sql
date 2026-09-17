-- Only on an isolated copy, with the matching V2 application rollback.
-- Refuse marker-only downgrade after any Moon import: old readers cannot safely
-- interpret daily aggregates. Restore the pre-upgrade DB backup in that case.
-- Preserve the widened CHECK and additive tables when empty (non-destructive).
BEGIN IMMEDIATE;
CREATE TEMP TABLE moon_rollback_guard (safe INTEGER CHECK(safe=1));
INSERT INTO moon_rollback_guard(safe)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM moon_connector_accounts)
  AND NOT EXISTS(SELECT 1 FROM play_games WHERE source='moon_connector') THEN 1 ELSE 0 END;
DROP TABLE moon_rollback_guard;
DELETE FROM schema_migrations WHERE version = 3;
UPDATE app_metadata SET value = '2' WHERE key = 'schema_version';
COMMIT;
