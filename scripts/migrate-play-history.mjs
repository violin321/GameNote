import { readFile, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerPurchaseProjectionSqlFunctions } from "./purchase-projection-json.mjs";
import { widenMoonGameSource } from "./moon-migration.mjs";
import { widenStoreGameSource } from "./store-migration.mjs";

const configured = process.env.APP_DATABASE_FILE?.trim();
if (process.env.NODE_ENV === "production" && !configured)
  throw new Error("APP_DATABASE_FILE is required in production");
const file = configured || "data/ns2.sqlite";
if (basename(file).toLowerCase() === "records.sqlite")
  throw new Error("legacy records.sqlite is forbidden for NS2");
if (basename(file).toLowerCase() !== "ns2.sqlite")
  throw new Error("NS2 database path must end in ns2.sqlite");
if (process.env.NODE_ENV === "production") {
  if (process.env.GAMENOTE_LOCAL_RUNTIME === "1") {
    if (!isAbsolute(file))
      throw new Error("APP_DATABASE_FILE must be absolute for the local runtime");
  } else if (file !== "/data/ns2.sqlite")
    throw new Error("APP_DATABASE_FILE must be /data/ns2.sqlite in production");
}

await mkdir(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
registerPurchaseProjectionSqlFunctions(db);
const migrations = [
  [1, "play_history", "001_play_history.sql"],
  [2, "purchase_projection", "002_purchase_projection.sql"],
  [3, "moon_connector", "003_moon_connector.sql"],
  [4, "nintendo_store", "004_nintendo_store.sql"],
  [5, "nintendo_store_history", "005_nintendo_store_history.sql"],
  [6, "game_entities", "006_game_entities.sql"],
];
try {
  db.exec("PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  try {
    const existingTables = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .get().count,
    );
    if (existingTables > 0) {
      let identity;
      let version;
      try {
        identity = db
          .prepare("SELECT value FROM app_metadata WHERE key='database_identity'")
          .get()?.value;
        version = Number(
          db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get()?.value,
        );
      } catch {
        throw new Error("existing database has no NS2 identity marker");
      }
      if (identity !== "gamenote-ns2" || !Number.isInteger(version) || version < 1 || version > 6)
        throw new Error("existing database has an incompatible NS2 identity marker/version");
    }
    for (const [version, name, sqlFile] of migrations) {
      const alreadyApplied = existingTables
        ? db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)
        : false;
      if (alreadyApplied) {
        if (version === 6)
          db.exec(
            await readFile(
              resolve(process.cwd(), "migrations", "006_game_entities.reconcile.sql"),
              "utf8",
            ),
          );
        continue;
      }
      const projectionColumns =
        version === 2
          ? new Set(
              db
                .prepare("SELECT name FROM pragma_table_info('purchase_records')")
                .all()
                .map((row) => row.name),
            )
          : null;
      const projectionAlreadyPresent =
        projectionColumns &&
        [
          "source_updated_at",
          "projection_hash",
          "deleted_at",
          "platform_family",
          "platform_variant",
          "cover_url",
          "purchase_date",
          "source_document_id",
        ].every((column) => projectionColumns.has(column));
      if (projectionAlreadyPresent)
        db.exec(
          await readFile(
            resolve(process.cwd(), "migrations", "002_purchase_projection.reconcile.sql"),
            "utf8",
          ),
        );
      else {
        if (version === 3) widenMoonGameSource(db);
        if (version === 4) widenStoreGameSource(db);
        db.exec(await readFile(resolve(process.cwd(), "migrations", sqlFile), "utf8"));
      }
      db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(
        version,
        name,
        new Date().toISOString(),
      );
      if (version === 6)
        db.exec(
          await readFile(
            resolve(process.cwd(), "migrations", "006_game_entities.reconcile.sql"),
            "utf8",
          ),
        );
    }
    db.prepare("UPDATE app_metadata SET value='6' WHERE key='schema_version'").run();
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("NS2 migration would leave invalid foreign keys");
    const identity = db
      .prepare("SELECT value FROM app_metadata WHERE key='database_identity'")
      .get()?.value;
    const version = db
      .prepare("SELECT value FROM app_metadata WHERE key='schema_version'")
      .get()?.value;
    if (identity !== "gamenote-ns2" || version !== "6")
      throw new Error("NS2 database marker/version mismatch");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db.exec("PRAGMA foreign_keys=ON");
  db.close();
}
console.log("NS2 database migration complete (schema v6)");
