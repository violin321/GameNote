-- V6 is additive and its collection decisions are projected to the V5 tables.
-- Preserve the entity tables and data so downgrade/re-up is non-destructive.
BEGIN IMMEDIATE;
CREATE TEMP TABLE game_entities_rollback_guard (safe INTEGER CHECK(safe=1));
INSERT INTO game_entities_rollback_guard(safe)
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version>6)
  -- V5 can represent only one purchase relationship per source row. Refuse a
  -- marker-only downgrade when V6 contains multiple acquisitions for an entity.
  AND NOT EXISTS(
    SELECT entity_id FROM game_entity_acquisitions
    GROUP BY entity_id HAVING COUNT(*)>1
  )
  -- A single acquisition is safe only when it is the confirmed primary choice
  -- that V5 can see. This also rejects acquisitions on an orphan entity.
  AND NOT EXISTS(
    SELECT 1 FROM game_entity_acquisitions acquisition
    LEFT JOIN game_entity_purchase_links entity_link
      ON entity_link.entity_id=acquisition.entity_id
    WHERE entity_link.id IS NULL
      OR entity_link.status!='confirmed'
      OR entity_link.purchase_record_id IS NOT acquisition.purchase_record_id
  )
  -- Every primary entity decision must already be visible in the V5 projection.
  AND NOT EXISTS(
    SELECT 1 FROM game_entity_purchase_links entity_link
    WHERE NOT EXISTS(
      SELECT 1 FROM source_bindings binding
      WHERE binding.entity_id=entity_link.entity_id
    )
    OR EXISTS(
      SELECT 1 FROM source_bindings binding
      LEFT JOIN play_purchase_links legacy ON legacy.play_game_id=binding.play_game_id
      WHERE binding.entity_id=entity_link.entity_id
        AND (
          legacy.id IS NULL
          OR legacy.status!=entity_link.status
          OR legacy.match_method!=entity_link.match_method
          OR COALESCE(legacy.purchase_record_id,'')!=COALESCE(entity_link.purchase_record_id,'')
          OR legacy.confidence!=entity_link.confidence
          OR COALESCE(legacy.decided_at,'')!=COALESCE(entity_link.decided_at,'')
          OR COALESCE(legacy.decided_by,'')!=COALESCE(entity_link.decided_by,'')
        )
    )
  )
THEN 1 ELSE 0 END;
DROP TABLE game_entities_rollback_guard;
DELETE FROM schema_migrations WHERE version=6;
UPDATE app_metadata SET value='5' WHERE key='schema_version';
COMMIT;
