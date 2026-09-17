import { randomUUID } from "node:crypto";
import {
  createEmptyLedger,
  createLedgerDocument,
  type Currency,
  type GameFormat,
  type GameRecord,
  type LedgerDocument,
  type Region,
  normalizeLedgerDocument,
  normalizeRecords,
} from "./schema";
import { purchaseProjectionHash } from "../../scripts/purchase-projection-json.mjs";
import { normalizeOfficialUrl, normalizeTitle } from "@/lib/play-history/validation";
import { defaultThemeColor, isAccessibleThemeColor } from "@/lib/ui/theme-color";
import {
  ns2DatabaseIdentity,
  ns2SchemaVersion,
  playDatabaseFilePath,
} from "@/lib/play-history/database-config";
import {
  ensureAllPlayGameEntityBindings,
  resolveGameEntityId,
  upsertGameEntityPurchaseLink,
} from "@/lib/play-history/entities";

export type StatementSync = {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
};

type StatementRunResult = { changes?: number | bigint };

export type DatabaseSync = {
  readonly isTransaction: boolean;
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
};

type LedgerSqliteModule = {
  DatabaseSync: new (path: string) => DatabaseSync;
};

type LedgerRow = {
  records?: unknown;
  updated_at?: unknown;
};

const ledgerId = "default";

export async function readLedgerFromSqlite(): Promise<LedgerDocument> {
  const { db } = await openLedgerDatabase();

  try {
    const row = db
      .prepare("SELECT records, updated_at FROM ledger_documents WHERE id = ?")
      .get(ledgerId) as LedgerRow | undefined;

    if (row) {
      return normalizeLedgerDocument({
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
        records: parseStoredJson(row.records, []),
      });
    }

    return createEmptyLedger();
  } finally {
    db.close();
  }
}

export class LedgerConflictError extends Error {
  constructor() {
    super("LEDGER_CONFLICT");
    this.name = "LedgerConflictError";
  }
}

export class LedgerPlayGameNotFoundError extends Error {
  constructor() {
    super("PLAY_GAME_NOT_FOUND");
    this.name = "LedgerPlayGameNotFoundError";
  }
}

export type PlayCollectionInput = {
  title?: string;
  coverUrl?: string;
  officialUrl?: string;
  format: GameFormat;
  region: Region;
  purchaseDate: string;
  seller: string;
  price: number;
  currency: Currency;
  notes: string;
  soldDate: string;
  soldPrice: number;
  soldCurrency: Currency;
};

export async function writeLedgerToSqlite(document: LedgerDocument, expectedUpdatedAt?: string) {
  const { db } = await openLedgerDatabase();

  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!writeLedgerToOpenSqlite(db, document, expectedUpdatedAt))
        throw new LedgerConflictError();
      syncPurchaseProjection(db, document);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function createCollectionFromPlayGame(
  playGameId: string,
  input: PlayCollectionInput,
  decidedBy: string,
) {
  const { db } = await openLedgerDatabase();
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      ensureAllPlayGameEntityBindings(db, now);
      const entityId = resolveGameEntityId(db, playGameId);
      if (!entityId) throw new LedgerPlayGameNotFoundError();
      const game = db
        .prepare(
          `SELECT entity.id,entity.canonical_title AS title,entity.platform,
            entity.official_url,
            COALESCE(
              (SELECT NULLIF(snapshot.image_url,'')
               FROM source_bindings binding
               JOIN nintendo_store_game_snapshots snapshot
                 ON snapshot.play_game_id=binding.play_game_id
               JOIN nintendo_store_sync_snapshots sync ON sync.id=snapshot.snapshot_id
               WHERE binding.entity_id=entity.id
               ORDER BY sync.fetched_at DESC,snapshot.snapshot_id DESC LIMIT 1),
              (SELECT NULLIF(moon.image_url,'')
               FROM source_bindings binding
               JOIN moon_connector_games moon ON moon.play_game_id=binding.play_game_id
               WHERE binding.entity_id=entity.id
               ORDER BY moon.metadata_fetched_at DESC LIMIT 1),
              ''
            ) AS cover_url
           FROM game_entities entity WHERE entity.id=?`,
        )
        .get(entityId) as Record<string, unknown> | undefined;
      if (!game) throw new LedgerPlayGameNotFoundError();

      const existingLink = db
        .prepare(
          `SELECT p.raw_json FROM game_entity_acquisitions acquisition
           JOIN purchase_records p
             ON p.id=acquisition.purchase_record_id AND p.deleted_at IS NULL
           WHERE acquisition.entity_id=?
           ORDER BY acquisition.linked_at DESC,acquisition.id ASC LIMIT 1`,
        )
        .get(entityId) as { raw_json?: unknown } | undefined;
      if (existingLink?.raw_json) {
        const existing = normalizeRecords([parseStoredJson(existingLink.raw_json, {})])[0];
        db.exec("COMMIT");
        return { record: existing, created: false };
      }

      const row = db
        .prepare("SELECT records,updated_at FROM ledger_documents WHERE id=?")
        .get(ledgerId) as LedgerRow | undefined;
      const document = row
        ? normalizeLedgerDocument({
            records: parseStoredJson(row.records, []),
            updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
          })
        : createEmptyLedger();
      const platform = String(game.platform).toLowerCase().includes("playstation")
        ? "PlayStation"
        : "Nintendo Switch";
      const record = normalizeRecords([
        {
          id: randomUUID(),
          platform,
          title: input.title || String(game.title),
          price: input.price,
          currency: input.currency,
          purchaseDate: input.purchaseDate,
          region: input.region,
          format: input.format,
          seller: input.seller,
          coverUrl: input.coverUrl ?? String(game.cover_url || ""),
          officialUrl: input.officialUrl ?? String(game.official_url || ""),
          notes: input.notes,
          soldDate: input.soldDate,
          soldPrice: input.soldPrice,
          soldCurrency: input.soldCurrency,
        } satisfies GameRecord,
      ])[0];
      const nextDocument = createLedgerDocument([record, ...document.records]);
      writeLedgerToOpenSqlite(db, nextDocument);
      syncPurchaseProjection(db, nextDocument);
      upsertGameEntityPurchaseLink(db, {
        entityId,
        purchase_record_id: record.id,
        status: "confirmed",
        match_method: "manual",
        confidence: 1,
        decided_at: now,
        decided_by: decidedBy,
        updated_at: now,
      });
      db.exec("COMMIT");
      return { record, created: true, updatedAt: nextDocument.updatedAt };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

export type AppUser = {
  id: string;
  username: string;
  passwordHash: string;
  sessionVersion: number;
};

export async function getRegisteredUser(): Promise<AppUser | null> {
  const { db } = await openLedgerDatabase();
  try {
    const row = db
      .prepare(
        "SELECT id, username, password_hash, session_version FROM app_users ORDER BY created_at LIMIT 1",
      )
      .get() as
      | {
          id?: unknown;
          username?: unknown;
          password_hash?: unknown;
          session_version?: unknown;
        }
      | undefined;
    if (
      !row ||
      typeof row.id !== "string" ||
      typeof row.username !== "string" ||
      typeof row.password_hash !== "string"
    )
      return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      sessionVersion:
        typeof row.session_version === "number" && Number.isInteger(row.session_version)
          ? row.session_version
          : 1,
    };
  } finally {
    db.close();
  }
}

export async function createRegisteredUser(user: AppUser) {
  const { db } = await openLedgerDatabase();
  try {
    if (db.prepare("SELECT id FROM app_users LIMIT 1").get()) throw new Error("OWNER_EXISTS");
    db.prepare(
      "INSERT INTO app_users (id, username, password_hash, session_version, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(user.id, user.username, user.passwordHash, user.sessionVersion, new Date().toISOString());
  } finally {
    db.close();
  }
}

export async function updateRegisteredUserPassword(passwordHash: string) {
  const { db } = await openLedgerDatabase();
  try {
    db.prepare(
      "UPDATE app_users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?",
    ).run(passwordHash, "owner");
  } finally {
    db.close();
  }
}

export type AppSettings = {
  siteTitle: string;
  avatarUrl: string;
  themeColor: string;
  showNintendoSwitch: boolean;
  showPlayStation: boolean;
  showPsPlusCatalog: boolean;
  showMemberships: boolean;
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  psPlusEnabled: boolean;
  psPlusExpiresAt: string;
  psPlusAutoAddMonthly: boolean;
  nsOnlineEnabled: boolean;
  nsOnlineExpiresAt: string;
};

export async function readAppSettings(): Promise<AppSettings> {
  const { db } = await openLedgerDatabase();
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE id = ?").get("default") as
      { value?: unknown } | undefined;
    return normalizeAppSettings(parseStoredJson(row?.value, {}));
  } finally {
    db.close();
  }
}

export async function writeAppSettings(settings: AppSettings) {
  const { db } = await openLedgerDatabase();
  try {
    db.prepare(
      `INSERT INTO app_settings (id, value) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
    ).run("default", JSON.stringify(settings));
  } finally {
    db.close();
  }
}

export type AppCacheEntry = {
  value: unknown;
  expiresAt: string;
  updatedAt: string;
};

export async function readAppCache(key: string): Promise<AppCacheEntry | null> {
  const { db } = await openLedgerDatabase();
  try {
    const row = db
      .prepare("SELECT value, expires_at, updated_at FROM app_cache WHERE id = ?")
      .get(key) as { value?: unknown; expires_at?: unknown; updated_at?: unknown } | undefined;
    if (!row || typeof row.expires_at !== "string" || typeof row.updated_at !== "string")
      return null;
    return {
      value: parseStoredJson(row.value, null),
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

export async function writeAppCache(key: string, value: unknown, expiresAt: string) {
  const { db } = await openLedgerDatabase();
  try {
    db.prepare(
      `INSERT INTO app_cache (id, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), expiresAt, new Date().toISOString());
  } finally {
    db.close();
  }
}

function normalizeAppSettings(value: unknown): AppSettings {
  const source = value && typeof value === "object" ? (value as Partial<AppSettings>) : {};
  const showPlayStation = source.showPlayStation !== false;
  return {
    siteTitle:
      typeof source.siteTitle === "string" && source.siteTitle.trim()
        ? source.siteTitle.trim().slice(0, 40)
        : "GameNote",
    avatarUrl: typeof source.avatarUrl === "string" ? source.avatarUrl : "",
    themeColor:
      typeof source.themeColor === "string" && isAccessibleThemeColor(source.themeColor)
        ? source.themeColor
        : defaultThemeColor,
    showNintendoSwitch: source.showNintendoSwitch !== false,
    showPlayStation,
    showPsPlusCatalog: showPlayStation && source.showPsPlusCatalog !== false,
    showMemberships: source.showMemberships !== false,
    aiBaseUrl:
      typeof source.aiBaseUrl === "string" && source.aiBaseUrl
        ? source.aiBaseUrl
        : "https://api.openai.com/v1",
    aiModel: typeof source.aiModel === "string" && source.aiModel ? source.aiModel : "gpt-4.1-mini",
    aiApiKey: typeof source.aiApiKey === "string" ? source.aiApiKey : "",
    psPlusEnabled: source.psPlusEnabled === true,
    psPlusExpiresAt: typeof source.psPlusExpiresAt === "string" ? source.psPlusExpiresAt : "",
    psPlusAutoAddMonthly: source.psPlusAutoAddMonthly !== false,
    nsOnlineEnabled: source.nsOnlineEnabled === true,
    nsOnlineExpiresAt: typeof source.nsOnlineExpiresAt === "string" ? source.nsOnlineExpiresAt : "",
  };
}

function writeLedgerToOpenSqlite(
  db: DatabaseSync,
  document: LedgerDocument,
  expectedUpdatedAt?: string,
) {
  if (expectedUpdatedAt === undefined) {
    db.prepare(
      `INSERT INTO ledger_documents (id, records, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         records = excluded.records,
         updated_at = excluded.updated_at`,
    ).run(ledgerId, JSON.stringify(document.records), document.updatedAt);
    return true;
  }

  const result = db
    .prepare(
      `INSERT INTO ledger_documents (id, records, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         records = excluded.records,
         updated_at = excluded.updated_at
       WHERE ledger_documents.updated_at = ?`,
    )
    .run(
      ledgerId,
      JSON.stringify(document.records),
      document.updatedAt,
      expectedUpdatedAt,
    ) as StatementRunResult;
  return Number(result.changes ?? 0) > 0;
}

function syncPurchaseProjection(db: DatabaseSync, document: LedgerDocument) {
  const activeIds = new Set(document.records.map((record) => record.id));
  const existingRows = (db
    .prepare("SELECT id FROM purchase_records WHERE source_document_id = ?")
    .all(ledgerId) || []) as Array<{ id?: unknown }>;
  const upsert = db.prepare(
    `INSERT INTO purchase_records(
      id, title, title_id, official_url, normalized_title, raw_json, imported_at,
      source_updated_at, projection_hash, deleted_at, platform_family,
      platform_variant, cover_url, purchase_date, source_document_id
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      title_id=COALESCE(NULLIF(excluded.title_id, ''), purchase_records.title_id),
      official_url=excluded.official_url,
      normalized_title=excluded.normalized_title,
      raw_json=excluded.raw_json,
      source_updated_at=excluded.source_updated_at,
      projection_hash=excluded.projection_hash,
      deleted_at=NULL,
      platform_family=excluded.platform_family,
      platform_variant=excluded.platform_variant,
      cover_url=excluded.cover_url,
      purchase_date=excluded.purchase_date,
      source_document_id=excluded.source_document_id`,
  );
  for (const record of document.records) {
    const rawJson = JSON.stringify(record);
    const officialUrl = normalizeOfficialUrl(record.officialUrl);
    upsert.run(
      record.id,
      record.title,
      extractTitleId(officialUrl),
      officialUrl || null,
      normalizeTitle(record.title),
      rawJson,
      document.updatedAt,
      document.updatedAt,
      purchaseProjectionHash(record),
      record.platform === "PlayStation" ? "PlayStation" : "Nintendo",
      record.platform,
      record.coverUrl || null,
      record.purchaseDate || null,
      ledgerId,
    );
  }
  const softDelete = db.prepare(
    "UPDATE purchase_records SET deleted_at = ?, source_updated_at = ? WHERE id = ? AND source_document_id = ?",
  );
  for (const row of existingRows) {
    const id = typeof row.id === "string" ? row.id : "";
    if (id && !activeIds.has(id))
      softDelete.run(document.updatedAt, document.updatedAt, id, ledgerId);
  }
}

function extractTitleId(url: string) {
  return (
    url.match(/(?:title|product|games?|software)[\/-]([A-Za-z0-9._:-]{5,})/i)?.[1] ||
    url.match(/\b(\d{10,20})\b/)?.[1] ||
    ""
  );
}

export async function openLedgerDatabase() {
  const sqlite = await loadNodeSqlite();
  const filePath = databaseFilePath();
  const db = new sqlite.DatabaseSync(filePath);
  try {
    const marker = db
      .prepare(
        "SELECT key, value FROM app_metadata WHERE key IN ('database_identity','schema_version')",
      )
      .all() as Array<{ key?: unknown; value?: unknown }> | undefined;
    const metadata = Object.fromEntries(
      (marker || []).map((row) => [String(row.key), String(row.value)]),
    );
    if (
      metadata.database_identity !== ns2DatabaseIdentity ||
      metadata.schema_version !== String(ns2SchemaVersion)
    )
      throw new Error("invalid marker");
  } catch {
    db.close();
    throw new Error("NS2 database marker is missing or invalid; run migrations during startup");
  }
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  return { db, filePath };
}

function databaseFilePath() {
  return playDatabaseFilePath();
}

function parseStoredJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string" || !value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

async function loadNodeSqlite(): Promise<LedgerSqliteModule> {
  return import("node:sqlite") as unknown as Promise<LedgerSqliteModule>;
}
