-- V2: ledger_documents remains the compatibility write model. purchase_records
-- is a transactionally maintained, soft-deletable projection used by joins.

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
ALTER TABLE purchase_records ADD COLUMN source_updated_at TEXT;
ALTER TABLE purchase_records ADD COLUMN projection_hash TEXT;
ALTER TABLE purchase_records ADD COLUMN deleted_at TEXT;
ALTER TABLE purchase_records ADD COLUMN platform_family TEXT;
ALTER TABLE purchase_records ADD COLUMN platform_variant TEXT;
ALTER TABLE purchase_records ADD COLUMN cover_url TEXT;
ALTER TABLE purchase_records ADD COLUMN purchase_date TEXT;
ALTER TABLE purchase_records ADD COLUMN source_document_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_purchase_records_active
  ON purchase_records(deleted_at, purchase_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_records_platform
  ON purchase_records(platform_family, platform_variant);

INSERT INTO purchase_records(
  id, title, title_id, official_url, normalized_title, raw_json, imported_at,
  source_updated_at, projection_hash, deleted_at, platform_family,
  platform_variant, cover_url, purchase_date, source_document_id
)
SELECT
  json_extract(item.value, '$.id'),
  json_extract(item.value, '$.title'),
  COALESCE(json_extract(item.value, '$.titleId'), ''),
  NULLIF(json_extract(item.value, '$.officialUrl'), ''),
  lower(trim(json_extract(item.value, '$.title'))),
  item.value,
  document.updated_at,
  document.updated_at,
  purchase_projection_sha256(item.value),
  NULL,
  CASE json_extract(item.value, '$.platform')
    WHEN 'PlayStation' THEN 'PlayStation'
    ELSE 'Nintendo'
  END,
  COALESCE(json_extract(item.value, '$.platform'), 'Nintendo Switch'),
  NULLIF(json_extract(item.value, '$.coverUrl'), ''),
  NULLIF(json_extract(item.value, '$.purchaseDate'), ''),
  document.id
FROM ledger_documents AS document, json_each(document.records) AS item
WHERE json_valid(document.records)
  AND json_type(item.value) = 'object'
  AND length(COALESCE(json_extract(item.value, '$.id'), '')) > 0
  AND length(COALESCE(json_extract(item.value, '$.title'), '')) > 0
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  title_id = COALESCE(NULLIF(excluded.title_id, ''), purchase_records.title_id),
  official_url = excluded.official_url,
  normalized_title = excluded.normalized_title,
  raw_json = excluded.raw_json,
  source_updated_at = excluded.source_updated_at,
  projection_hash = excluded.projection_hash,
  deleted_at = NULL,
  platform_family = excluded.platform_family,
  platform_variant = excluded.platform_variant,
  cover_url = excluded.cover_url,
  purchase_date = excluded.purchase_date,
  source_document_id = excluded.source_document_id;

UPDATE purchase_records
SET source_updated_at = COALESCE(source_updated_at, imported_at),
    projection_hash = purchase_projection_sha256(raw_json),
    -- Rows absent from their source ledger are tombstones. This reconstructs
    -- soft-delete state after V2 -> V1 -> V2 without deleting the row, so
    -- confirmed play_purchase_links retain their historical foreign key.
    deleted_at = CASE
      WHEN NOT EXISTS (
        SELECT 1
        FROM ledger_documents AS source, json_each(source.records) AS active
        WHERE source.id = purchase_records.source_document_id
          AND json_valid(source.records)
          AND json_type(active.value) = 'object'
          AND json_extract(active.value, '$.id') = purchase_records.id
      ) THEN COALESCE(deleted_at, source_updated_at, imported_at)
      ELSE NULL
    END,
    platform_family = COALESCE(platform_family,
      CASE json_extract(raw_json, '$.platform')
        WHEN 'PlayStation' THEN 'PlayStation'
        ELSE 'Nintendo'
      END),
    platform_variant = COALESCE(platform_variant,
      COALESCE(json_extract(raw_json, '$.platform'), 'Nintendo Switch')),
    cover_url = COALESCE(cover_url, NULLIF(json_extract(raw_json, '$.coverUrl'), '')),
    purchase_date = COALESCE(purchase_date, NULLIF(json_extract(raw_json, '$.purchaseDate'), ''));

UPDATE app_metadata SET value = '2' WHERE key = 'schema_version';
