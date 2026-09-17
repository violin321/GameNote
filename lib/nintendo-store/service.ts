import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createStoreClient } from "../../scripts/nintendo-store-probe/client.mjs";
import {
  beginStoreAuthorization,
  completeStoreAuthorization,
  disconnectStoreCredentials,
  hasStoreSession,
  readPendingStoreAuthorization,
  readStoreSession,
  StoreAuthError,
} from "../../scripts/nintendo-store-probe/auth.mjs";
import { createSuggestedPurchaseLink, openDatabase } from "../play-history/repository";
import { ensurePlayGameEntityBinding } from "../play-history/entities";
import { normalizeTitle } from "../play-history/validation";

export type StoreServiceOptions = {
  environment?: NodeJS.ProcessEnv;
  client?: {
    collect(sessionToken: string, signal?: AbortSignal): Promise<StoreCollectResult>;
  };
  signal?: AbortSignal;
  now?: () => string;
};

export type StoreHistoryItem = {
  titleId?: unknown;
  titleName?: unknown;
  platform?: unknown;
  deviceType?: unknown;
  imageUrl?: unknown;
  firstPlayedAt?: unknown;
  lastPlayedAt?: unknown;
  lastUpdatedAt?: unknown;
  totalPlayedMinutes?: unknown;
  totalPlayedDays?: unknown;
};

export type StoreDailyHistoryItem = {
  titleId?: unknown;
  titleName?: unknown;
  platform?: unknown;
  deviceType?: unknown;
  imageUrl?: unknown;
  totalPlayedMinutes?: unknown;
};

export type StoreRecentDay = {
  playedDate?: unknown;
  playedAt?: unknown;
  date?: unknown;
  dailyPlayHistories?: unknown;
};

export type StoreCollectResult = {
  history: {
    playHistories: StoreHistoryItem[];
    recentPlayHistories?:
      StoreRecentDay[] | { count?: unknown; dates?: unknown; days?: StoreRecentDay[] };
    lastUpdatedAt?: unknown;
  };
  authentication?: string;
};

export class NintendoStoreError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
  ) {
    super(code);
    this.name = "NintendoStoreError";
  }
}

let activeSync: Promise<StoreSyncResult> | null = null;

/** Read the encrypted session and fetch the account's Store history. */
export async function collectNintendoStore(options: StoreServiceOptions = {}) {
  const sessionToken = await readStoreSession(options.environment);
  const client = options.client ?? createStoreClient();
  try {
    return (await client.collect(sessionToken, options.signal)) as StoreCollectResult;
  } catch (error) {
    if (error instanceof NintendoStoreError) throw error;
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code)
        : "store_sync_failed";
    const status = Number((error as { status?: unknown })?.status);
    if (code === "store_auth_rejected" || code === "store_reauthorization_required")
      throw new NintendoStoreError("store_reauthorization_required", 401);
    throw new NintendoStoreError(code, Number.isInteger(status) ? status : 502);
  }
}

/** Status is deliberately local/read-only: it never contacts Nintendo. */
export async function readNintendoStoreStatus(environment = process.env) {
  const connected = await hasStoreSession(environment);
  const pending = await readPendingStoreAuthorization(environment);
  let titleCount = 0;
  let lastSyncedAt: string | null = null;
  if (connected) {
    try {
      const db = await openDatabase();
      try {
        const row = db
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM play_games WHERE source='nintendo_store') AS count,
              (SELECT MAX(fetched_at) FROM nintendo_store_sync_snapshots) AS updated_at`,
          )
          .get() as { count?: number | bigint; updated_at?: string | null };
        titleCount = Number(row?.count || 0);
        lastSyncedAt = typeof row?.updated_at === "string" ? row.updated_at : null;
      } finally {
        db.close();
      }
    } catch {
      // A valid credential with an uninitialized database is still connected.
    }
  }
  return {
    connected,
    pendingAuthorization: Boolean(pending && pending.expiresAt > Date.now()),
    titleCount,
    lastSyncedAt,
  };
}

export async function authorizeNintendoStore(now = Date.now(), environment = process.env) {
  return beginStoreAuthorization(now, environment);
}

export async function callbackNintendoStore(
  callbackUrl: string,
  options: {
    now?: number;
    environment?: NodeJS.ProcessEnv;
    client?: {
      exchangeCode(code: string, verifier: string, signal?: AbortSignal): Promise<string>;
      collect(sessionToken: string, signal?: AbortSignal): Promise<StoreCollectResult>;
    };
  } = {},
) {
  type CompleteOptions = NonNullable<Parameters<typeof completeStoreAuthorization>[1]>;
  return completeStoreAuthorization(callbackUrl, options as unknown as CompleteOptions);
}

export async function disconnectNintendoStore(environment = process.env) {
  await disconnectStoreCredentials(environment);
}

export type StoreSyncResult = {
  count: number;
  skipped: number;
  titleCount: number;
  dailyCount?: number;
  skippedDaily?: number;
  snapshotId?: string;
  authentication?: string;
  fetchedAt: string;
};

/** Import one complete Store response atomically. Repeated syncs replace the
 * current account totals; they never add them to Moon's daily aggregates. */
export function syncNintendoStore(options: StoreServiceOptions = {}) {
  if (activeSync) return Promise.reject(new NintendoStoreError("store_sync_busy", 409));
  const run = syncNintendoStoreOnce(options);
  activeSync = run;
  return run.finally(() => {
    if (activeSync === run) activeSync = null;
  });
}

async function syncNintendoStoreOnce(options: StoreServiceOptions): Promise<StoreSyncResult> {
  const result = await collectNintendoStore(options);
  const items = Array.isArray(result?.history?.playHistories) ? result.history.playHistories : null;
  if (!items) throw new NintendoStoreError("store_invalid_upstream_data", 502);

  const now = options.now?.() ?? new Date().toISOString();
  const normalized = items
    .map(normalizeStoreItem)
    .filter((item): item is StoreItem => item !== null);
  const daily = normalizeStoreDailyHistory(result.history.recentPlayHistories, normalized);
  const snapshotId = randomUUID();
  const upstreamUpdatedValue = optionalDate(result.history.lastUpdatedAt);
  const upstreamUpdatedAt = upstreamUpdatedValue ? upstreamUpdatedValue : null;
  const authentication =
    result.authentication === "access_token" || result.authentication === "id_token"
      ? result.authentication
      : "";
  const payloadSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        titles: normalized,
        daily: daily.items,
        upstreamUpdatedAt,
      }),
    )
    .digest("hex");
  const db = await openDatabase();
  let count = 0;
  const skipped = items.length - normalized.length;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO nintendo_store_sync_snapshots(
        id,fetched_at,upstream_updated_at,authentication,payload_sha256,
        source_title_count,imported_title_count,skipped_title_count,
        imported_daily_count,skipped_daily_count,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshotId,
      now,
      upstreamUpdatedAt,
      authentication,
      payloadSha256,
      items.length,
      normalized.length,
      skipped,
      daily.items.length,
      daily.skipped,
      now,
    );
    for (const item of normalized) {
      const existing = db
        .prepare(
          `SELECT id,external_id,title,normalized_title,title_id,platform,first_played_at,last_played_at
           FROM play_games
           WHERE source='nintendo_store' AND
             (external_id=? OR (title_id=? COLLATE NOCASE AND platform=?))
           ORDER BY CASE WHEN external_id=? THEN 0 ELSE 1 END, updated_at DESC, id ASC LIMIT 1`,
        )
        .get(item.externalId, item.titleId, item.platform, item.externalId) as StoreRow | undefined;
      const storeId = existing?.id || randomUUID();
      const first = item.firstPlayedAt || existing?.first_played_at || "";
      const last = item.lastPlayedAt || existing?.last_played_at || "";
      if (existing?.id) {
        db.prepare(
          `UPDATE play_games SET external_id=?, title=?, normalized_title=?, title_id=?, platform=?,
             first_played_at=?, last_played_at=?, total_seconds=?, play_days=?, updated_at=? WHERE id=?`,
        ).run(
          item.externalId,
          item.title,
          item.normalizedTitle,
          item.titleId,
          item.platform,
          first,
          last,
          item.totalSeconds,
          item.playDays,
          now,
          storeId,
        );
      } else {
        db.prepare(
          `INSERT INTO play_games(
            id,source,external_id,title,normalized_title,title_id,platform,first_played_at,last_played_at,
            total_seconds,play_days,created_at,updated_at
          ) VALUES(?,'nintendo_store',?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          storeId,
          item.externalId,
          item.title,
          item.normalizedTitle,
          item.titleId,
          item.platform,
          first,
          last,
          item.totalSeconds,
          item.playDays,
          now,
          now,
        );
      }
      ensurePlayGameEntityBinding(db, storeId, now);
      preserveMoonAssociation(db, storeId, item, now);
      db.prepare(
        `INSERT INTO nintendo_store_game_snapshots(
          snapshot_id,play_game_id,external_id,title_id,title,platform,image_url,
          first_played_at,last_played_at,total_seconds,play_days
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snapshot_id,external_id) DO UPDATE SET
          play_game_id=excluded.play_game_id,title_id=excluded.title_id,title=excluded.title,
          platform=excluded.platform,image_url=excluded.image_url,
          first_played_at=excluded.first_played_at,last_played_at=excluded.last_played_at,
          total_seconds=excluded.total_seconds,play_days=excluded.play_days`,
      ).run(
        snapshotId,
        storeId,
        item.externalId,
        item.titleId,
        item.title,
        item.platform,
        item.imageUrl,
        item.firstPlayedAt,
        item.lastPlayedAt,
        item.totalSeconds,
        item.playDays,
      );
      count += 1;
    }
    const storeRows = db
      .prepare(
        `SELECT id,external_id,title_id,platform FROM play_games
         WHERE source='nintendo_store' AND title_id IS NOT NULL
         ORDER BY updated_at DESC,id ASC`,
      )
      .all() as StoreIdentityRow[];
    const storeRowsByTitle = groupStoreRowsByTitle(storeRows);
    for (const rawDailyItem of daily.items) {
      const resolved = resolveDailyIdentity(rawDailyItem, storeRowsByTitle);
      db.prepare(
        `INSERT INTO nintendo_store_daily_history(
          official_date,external_id,play_game_id,title_id,title,platform,image_url,total_seconds,
          first_seen_at,last_seen_at,last_snapshot_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(official_date,external_id) DO UPDATE SET
          play_game_id=COALESCE(excluded.play_game_id,nintendo_store_daily_history.play_game_id),
          title_id=excluded.title_id,title=excluded.title,
          platform=CASE WHEN excluded.platform<>'' THEN excluded.platform
            ELSE nintendo_store_daily_history.platform END,
          image_url=CASE WHEN excluded.image_url<>'' THEN excluded.image_url
            ELSE nintendo_store_daily_history.image_url END,
          total_seconds=excluded.total_seconds,last_seen_at=excluded.last_seen_at,
          last_snapshot_id=excluded.last_snapshot_id`,
      ).run(
        resolved.officialDate,
        resolved.externalId,
        resolved.playGameId,
        resolved.titleId,
        resolved.title,
        resolved.platform,
        resolved.imageUrl,
        resolved.totalSeconds,
        now,
        now,
        snapshotId,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    if (error instanceof NintendoStoreError) throw error;
    throw new NintendoStoreError("store_import_failed", 500);
  } finally {
    db.close();
  }
  return {
    count,
    skipped,
    titleCount: normalized.length,
    dailyCount: daily.items.length,
    skippedDaily: daily.skipped,
    snapshotId,
    authentication: result.authentication,
    fetchedAt: now,
  };
}

type StoreItem = {
  titleId: string;
  title: string;
  normalizedTitle: string;
  platform: string;
  imageUrl: string;
  externalId: string;
  firstPlayedAt: string;
  lastPlayedAt: string;
  totalSeconds: number;
  playDays: number;
};

type StoreRow = {
  id?: string;
  external_id?: string;
  title?: string;
  normalized_title?: string;
  title_id?: string;
  platform?: string;
  first_played_at?: string;
  last_played_at?: string;
};

type StoreDailyItem = {
  officialDate: string;
  titleId: string;
  title: string;
  platform: string;
  imageUrl: string;
  externalId: string;
  totalSeconds: number;
};

type StoreIdentityRow = {
  id?: string;
  external_id?: string;
  title_id?: string;
  platform?: string;
};

function normalizeStoreItem(value: StoreHistoryItem): StoreItem | null {
  if (!value || typeof value !== "object") return null;
  const titleId = text(value.titleId, 160);
  const title = text(value.titleName, 200) || titleId;
  const platform = text(value.platform, 80) || text(value.deviceType, 80) || "Nintendo Switch";
  const imageUrl = safeImageUrl(value.imageUrl);
  const minutes = nonNegativeInt(value.totalPlayedMinutes);
  const playDays = nonNegativeInt(value.totalPlayedDays) ?? 0;
  if (!titleId || !/^[A-Za-z0-9._:-]+$/.test(titleId) || minutes === null) return null;
  const firstValue = optionalDate(value.firstPlayedAt);
  const lastValue = optionalDate(value.lastPlayedAt);
  if (firstValue === null || lastValue === null) return null;
  const firstPlayedAt = firstValue;
  const lastPlayedAt = lastValue;
  if (firstPlayedAt && lastPlayedAt && Date.parse(firstPlayedAt) > Date.parse(lastPlayedAt))
    return null;
  const normalizedPlatform = platformKey(platform);
  return {
    titleId,
    title,
    normalizedTitle: normalizeTitle(title),
    platform,
    imageUrl,
    externalId: `store:${titleId.toLowerCase()}:${normalizedPlatform}`,
    firstPlayedAt,
    lastPlayedAt,
    totalSeconds: minutes * 60,
    playDays,
  };
}

function normalizeStoreDailyHistory(
  value: StoreCollectResult["history"]["recentPlayHistories"],
  cumulative: StoreItem[],
) {
  const days = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.days)
      ? value.days
      : [];
  const cumulativeByTitle = new Map<string, StoreItem[]>();
  for (const item of cumulative) {
    const key = item.titleId.toLowerCase();
    const current = cumulativeByTitle.get(key) || [];
    current.push(item);
    cumulativeByTitle.set(key, current);
  }
  const normalized = new Map<string, StoreDailyItem>();
  let skipped = 0;
  for (const day of days) {
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      skipped += 1;
      continue;
    }
    const titles = Array.isArray(day.dailyPlayHistories) ? day.dailyPlayHistories : [];
    const date = officialDate(day.playedDate ?? day.playedAt ?? day.date);
    if (!date) {
      skipped += Math.max(1, titles.length);
      continue;
    }
    for (const value of titles) {
      const item = normalizeStoreDailyItem(value, date, cumulativeByTitle);
      if (!item) {
        skipped += 1;
        continue;
      }
      const key = `${item.officialDate}\u0000${item.externalId}`;
      if (normalized.has(key)) skipped += 1;
      normalized.set(key, item);
    }
  }
  return { items: [...normalized.values()], skipped };
}

function normalizeStoreDailyItem(
  value: unknown,
  officialDate: string,
  cumulativeByTitle: Map<string, StoreItem[]>,
): StoreDailyItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as StoreDailyHistoryItem;
  const titleId = text(source.titleId, 160);
  const minutes = nonNegativeInt(source.totalPlayedMinutes);
  if (!titleId || !/^[A-Za-z0-9._:-]+$/.test(titleId) || minutes === null) return null;
  const matches = cumulativeByTitle.get(titleId.toLowerCase()) || [];
  const uniqueMatch = matches.length === 1 ? matches[0] : undefined;
  const title = text(source.titleName, 200) || uniqueMatch?.title || titleId;
  const platform =
    text(source.platform, 80) || text(source.deviceType, 80) || uniqueMatch?.platform || "";
  const imageUrl = safeImageUrl(source.imageUrl) || uniqueMatch?.imageUrl || "";
  const identityPlatform = platform ? platformKey(platform) : "unknown";
  return {
    officialDate,
    titleId,
    title,
    platform,
    imageUrl,
    externalId: `store:${titleId.toLowerCase()}:${identityPlatform}`,
    totalSeconds: minutes * 60,
  };
}

function groupStoreRowsByTitle(rows: StoreIdentityRow[]) {
  const grouped = new Map<string, StoreIdentityRow[]>();
  for (const row of rows) {
    const titleId = text(row.title_id, 160);
    const id = text(row.id, 160);
    const externalId = text(row.external_id, 400);
    if (!titleId || !id || !externalId) continue;
    const key = titleId.toLowerCase();
    const current = grouped.get(key) || [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

function resolveDailyIdentity(
  item: StoreDailyItem,
  rowsByTitle: Map<string, StoreIdentityRow[]>,
): StoreDailyItem & { playGameId: string | null } {
  const rows = rowsByTitle.get(item.titleId.toLowerCase()) || [];
  const exact = rows.find((row) => row.external_id === item.externalId);
  const match = exact || (rows.length === 1 ? rows[0] : undefined);
  if (!match?.id || !match.external_id) return { ...item, playGameId: null };
  return {
    ...item,
    externalId: match.external_id,
    platform: item.platform || text(match.platform, 80),
    playGameId: match.id,
  };
}

function preserveMoonAssociation(
  db: Awaited<ReturnType<typeof openDatabase>>,
  storeId: string,
  item: StoreItem,
  now: string,
) {
  if (db.prepare("SELECT 1 FROM play_purchase_links WHERE play_game_id=?").get(storeId)) return;
  const moonRows = db
    .prepare(
      "SELECT id FROM play_games WHERE source='moon_connector' AND title_id=? COLLATE NOCASE ORDER BY updated_at DESC, id ASC",
    )
    .all(item.titleId) as Array<{ id?: string }>;
  if (moonRows.length === 1 && moonRows[0]?.id) {
    const link = db
      .prepare(
        `SELECT purchase_record_id,status,match_method,confidence,decided_at,decided_by,created_at,updated_at
         FROM play_purchase_links WHERE play_game_id=?`,
      )
      .get(moonRows[0].id) as Record<string, unknown> | undefined;
    if (link) {
      db.prepare(
        `INSERT INTO play_purchase_links(
          id,play_game_id,purchase_record_id,status,match_method,confidence,decided_at,decided_by,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        randomUUID(),
        storeId,
        link.purchase_record_id,
        link.status,
        link.match_method,
        link.confidence,
        link.decided_at,
        link.decided_by,
        link.created_at || now,
        link.updated_at || now,
      );
      return;
    }
  }
  createSuggestedPurchaseLink(db, storeId, now);
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" && value.trim() && value.trim().length <= maximum
    ? value.trim()
    : "";
}

function safeImageUrl(value: unknown) {
  const candidate = text(value, 2_048);
  if (!candidate) return "";
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function nonNegativeInt(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function optionalDate(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 80) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function officialDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : "";
}

function platformKey(platform: string) {
  const normalized = platform.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["bee", "switch2", "nintendoswitch2"].includes(normalized)) return "switch2";
  if (["hac", "switch", "nintendoswitch"].includes(normalized)) return "switch";
  return normalized || "switch";
}

export { StoreAuthError };
