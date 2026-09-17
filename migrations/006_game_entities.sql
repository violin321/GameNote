-- V6 introduces a stable logical game above source-specific play_games rows.
-- play_games remains the compatibility/time-series write model; every row is
-- mapped through source_bindings. Only a platform-scoped title_id is strong
-- enough for automatic merging. Equal normalized titles remain separate.

CREATE TABLE IF NOT EXISTS game_entities (
  id TEXT PRIMARY KEY NOT NULL,
  strong_key TEXT UNIQUE,
  canonical_title TEXT NOT NULL CHECK(length(canonical_title) BETWEEN 1 AND 200),
  normalized_title TEXT NOT NULL,
  title_id TEXT,
  official_url TEXT,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_entities_title_id
  ON game_entities(title_id);
CREATE INDEX IF NOT EXISTS idx_game_entities_normalized_title
  ON game_entities(normalized_title);

-- Public entity IDs must keep resolving after two provisional identities are
-- merged by a later strong title_id. Aliases always point directly at the
-- surviving entity; merge code rewrites older aliases before deleting a row.
CREATE TABLE IF NOT EXISTS game_entity_aliases (
  alias_id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES game_entities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(alias_id!=entity_id)
);
CREATE INDEX IF NOT EXISTS idx_game_entity_aliases_entity
  ON game_entity_aliases(entity_id);

-- A public ID has exactly one meaning: it is either a live entity ID or an
-- alias, never both. Older V6 drafts did not enforce that cross-table rule, so
-- prefer the live entity before installing the guards.
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

CREATE TABLE IF NOT EXISTS source_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES game_entities(id) ON DELETE CASCADE,
  play_game_id TEXT NOT NULL UNIQUE REFERENCES play_games(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_source_bindings_entity
  ON source_bindings(entity_id, source);

-- ledger_documents stays the canonical, backwards-compatible collection
-- document. This table is only the entity-level relationship to its existing
-- purchase_records projection, so deleting/tombstoning a ledger item never
-- deletes play history.
CREATE TABLE IF NOT EXISTS game_entity_purchase_links (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL UNIQUE REFERENCES game_entities(id) ON DELETE CASCADE,
  purchase_record_id TEXT REFERENCES purchase_records(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('suggested','confirmed','rejected')),
  match_method TEXT NOT NULL CHECK(match_method IN ('title_id','official_url','normalized_title','manual')),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_entity_purchase_links_status
  ON game_entity_purchase_links(status);
CREATE INDEX IF NOT EXISTS idx_game_entity_purchase_links_purchase
  ON game_entity_purchase_links(purchase_record_id, status);

-- Preserve every confirmed collection/acquisition relationship even though the
-- compatibility UI still exposes one primary decision per entity.
CREATE TABLE IF NOT EXISTS game_entity_acquisitions (
  id TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL REFERENCES game_entities(id) ON DELETE CASCADE,
  purchase_record_id TEXT NOT NULL REFERENCES purchase_records(id) ON DELETE CASCADE,
  linked_at TEXT NOT NULL,
  linked_by TEXT,
  UNIQUE(entity_id, purchase_record_id)
);
CREATE INDEX IF NOT EXISTS idx_game_entity_acquisitions_purchase
  ON game_entity_acquisitions(purchase_record_id, entity_id);

-- The marker-only downgrade retains V6 tables and bindings. Build the complete
-- re-up plan before changing any identity so a V5 title_id correction relabels
-- a single logical entity instead of replacing its public ID with a key-derived
-- ID. New migration-created IDs are opaque and share no derived-key namespace.
DROP TABLE IF EXISTS temp._v6_current_bindings;
CREATE TEMP TABLE _v6_current_bindings (
  play_game_id TEXT PRIMARY KEY NOT NULL,
  current_entity_id TEXT,
  desired_strong_key TEXT,
  source_rank INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO _v6_current_bindings(
  play_game_id,current_entity_id,desired_strong_key,source_rank,updated_at
)
SELECT
  g.id,
  bound_entity.id,
  CASE WHEN length(trim(COALESCE(g.title_id,'')))>0 THEN
    'title-id:' ||
      CASE WHEN lower(g.platform) LIKE '%playstation%' THEN 'playstation' ELSE 'nintendo' END ||
      ':' || lower(trim(g.title_id))
  ELSE NULL END,
  CASE g.source
    WHEN 'nintendo_store' THEN 5
    WHEN 'moon_connector' THEN 4
    WHEN 'nintendo_connector' THEN 3
    WHEN 'json_import' THEN 2
    ELSE 1
  END,
  g.updated_at
FROM play_games g
LEFT JOIN source_bindings b ON b.play_game_id=g.id
LEFT JOIN game_entities bound_entity ON bound_entity.id=b.entity_id
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6);

-- The retained V6 decision is the baseline that produced each V5 projection.
-- Semantic differences in one V5 row are therefore reliable evidence of an
-- explicit V5 edit; timestamp-only rewrites are still the unchanged projection.
DROP TABLE IF EXISTS temp._v6_legacy_link_state;
CREATE TEMP TABLE _v6_legacy_link_state (
  play_game_id TEXT PRIMARY KEY NOT NULL,
  current_entity_id TEXT NOT NULL,
  has_legacy_link INTEGER NOT NULL,
  legacy_changed INTEGER NOT NULL
);
INSERT INTO _v6_legacy_link_state(
  play_game_id,current_entity_id,has_legacy_link,legacy_changed
)
SELECT
  current.play_game_id,
  current.current_entity_id,
  CASE WHEN legacy.id IS NULL THEN 0 ELSE 1 END,
  CASE
    WHEN entity_link.id IS NULL AND legacy.id IS NULL THEN 0
    WHEN entity_link.id IS NULL OR legacy.id IS NULL THEN 1
    WHEN legacy.purchase_record_id IS NOT entity_link.purchase_record_id
      OR legacy.status!=entity_link.status
      OR legacy.match_method!=entity_link.match_method
      OR legacy.confidence!=entity_link.confidence
      OR legacy.decided_at IS NOT entity_link.decided_at
      OR legacy.decided_by IS NOT entity_link.decided_by
      THEN 1
    ELSE 0
  END
FROM _v6_current_bindings current
LEFT JOIN game_entity_purchase_links entity_link
  ON entity_link.entity_id=current.current_entity_id
LEFT JOIN play_purchase_links legacy
  ON legacy.play_game_id=current.play_game_id
WHERE current.current_entity_id IS NOT NULL;

-- A marker-only V6 downgrade leaves these additive tables in place. During a
-- real V5 -> V6 re-application, however, rebuild entity decisions from the V5
-- projection after preserving the baseline comparison above. A direct replay
-- while V6 is still registered remains non-destructive.
DELETE FROM game_entity_acquisitions
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6);
DELETE FROM game_entity_purchase_links
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6);

-- A stale binding can remain only if a V5 writer deleted a play row with FK
-- enforcement disabled. It must not keep an otherwise deleted entity alive.
DELETE FROM source_bindings
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)
  AND NOT EXISTS(
    SELECT 1 FROM play_games game WHERE game.id=source_bindings.play_game_id
  );

DROP TABLE IF EXISTS temp._v6_entity_claims;
CREATE TEMP TABLE _v6_entity_claims (
  entity_id TEXT PRIMARY KEY NOT NULL,
  original_strong_key TEXT,
  desired_strong_key TEXT
);
WITH ranked_claims AS (
  SELECT
    current.current_entity_id AS entity_id,
    entity.strong_key AS original_strong_key,
    current.desired_strong_key,
    ROW_NUMBER() OVER (
      PARTITION BY current.current_entity_id
      ORDER BY
        CASE WHEN entity.strong_key IS NOT NULL
          AND current.desired_strong_key=entity.strong_key THEN 1 ELSE 0 END DESC,
        CASE WHEN current.desired_strong_key IS NOT NULL THEN 1 ELSE 0 END DESC,
        current.source_rank DESC,
        current.updated_at DESC,
        current.play_game_id ASC
    ) AS position
  FROM _v6_current_bindings current
  JOIN game_entities entity ON entity.id=current.current_entity_id
  WHERE current.current_entity_id IS NOT NULL
)
INSERT INTO _v6_entity_claims(entity_id,original_strong_key,desired_strong_key)
SELECT entity_id,original_strong_key,desired_strong_key
FROM ranked_claims
WHERE position=1;

-- When several pre-existing entities now claim one strong key, the entity that
-- already owned that key is the target. Otherwise the oldest claimant keeps
-- its public ID. Every entity can claim at most one key, so split bindings do
-- not accidentally make one public ID represent two games.
DROP TABLE IF EXISTS temp._v6_strong_survivors;
CREATE TEMP TABLE _v6_strong_survivors (
  strong_key TEXT PRIMARY KEY NOT NULL,
  entity_id TEXT NOT NULL UNIQUE
);
WITH ranked_survivors AS (
  SELECT
    claim.desired_strong_key AS strong_key,
    claim.entity_id,
    ROW_NUMBER() OVER (
      PARTITION BY claim.desired_strong_key
      ORDER BY
        CASE WHEN claim.original_strong_key=claim.desired_strong_key THEN 1 ELSE 0 END DESC,
        entity.created_at ASC,
        claim.entity_id ASC
    ) AS position
  FROM _v6_entity_claims claim
  JOIN game_entities entity ON entity.id=claim.entity_id
  WHERE claim.desired_strong_key IS NOT NULL
)
INSERT INTO _v6_strong_survivors(strong_key,entity_id)
SELECT strong_key,entity_id FROM ranked_survivors WHERE position=1;

-- Clear keys as a set first so legitimate A <-> B corrections do not hit the
-- unique index halfway through the swap. Entity IDs themselves are immutable.
UPDATE game_entities SET strong_key=NULL
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6);
UPDATE game_entities
SET strong_key=(
  SELECT survivor.strong_key FROM _v6_strong_survivors survivor
  WHERE survivor.entity_id=game_entities.id
)
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)
  AND id IN (SELECT entity_id FROM _v6_strong_survivors);

DROP TABLE IF EXISTS temp._v6_strong_games;
CREATE TEMP TABLE _v6_strong_games (
  strong_key TEXT PRIMARY KEY NOT NULL,
  canonical_title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  title_id TEXT NOT NULL,
  official_url TEXT,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
WITH ranked_strong_games AS (
  SELECT
    current.desired_strong_key AS strong_key,
    game.*,
    ROW_NUMBER() OVER (
      PARTITION BY current.desired_strong_key
      ORDER BY current.source_rank DESC,game.updated_at DESC,game.id ASC
    ) AS position
  FROM _v6_current_bindings current
  JOIN play_games game ON game.id=current.play_game_id
  WHERE current.desired_strong_key IS NOT NULL
)
INSERT INTO _v6_strong_games(
  strong_key,canonical_title,normalized_title,title_id,official_url,
  platform,created_at,updated_at
)
SELECT
  ranked.strong_key,
  ranked.title,
  ranked.normalized_title,
  ranked.title_id,
  (SELECT NULLIF(TRIM(url_game.official_url),'')
   FROM _v6_current_bindings url_current
   JOIN play_games url_game ON url_game.id=url_current.play_game_id
   WHERE url_current.desired_strong_key=ranked.strong_key
     AND length(trim(COALESCE(url_game.official_url,'')))>0
   ORDER BY url_current.source_rank DESC,url_game.updated_at DESC,url_game.id ASC LIMIT 1),
  ranked.platform,
  ranked.created_at,
  ranked.updated_at
FROM ranked_strong_games ranked
WHERE ranked.position=1;

INSERT INTO game_entities(
  id,strong_key,canonical_title,normalized_title,title_id,official_url,platform,created_at,updated_at
)
SELECT
  'game-entity:opaque:' || lower(hex(randomblob(16))),
  game.strong_key,
  game.canonical_title,
  game.normalized_title,
  game.title_id,
  game.official_url,
  game.platform,
  game.created_at,
  game.updated_at
FROM _v6_strong_games game
WHERE NOT EXISTS(
  SELECT 1 FROM _v6_strong_survivors survivor WHERE survivor.strong_key=game.strong_key
);

INSERT INTO _v6_strong_survivors(strong_key,entity_id)
SELECT game.strong_key,entity.id
FROM _v6_strong_games game
JOIN game_entities entity ON entity.strong_key=game.strong_key
WHERE true
ON CONFLICT(strong_key) DO NOTHING;

DROP TABLE IF EXISTS temp._v6_binding_targets;
CREATE TEMP TABLE _v6_binding_targets (
  play_game_id TEXT PRIMARY KEY NOT NULL,
  target_entity_id TEXT NOT NULL
);
INSERT INTO _v6_binding_targets(play_game_id,target_entity_id)
SELECT
  current.play_game_id,
  CASE
    WHEN current.desired_strong_key IS NOT NULL THEN (
      SELECT survivor.entity_id FROM _v6_strong_survivors survivor
      WHERE survivor.strong_key=current.desired_strong_key
    )
    WHEN current.current_entity_id IS NOT NULL THEN COALESCE((
      SELECT survivor.entity_id
      FROM _v6_entity_claims claim
      JOIN _v6_strong_survivors survivor
        ON survivor.strong_key=claim.desired_strong_key
      WHERE claim.entity_id=current.current_entity_id
    ),current.current_entity_id)
    ELSE 'game-entity:opaque:' || lower(hex(randomblob(16)))
  END
FROM _v6_current_bindings current;

DROP TABLE IF EXISTS temp._v6_entity_claim_targets;
CREATE TEMP TABLE _v6_entity_claim_targets (
  entity_id TEXT PRIMARY KEY NOT NULL,
  target_entity_id TEXT NOT NULL
);
INSERT INTO _v6_entity_claim_targets(entity_id,target_entity_id)
SELECT
  claim.entity_id,
  COALESCE(survivor.entity_id,claim.entity_id)
FROM _v6_entity_claims claim
LEFT JOIN _v6_strong_survivors survivor
  ON survivor.strong_key=claim.desired_strong_key;

-- A row that moves away from its old entity's claim target is a sibling split.
-- The unchanged V5 link on that row is only a copy of the original entity-level
-- decision, not evidence that the newly split game owns the same purchase.
DROP TABLE IF EXISTS temp._v6_stale_split_projections;
CREATE TEMP TABLE _v6_stale_split_projections (
  play_game_id TEXT PRIMARY KEY NOT NULL
);
INSERT INTO _v6_stale_split_projections(play_game_id)
SELECT current.play_game_id
FROM _v6_current_bindings current
JOIN _v6_binding_targets target ON target.play_game_id=current.play_game_id
JOIN _v6_entity_claim_targets claim_target
  ON claim_target.entity_id=current.current_entity_id
JOIN _v6_legacy_link_state legacy_state
  ON legacy_state.play_game_id=current.play_game_id
WHERE target.target_entity_id!=claim_target.target_entity_id
  AND legacy_state.has_legacy_link=1
  AND legacy_state.legacy_changed=0;

DROP TABLE IF EXISTS temp._v6_legacy_link_candidates;
CREATE TEMP TABLE _v6_legacy_link_candidates (
  play_game_id TEXT PRIMARY KEY NOT NULL
);
INSERT INTO _v6_legacy_link_candidates(play_game_id)
SELECT current.play_game_id
FROM _v6_current_bindings current
JOIN _v6_binding_targets target ON target.play_game_id=current.play_game_id
LEFT JOIN _v6_entity_claim_targets claim_target
  ON claim_target.entity_id=current.current_entity_id
LEFT JOIN _v6_legacy_link_state legacy_state
  ON legacy_state.play_game_id=current.play_game_id
WHERE EXISTS(
    SELECT 1 FROM play_purchase_links legacy
    WHERE legacy.play_game_id=current.play_game_id
  )
  AND (
    current.current_entity_id IS NULL
    OR legacy_state.legacy_changed=1
    OR target.target_entity_id=claim_target.target_entity_id
  );

-- A weak, previously unseen source row gets its own opaque entity. Existing
-- weak bindings retain their entity (or follow that entity's chosen survivor).
INSERT INTO game_entities(
  id,strong_key,canonical_title,normalized_title,title_id,official_url,platform,created_at,updated_at
)
SELECT
  target.target_entity_id,
  NULL,
  game.title,
  game.normalized_title,
  game.title_id,
  game.official_url,
  game.platform,
  game.created_at,
  game.updated_at
FROM _v6_binding_targets target
JOIN _v6_current_bindings current ON current.play_game_id=target.play_game_id
JOIN play_games game ON game.id=target.play_game_id
WHERE current.desired_strong_key IS NULL
  AND current.current_entity_id IS NULL;

DROP TABLE IF EXISTS temp._v6_entity_redirects;
CREATE TEMP TABLE _v6_entity_redirects (
  source_entity_id TEXT PRIMARY KEY NOT NULL,
  target_entity_id TEXT NOT NULL
);
INSERT INTO _v6_entity_redirects(source_entity_id,target_entity_id)
SELECT claim.entity_id,survivor.entity_id
FROM _v6_entity_claims claim
JOIN _v6_strong_survivors survivor
  ON survivor.strong_key=claim.desired_strong_key
WHERE claim.entity_id!=survivor.entity_id;

-- Redirect every older alias before deleting its former target. The old direct
-- ID itself becomes an alias only after the loser row has been deleted, which
-- preserves the direct-ID/alias-ID mutual exclusion at every statement.
UPDATE game_entity_aliases
SET entity_id=(
    SELECT redirect.target_entity_id FROM _v6_entity_redirects redirect
    WHERE redirect.source_entity_id=game_entity_aliases.entity_id
  ),
  updated_at=COALESCE((SELECT MAX(updated_at) FROM play_games),updated_at)
WHERE entity_id IN (SELECT source_entity_id FROM _v6_entity_redirects);

INSERT INTO source_bindings(
  id,entity_id,play_game_id,source,external_id,created_at,updated_at
)
SELECT
  'source-binding:' || game.id,
  target.target_entity_id,
  game.id,
  game.source,
  game.external_id,
  game.created_at,
  game.updated_at
FROM _v6_binding_targets target
JOIN play_games game ON game.id=target.play_game_id
WHERE true
ON CONFLICT(play_game_id) DO UPDATE SET
  entity_id=excluded.entity_id,
  source=excluded.source,
  external_id=excluded.external_id,
  updated_at=excluded.updated_at;

DELETE FROM game_entity_aliases
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)
  AND entity_id IN (
  SELECT entity.id FROM game_entities entity
  WHERE NOT EXISTS(
    SELECT 1 FROM source_bindings binding WHERE binding.entity_id=entity.id
  )
);
DELETE FROM game_entities
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)
  AND NOT EXISTS(
    SELECT 1 FROM source_bindings binding WHERE binding.entity_id=game_entities.id
  );

INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
SELECT
  redirect.source_entity_id,
  redirect.target_entity_id,
  COALESCE((SELECT MAX(created_at) FROM play_games),'1970-01-01T00:00:00.000Z'),
  COALESCE((SELECT MAX(updated_at) FROM play_games),'1970-01-01T00:00:00.000Z')
FROM _v6_entity_redirects redirect
WHERE NOT EXISTS(
  SELECT 1 FROM game_entities entity WHERE entity.id=redirect.source_entity_id
)
ON CONFLICT(alias_id) DO UPDATE SET
  entity_id=excluded.entity_id,
  updated_at=excluded.updated_at;

-- Refresh the selected entity from its strongest current source without ever
-- rewriting its public ID. URL selection is independent so an empty Store URL
-- cannot erase a useful URL from a lower-priority source.
UPDATE game_entities
SET canonical_title=COALESCE((
      SELECT game.title FROM source_bindings binding
      JOIN play_games game ON game.id=binding.play_game_id
      WHERE binding.entity_id=game_entities.id
      ORDER BY CASE game.source
        WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
        WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
        game.updated_at DESC,game.id ASC LIMIT 1
    ),canonical_title),
    normalized_title=COALESCE((
      SELECT game.normalized_title FROM source_bindings binding
      JOIN play_games game ON game.id=binding.play_game_id
      WHERE binding.entity_id=game_entities.id
      ORDER BY CASE game.source
        WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
        WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
        game.updated_at DESC,game.id ASC LIMIT 1
    ),normalized_title),
    title_id=CASE WHEN game_entities.strong_key IS NULL THEN NULL ELSE (
      SELECT game.title_id FROM source_bindings binding
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
    ) END,
    official_url=COALESCE((
      SELECT NULLIF(TRIM(game.official_url),'') FROM source_bindings binding
      JOIN play_games game ON game.id=binding.play_game_id
      WHERE binding.entity_id=game_entities.id
        AND length(trim(COALESCE(game.official_url,'')))>0
      ORDER BY CASE game.source
        WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
        WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
        game.updated_at DESC,game.id ASC LIMIT 1
    ),official_url),
    platform=COALESCE((
      SELECT game.platform FROM source_bindings binding
      JOIN play_games game ON game.id=binding.play_game_id
      WHERE binding.entity_id=game_entities.id
      ORDER BY CASE game.source
        WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
        WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
        game.updated_at DESC,game.id ASC LIMIT 1
    ),platform),
    updated_at=COALESCE((
      SELECT MAX(game.updated_at) FROM source_bindings binding
      JOIN play_games game ON game.id=binding.play_game_id
      WHERE binding.entity_id=game_entities.id
    ),updated_at)
WHERE NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=6)
  AND EXISTS(
    SELECT 1 FROM source_bindings binding WHERE binding.entity_id=game_entities.id
  );

-- Lift the strongest existing per-source collection decision to the entity.
DELETE FROM play_purchase_links
WHERE play_game_id IN (SELECT play_game_id FROM _v6_stale_split_projections);

WITH ranked_links AS (
  SELECT b.entity_id,l.*,
    ROW_NUMBER() OVER (
      PARTITION BY b.entity_id
      ORDER BY
        CASE WHEN l.match_method='manual' THEN 1 ELSE 0 END DESC,
        CASE l.status WHEN 'confirmed' THEN 3 WHEN 'rejected' THEN 2 ELSE 1 END DESC,
        l.updated_at DESC,
        l.id ASC
    ) AS position
  FROM source_bindings b
  JOIN _v6_legacy_link_candidates candidate
    ON candidate.play_game_id=b.play_game_id
  JOIN play_purchase_links l ON l.play_game_id=b.play_game_id
)
INSERT INTO game_entity_purchase_links(
  id,entity_id,purchase_record_id,status,match_method,confidence,
  decided_at,decided_by,created_at,updated_at
)
SELECT
  'game-entity-purchase-link:' || entity_id,
  entity_id,purchase_record_id,status,match_method,confidence,
  decided_at,decided_by,created_at,updated_at
FROM ranked_links
WHERE position=1
ON CONFLICT(entity_id) DO UPDATE SET
  purchase_record_id=excluded.purchase_record_id,
  status=excluded.status,
  match_method=excluded.match_method,
  confidence=excluded.confidence,
  decided_at=excluded.decided_at,
  decided_by=excluded.decided_by,
  updated_at=excluded.updated_at;

INSERT INTO game_entity_acquisitions(id,entity_id,purchase_record_id,linked_at,linked_by)
SELECT
  'game-entity-acquisition:' || b.entity_id || ':' || l.purchase_record_id,
  b.entity_id,
  l.purchase_record_id,
  COALESCE(l.decided_at,l.updated_at,l.created_at),
  l.decided_by
FROM source_bindings b
JOIN play_purchase_links l ON l.play_game_id=b.play_game_id
WHERE l.status='confirmed' AND l.purchase_record_id IS NOT NULL
ON CONFLICT(entity_id,purchase_record_id) DO UPDATE SET
  linked_at=CASE WHEN excluded.linked_at > game_entity_acquisitions.linked_at
    THEN excluded.linked_at ELSE game_entity_acquisitions.linked_at END,
  linked_by=COALESCE(excluded.linked_by,game_entity_acquisitions.linked_by);

-- Keep the legacy per-play_game relationship as a projection so V5 readers,
-- connector compatibility code and a marker-only rollback see the same choice.
INSERT INTO play_purchase_links(
  id,play_game_id,purchase_record_id,status,match_method,confidence,
  decided_at,decided_by,created_at,updated_at
)
SELECT
  'entity-link-projection:' || b.play_game_id,
  b.play_game_id,l.purchase_record_id,l.status,l.match_method,l.confidence,
  l.decided_at,l.decided_by,l.created_at,l.updated_at
FROM source_bindings b
JOIN game_entity_purchase_links l ON l.entity_id=b.entity_id
WHERE true
ON CONFLICT(play_game_id) DO UPDATE SET
  purchase_record_id=excluded.purchase_record_id,
  status=excluded.status,
  match_method=excluded.match_method,
  confidence=excluded.confidence,
  decided_at=excluded.decided_at,
  decided_by=excluded.decided_by,
  updated_at=excluded.updated_at;

DROP TABLE IF EXISTS temp._v6_legacy_link_candidates;
DROP TABLE IF EXISTS temp._v6_stale_split_projections;
DROP TABLE IF EXISTS temp._v6_entity_claim_targets;
DROP TABLE IF EXISTS temp._v6_entity_redirects;
DROP TABLE IF EXISTS temp._v6_binding_targets;
DROP TABLE IF EXISTS temp._v6_strong_games;
DROP TABLE IF EXISTS temp._v6_strong_survivors;
DROP TABLE IF EXISTS temp._v6_entity_claims;
DROP TABLE IF EXISTS temp._v6_legacy_link_state;
DROP TABLE IF EXISTS temp._v6_current_bindings;

UPDATE app_metadata SET value='6' WHERE key='schema_version';
