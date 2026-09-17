-- Run only against an isolated copy while rolling application code back to V1.
-- V1 ignores the additional projection columns, so rollback deliberately keeps
-- the V2 table shape and data. Downgrading only the migration markers makes a
-- second down execution a safe no-op and preserves tombstones and foreign keys.
BEGIN IMMEDIATE;
-- A newer schema must be rolled back first. In particular V3 may contain Moon
-- aggregates that V1/V2 cannot safely interpret as sessions.
CREATE TEMP TABLE projection_rollback_guard (safe INTEGER CHECK(safe=1));
INSERT INTO projection_rollback_guard(safe)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version>2) THEN 1 ELSE 0 END;
DROP TABLE projection_rollback_guard;
DELETE FROM schema_migrations WHERE version = 2;
UPDATE app_metadata SET value = '1' WHERE key = 'schema_version';
COMMIT;
