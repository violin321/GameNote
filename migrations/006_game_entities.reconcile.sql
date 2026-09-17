-- Idempotent shape/data repair for installations that applied an earlier V6
-- draft before entity aliases and field-level URL selection were introduced.
CREATE TABLE IF NOT EXISTS game_entity_aliases (
  alias_id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES game_entities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(alias_id!=entity_id)
);
CREATE INDEX IF NOT EXISTS idx_game_entity_aliases_entity
  ON game_entity_aliases(entity_id);

-- Earlier V6 drafts allowed an ambiguous public ID to exist as both a direct
-- entity and an alias. Direct entities already win resolution, so keep them and
-- discard the conflicting alias before installing the permanent guards.
DELETE FROM game_entity_aliases
WHERE alias_id IN (SELECT id FROM game_entities);

CREATE TRIGGER IF NOT EXISTS trg_game_entities_id_immutable
BEFORE UPDATE OF id ON game_entities
WHEN NEW.id!=OLD.id
BEGIN
  SELECT RAISE(ABORT,'game entity id is immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_game_entities_id_not_alias_insert
BEFORE INSERT ON game_entities
WHEN EXISTS(SELECT 1 FROM game_entity_aliases WHERE alias_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT,'game entity id conflicts with alias');
END;
CREATE TRIGGER IF NOT EXISTS trg_game_entities_id_not_alias_update
BEFORE UPDATE OF id ON game_entities
WHEN EXISTS(SELECT 1 FROM game_entity_aliases WHERE alias_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT,'game entity id conflicts with alias');
END;
CREATE TRIGGER IF NOT EXISTS trg_game_entity_alias_not_entity_insert
BEFORE INSERT ON game_entity_aliases
WHEN EXISTS(SELECT 1 FROM game_entities WHERE id=NEW.alias_id)
BEGIN
  SELECT RAISE(ABORT,'game entity alias conflicts with entity');
END;
CREATE TRIGGER IF NOT EXISTS trg_game_entity_alias_not_entity_update
BEFORE UPDATE OF alias_id ON game_entity_aliases
WHEN EXISTS(SELECT 1 FROM game_entities WHERE id=NEW.alias_id)
BEGIN
  SELECT RAISE(ABORT,'game entity alias conflicts with entity');
END;

UPDATE game_entities
SET official_url=COALESCE(
  (SELECT NULLIF(TRIM(url_game.official_url),'')
   FROM source_bindings url_binding
   JOIN play_games url_game ON url_game.id=url_binding.play_game_id
   WHERE url_binding.entity_id=game_entities.id
     AND length(trim(COALESCE(url_game.official_url,'')))>0
   ORDER BY CASE url_game.source
     WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
     WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
     url_game.updated_at DESC,url_game.id ASC LIMIT 1),
  official_url
);

-- Canonical display metadata may come from a higher-priority weak binding, but
-- a strong entity's title_id must come from a binding that proves that exact
-- platform-scoped strong key.
UPDATE game_entities
SET title_id=(
  SELECT game.title_id
  FROM source_bindings binding
  JOIN play_games game ON game.id=binding.play_game_id
  WHERE binding.entity_id=game_entities.id
    AND length(trim(COALESCE(game.title_id,'')))>0
    AND 'title-id:' ||
      CASE WHEN lower(game.platform) LIKE '%playstation%' THEN 'playstation'
        ELSE 'nintendo' END ||
      ':' || lower(trim(game.title_id))=game_entities.strong_key
  ORDER BY CASE game.source
    WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
    WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
    game.updated_at DESC,game.id ASC LIMIT 1
)
WHERE strong_key IS NOT NULL
  AND EXISTS(
    SELECT 1
    FROM source_bindings binding
    JOIN play_games game ON game.id=binding.play_game_id
    WHERE binding.entity_id=game_entities.id
      AND length(trim(COALESCE(game.title_id,'')))>0
      AND 'title-id:' ||
        CASE WHEN lower(game.platform) LIKE '%playstation%' THEN 'playstation'
          ELSE 'nintendo' END ||
        ':' || lower(trim(game.title_id))=game_entities.strong_key
  );
UPDATE game_entities SET title_id=NULL WHERE strong_key IS NULL;
