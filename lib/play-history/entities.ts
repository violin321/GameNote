import { randomUUID } from "node:crypto";

type Statement = {
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
};

export type EntityDatabase = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  readonly isTransaction: boolean;
};

type PlayGameIdentityRow = {
  id: string;
  source: string;
  external_id: string;
  title: string;
  normalized_title: string;
  title_id: string | null;
  official_url: string | null;
  platform: string;
  created_at: string;
  updated_at: string;
};

type EntityLinkRow = {
  entity_id: string;
  purchase_record_id: string | null;
  status: "suggested" | "confirmed" | "rejected";
  match_method: "title_id" | "official_url" | "normalized_title" | "manual";
  confidence: number;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
  updated_at: string;
};

const GAME_ENTITY_ID_ATTEMPTS = 32;

export function gameEntityStrongKey(titleId: unknown, platform: unknown) {
  const normalizedTitleId = typeof titleId === "string" ? titleId.trim().toLowerCase() : "";
  if (!normalizedTitleId) return null;
  const family = String(platform || "")
    .toLowerCase()
    .includes("playstation")
    ? "playstation"
    : "nintendo";
  return `title-id:${family}:${normalizedTitleId}`;
}

export function ensureAllPlayGameEntityBindings(db: EntityDatabase, now: string) {
  // Migrations cover existing rows and every application write path binds new
  // rows explicitly. Read paths use this only as a cheap compatibility guard
  // for legacy/direct inserts; they do not refresh or rewrite healthy rows.
  // Do not allocate a full result set on every history/ledger read. The write
  // path below rechecks under its transaction before repairing any old rows.
  const hasUnbound = db
    .prepare(
      `SELECT 1 FROM play_games g
       WHERE NOT EXISTS (SELECT 1 FROM source_bindings b WHERE b.play_game_id=g.id)
       LIMIT 1`,
    )
    .get();
  if (!hasUnbound) return;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of unboundPlayGames(db)) ensurePlayGameEntityBinding(db, row.id, now);
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function unboundPlayGames(db: EntityDatabase) {
  return db
    .prepare(
      `SELECT g.id FROM play_games g
       LEFT JOIN source_bindings b ON b.play_game_id=g.id
       WHERE b.play_game_id IS NULL ORDER BY g.id`,
    )
    .all() as Array<{ id: string }>;
}

export function ensurePlayGameEntityBinding(
  db: EntityDatabase,
  playGameId: string,
  now: string,
  options: { entityId?: string } = {},
) {
  const game = db
    .prepare(
      `SELECT id,source,external_id,title,normalized_title,title_id,official_url,
        platform,created_at,updated_at FROM play_games WHERE id=?`,
    )
    .get(playGameId) as PlayGameIdentityRow | undefined;
  if (!game) throw new Error("PLAY_GAME_NOT_FOUND");

  const existing = db
    .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id=?")
    .get(playGameId) as { entity_id: string } | undefined;
  const existingEntityId = existing?.entity_id || null;
  const strongKey = gameEntityStrongKey(game.title_id, game.platform);
  let entityId = options.entityId || existingEntityId || "";

  if (options.entityId) {
    const forced = db
      .prepare("SELECT id,strong_key FROM game_entities WHERE id=?")
      .get(options.entityId) as { id: string; strong_key: string | null } | undefined;
    if (!forced) throw new Error("GAME_ENTITY_NOT_FOUND");
    if (strongKey && forced.strong_key && forced.strong_key !== strongKey)
      throw new Error("GAME_ENTITY_IDENTITY_CONFLICT");
    entityId = forced.id;
  }

  if (strongKey) {
    const strongEntity = db
      .prepare("SELECT id FROM game_entities WHERE strong_key=?")
      .get(strongKey) as { id: string } | undefined;
    const compatible = entityId
      ? entityBindingsCompatibleWithStrongKey(db, entityId, strongKey)
      : true;
    if (options.entityId && !compatible) throw new Error("GAME_ENTITY_IDENTITY_CONFLICT");
    if (strongEntity?.id && entityId && strongEntity.id !== entityId && compatible) {
      mergeGameEntities(db, entityId, strongEntity.id, now);
      entityId = strongEntity.id;
    } else if (strongEntity?.id) {
      entityId = strongEntity.id;
    } else if (entityId && !compatible) {
      // One source row changed to a different strong identity while sibling
      // bindings still describe the old game. Split only this binding; never
      // relabel the entire entity or its confirmed collection relationships.
      entityId = allocateGameEntityId(db);
    }
  }

  if (!entityId) entityId = allocateGameEntityId(db);
  let createdEntityId: string | null = null;
  if (!db.prepare("SELECT 1 FROM game_entities WHERE id=?").get(entityId)) {
    try {
      db.prepare(
        `INSERT INTO game_entities(
          id,strong_key,canonical_title,normalized_title,title_id,official_url,
          platform,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        entityId,
        strongKey,
        game.title,
        game.normalized_title,
        game.title_id,
        game.official_url,
        game.platform,
        game.created_at || now,
        game.updated_at || now,
      );
      createdEntityId = entityId;
    } catch (error) {
      const concurrentStrongEntity = strongKey
        ? (db.prepare("SELECT id FROM game_entities WHERE strong_key=?").get(strongKey) as
            | { id: string }
            | undefined)
        : undefined;
      if (!concurrentStrongEntity?.id) throw error;
      entityId = concurrentStrongEntity.id;
    }
  }

  const splitFromEntityId =
    existingEntityId &&
    existingEntityId !== entityId &&
    db.prepare("SELECT 1 FROM game_entities WHERE id=?").get(existingEntityId)
      ? existingEntityId
      : null;

  if (existingEntityId && existingEntityId !== entityId) {
    db.prepare(
      `UPDATE source_bindings SET entity_id=?,source=?,external_id=?,updated_at=?
       WHERE play_game_id=?`,
    ).run(entityId, game.source, game.external_id, now, playGameId);
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO source_bindings(
        id,entity_id,play_game_id,source,external_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run(
      `source-binding:${playGameId}`,
      entityId,
      playGameId,
      game.source,
      game.external_id,
      game.created_at || now,
      now,
    );
    const claimed = db
      .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id=?")
      .get(playGameId) as { entity_id: string } | undefined;
    if (!claimed?.entity_id) {
      if (createdEntityId) deleteOrphanEntity(db, createdEntityId);
      throw new Error("SOURCE_BINDING_IDENTITY_CONFLICT");
    }
    if (claimed.entity_id !== entityId) {
      const unclaimedEntityId = entityId;
      entityId = claimed.entity_id;
      if (createdEntityId === unclaimedEntityId) deleteOrphanEntity(db, unclaimedEntityId);
    }
    db.prepare(
      `UPDATE source_bindings SET source=?,external_id=?,updated_at=?
       WHERE play_game_id=?`,
    ).run(game.source, game.external_id, now, playGameId);
  }

  if (splitFromEntityId) {
    refreshGameEntityMetadata(db, splitFromEntityId, now);
    refreshGameEntityMetadata(db, entityId, now);
    syncLegacyPurchaseLinksForEntity(db, splitFromEntityId);
    if (db.prepare("SELECT 1 FROM game_entity_purchase_links WHERE entity_id=?").get(entityId))
      syncLegacyPurchaseLinksForEntity(db, entityId);
    else db.prepare("DELETE FROM play_purchase_links WHERE play_game_id=?").run(playGameId);
    deleteOrphanEntity(db, splitFromEntityId);
    return entityId;
  }

  if (existingEntityId && existingEntityId !== entityId) deleteOrphanEntity(db, existingEntityId);
  refreshGameEntityMetadata(db, entityId, now);
  ensureEntityPurchaseLinkFromLegacy(db, entityId);
  syncLegacyPurchaseLinksForEntity(db, entityId);
  return entityId;
}

export function resolveGameEntityId(db: EntityDatabase, id: string) {
  const direct = db.prepare("SELECT id FROM game_entities WHERE id=?").get(id) as
    | { id: string }
    | undefined;
  if (direct?.id) return direct.id;
  const binding = db
    .prepare("SELECT entity_id FROM source_bindings WHERE play_game_id=?")
    .get(id) as { entity_id: string } | undefined;
  if (binding?.entity_id) return binding.entity_id;
  const alias = db.prepare("SELECT entity_id FROM game_entity_aliases WHERE alias_id=?").get(id) as
    | { entity_id: string }
    | undefined;
  return alias?.entity_id || null;
}

export function representativePlayGameId(db: EntityDatabase, entityId: string) {
  const row = db
    .prepare(
      `SELECT g.id FROM source_bindings b
       JOIN play_games g ON g.id=b.play_game_id
       WHERE b.entity_id=?
       ORDER BY CASE g.source
         WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
         WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
         g.updated_at DESC,g.id ASC LIMIT 1`,
    )
    .get(entityId) as { id: string } | undefined;
  return row?.id || null;
}

export function upsertGameEntityPurchaseLink(
  db: EntityDatabase,
  input: Omit<EntityLinkRow, "entity_id" | "created_at"> & {
    entityId: string;
    createdAt?: string;
  },
) {
  const existing = db
    .prepare("SELECT created_at FROM game_entity_purchase_links WHERE entity_id=?")
    .get(input.entityId) as { created_at: string } | undefined;
  db.prepare(
    `INSERT INTO game_entity_purchase_links(
      id,entity_id,purchase_record_id,status,match_method,confidence,
      decided_at,decided_by,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(entity_id) DO UPDATE SET
      purchase_record_id=excluded.purchase_record_id,status=excluded.status,
      match_method=excluded.match_method,confidence=excluded.confidence,
      decided_at=excluded.decided_at,decided_by=excluded.decided_by,
      updated_at=excluded.updated_at`,
  ).run(
    `game-entity-purchase-link:${input.entityId}`,
    input.entityId,
    input.purchase_record_id,
    input.status,
    input.match_method,
    input.confidence,
    input.decided_at,
    input.decided_by,
    existing?.created_at || input.createdAt || input.updated_at,
    input.updated_at,
  );
  if (input.status === "confirmed" && input.purchase_record_id)
    db.prepare(
      `INSERT INTO game_entity_acquisitions(
        id,entity_id,purchase_record_id,linked_at,linked_by
      ) VALUES(?,?,?,?,?)
      ON CONFLICT(entity_id,purchase_record_id) DO UPDATE SET
        linked_at=CASE WHEN excluded.linked_at > game_entity_acquisitions.linked_at
          THEN excluded.linked_at ELSE game_entity_acquisitions.linked_at END,
        linked_by=COALESCE(excluded.linked_by,game_entity_acquisitions.linked_by)`,
    ).run(
      `game-entity-acquisition:${input.entityId}:${input.purchase_record_id}`,
      input.entityId,
      input.purchase_record_id,
      input.decided_at || input.updated_at,
      input.decided_by,
    );
  syncLegacyPurchaseLinksForEntity(db, input.entityId);
}

export function syncLegacyPurchaseLinksForEntity(db: EntityDatabase, entityId: string) {
  const link = db
    .prepare(
      `SELECT entity_id,purchase_record_id,status,match_method,confidence,decided_at,
        decided_by,created_at,updated_at
       FROM game_entity_purchase_links WHERE entity_id=?`,
    )
    .get(entityId) as EntityLinkRow | undefined;
  if (!link) return;
  const bindings = db
    .prepare("SELECT play_game_id FROM source_bindings WHERE entity_id=? ORDER BY play_game_id")
    .all(entityId) as Array<{ play_game_id: string }>;
  const statement = db.prepare(
    `INSERT INTO play_purchase_links(
      id,play_game_id,purchase_record_id,status,match_method,confidence,
      decided_at,decided_by,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(play_game_id) DO UPDATE SET
      purchase_record_id=excluded.purchase_record_id,status=excluded.status,
      match_method=excluded.match_method,confidence=excluded.confidence,
      decided_at=excluded.decided_at,decided_by=excluded.decided_by,
      updated_at=excluded.updated_at`,
  );
  for (const binding of bindings)
    statement.run(
      `entity-link-projection:${binding.play_game_id}`,
      binding.play_game_id,
      link.purchase_record_id,
      link.status,
      link.match_method,
      link.confidence,
      link.decided_at,
      link.decided_by,
      link.created_at,
      link.updated_at,
    );
}

function ensureEntityPurchaseLinkFromLegacy(db: EntityDatabase, entityId: string) {
  if (db.prepare("SELECT 1 FROM game_entity_purchase_links WHERE entity_id=?").get(entityId))
    return;
  const link = db
    .prepare(
      `SELECT ? AS entity_id,l.purchase_record_id,l.status,l.match_method,l.confidence,
        l.decided_at,l.decided_by,l.created_at,l.updated_at
       FROM source_bindings b
       JOIN play_purchase_links l ON l.play_game_id=b.play_game_id
       WHERE b.entity_id=?
       ORDER BY CASE WHEN l.match_method='manual' THEN 1 ELSE 0 END DESC,
         CASE l.status WHEN 'confirmed' THEN 3 WHEN 'rejected' THEN 2 ELSE 1 END DESC,
         l.updated_at DESC,l.id ASC LIMIT 1`,
    )
    .get(entityId, entityId) as EntityLinkRow | undefined;
  if (!link) return;
  upsertGameEntityPurchaseLink(db, { ...link, entityId });
}

function refreshGameEntityMetadata(db: EntityDatabase, entityId: string, now: string) {
  const identity = gameEntityIdentityFromBindings(db, entityId);
  const game = db
    .prepare(
      `SELECT g.title,g.normalized_title,g.title_id,g.platform,
        (SELECT NULLIF(TRIM(url_game.official_url),'')
         FROM source_bindings url_binding
         JOIN play_games url_game ON url_game.id=url_binding.play_game_id
         WHERE url_binding.entity_id=b.entity_id
           AND length(trim(COALESCE(url_game.official_url,'')))>0
         ORDER BY CASE url_game.source
           WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
           WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
           url_game.updated_at DESC,url_game.id ASC LIMIT 1) AS official_url
       FROM source_bindings b JOIN play_games g ON g.id=b.play_game_id
       WHERE b.entity_id=?
       ORDER BY CASE g.source
         WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
         WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
         g.updated_at DESC,g.id ASC LIMIT 1`,
    )
    .get(entityId) as
    | Omit<PlayGameIdentityRow, "id" | "source" | "external_id" | "created_at" | "updated_at">
    | undefined;
  if (!game) return;
  db.prepare(
    `UPDATE game_entities SET strong_key=?,canonical_title=?,normalized_title=?,
      title_id=?,official_url=?,platform=?,updated_at=? WHERE id=?`,
  ).run(
    identity.strongKey,
    game.title,
    game.normalized_title,
    identity.titleId,
    game.official_url,
    game.platform,
    now,
    entityId,
  );
}

function gameEntityIdentityFromBindings(db: EntityDatabase, entityId: string) {
  const rows = db
    .prepare(
      `SELECT g.title_id,g.platform FROM source_bindings b
       JOIN play_games g ON g.id=b.play_game_id WHERE b.entity_id=?
       ORDER BY CASE g.source
         WHEN 'nintendo_store' THEN 5 WHEN 'moon_connector' THEN 4
         WHEN 'nintendo_connector' THEN 3 WHEN 'json_import' THEN 2 ELSE 1 END DESC,
         g.updated_at DESC,g.id ASC`,
    )
    .all(entityId) as Array<{ title_id: string | null; platform: string }>;
  let selected: { strongKey: string; titleId: string } | null = null;
  for (const row of rows) {
    const strongKey = gameEntityStrongKey(row.title_id, row.platform);
    if (!strongKey) continue;
    if (selected && selected.strongKey !== strongKey)
      throw new Error("GAME_ENTITY_IDENTITY_CONFLICT");
    selected ||= { strongKey, titleId: String(row.title_id).trim() };
  }
  return selected || { strongKey: null, titleId: null };
}

function mergeGameEntities(
  db: EntityDatabase,
  sourceEntityId: string,
  targetEntityId: string,
  now: string,
) {
  if (sourceEntityId === targetEntityId) return;
  db.prepare(
    `INSERT INTO game_entity_acquisitions(
      id,entity_id,purchase_record_id,linked_at,linked_by
    )
    SELECT 'game-entity-acquisition:' || ? || ':' || purchase_record_id,
      ?,purchase_record_id,linked_at,linked_by
    FROM game_entity_acquisitions WHERE entity_id=?
    ON CONFLICT(entity_id,purchase_record_id) DO UPDATE SET
      linked_at=CASE WHEN excluded.linked_at > game_entity_acquisitions.linked_at
        THEN excluded.linked_at ELSE game_entity_acquisitions.linked_at END,
      linked_by=COALESCE(excluded.linked_by,game_entity_acquisitions.linked_by)`,
  ).run(targetEntityId, targetEntityId, sourceEntityId);
  const links = db
    .prepare(
      `SELECT entity_id,purchase_record_id,status,match_method,confidence,decided_at,
        decided_by,created_at,updated_at
       FROM game_entity_purchase_links WHERE entity_id IN (?,?)`,
    )
    .all(sourceEntityId, targetEntityId) as EntityLinkRow[];
  const selected = [...links].sort(compareEntityLinks)[0];
  if (selected)
    upsertGameEntityPurchaseLink(db, {
      ...selected,
      entityId: targetEntityId,
      updated_at: selected.updated_at || now,
    });
  db.prepare("UPDATE source_bindings SET entity_id=?,updated_at=? WHERE entity_id=?").run(
    targetEntityId,
    now,
    sourceEntityId,
  );
  db.prepare("UPDATE game_entity_aliases SET entity_id=?,updated_at=? WHERE entity_id=?").run(
    targetEntityId,
    now,
    sourceEntityId,
  );
  db.prepare("DELETE FROM game_entities WHERE id=?").run(sourceEntityId);
  db.prepare(
    `INSERT INTO game_entity_aliases(alias_id,entity_id,created_at,updated_at)
     VALUES(?,?,?,?)
     ON CONFLICT(alias_id) DO UPDATE SET
       entity_id=excluded.entity_id,updated_at=excluded.updated_at`,
  ).run(sourceEntityId, targetEntityId, now, now);
  refreshGameEntityMetadata(db, targetEntityId, now);
  syncLegacyPurchaseLinksForEntity(db, targetEntityId);
}

function allocateGameEntityId(db: EntityDatabase) {
  // Public IDs must survive mutable source rows and matching keys. Keep the
  // direct-ID and alias namespaces disjoint so resolution is never ambiguous.
  for (let attempt = 0; attempt < GAME_ENTITY_ID_ATTEMPTS; attempt += 1) {
    const entityId = `game-entity:${randomUUID()}`;
    const collision = db
      .prepare(
        `SELECT EXISTS(
          SELECT 1 FROM game_entities WHERE id=?
          UNION ALL
          SELECT 1 FROM game_entity_aliases WHERE alias_id=?
        ) AS occupied`,
      )
      .get(entityId, entityId) as { occupied: number } | undefined;
    if (!collision?.occupied) return entityId;
  }
  throw new Error("GAME_ENTITY_ID_ALLOCATION_FAILED");
}

function compareEntityLinks(left: EntityLinkRow, right: EntityLinkRow) {
  const method = Number(right.match_method === "manual") - Number(left.match_method === "manual");
  if (method) return method;
  const rank = { suggested: 1, rejected: 2, confirmed: 3 } as const;
  const status = rank[right.status] - rank[left.status];
  if (status) return status;
  const updatedAt = right.updated_at.localeCompare(left.updated_at);
  if (updatedAt) return updatedAt;
  // Exact decision ties must not inherit SQLite's insertion/scan order.
  // Prefer the lexicographically smaller entity ID, then purchase ID.
  const entityId = left.entity_id.localeCompare(right.entity_id);
  if (entityId) return entityId;
  return (left.purchase_record_id || "").localeCompare(right.purchase_record_id || "");
}

function deleteOrphanEntity(db: EntityDatabase, entityId: string) {
  if (
    !db.prepare("SELECT 1 FROM source_bindings WHERE entity_id=?").get(entityId) &&
    !db.prepare("SELECT 1 FROM game_entity_purchase_links WHERE entity_id=?").get(entityId) &&
    !db.prepare("SELECT 1 FROM game_entity_acquisitions WHERE entity_id=?").get(entityId)
  )
    db.prepare("DELETE FROM game_entities WHERE id=?").run(entityId);
}

function entityBindingsCompatibleWithStrongKey(
  db: EntityDatabase,
  entityId: string,
  strongKey: string,
) {
  const rows = db
    .prepare(
      `SELECT g.title_id,g.platform FROM source_bindings b
       JOIN play_games g ON g.id=b.play_game_id WHERE b.entity_id=?`,
    )
    .all(entityId) as Array<{ title_id: string | null; platform: string }>;
  return rows.every((row) => {
    const siblingKey = gameEntityStrongKey(row.title_id, row.platform);
    return siblingKey === null || siblingKey === strongKey;
  });
}
