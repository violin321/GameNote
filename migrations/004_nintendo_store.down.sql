-- Roll back the Store migration marker only when no Store snapshot was imported.
BEGIN IMMEDIATE;
CREATE TEMP TABLE store_rollback_guard (safe INTEGER CHECK(safe=1));
INSERT INTO store_rollback_guard(safe)
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM play_games WHERE source='nintendo_store') AND
  NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version > 4)
THEN 1 ELSE 0 END;
DROP TABLE store_rollback_guard;
DELETE FROM schema_migrations WHERE version = 4;
UPDATE app_metadata SET value = '3' WHERE key = 'schema_version';
COMMIT;
