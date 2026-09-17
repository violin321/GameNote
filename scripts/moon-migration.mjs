/**
 * SQLite cannot alter a CHECK in place. Call only with foreign_keys OFF before
 * BEGIN IMMEDIATE, then foreign_key_check before COMMIT and restore FK checking.
 * Never rename the old parent: that would rewrite child FK targets. Copy the
 * actual columns, indexes and triggers so local extensions are not discarded.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Older NS2 deployments used v3 for Moon artifacts without this connector schema. */
export async function reconcileLegacyMoonV3(db) {
  const marker = db.prepare("SELECT name FROM schema_migrations WHERE version=3").get()?.name;
  if (marker !== "moon_artifact_v1") return;

  // Both operations are idempotent and run inside the caller's transaction.
  // The connector tables deliberately do not collide with legacy moon_* data.
  widenMoonGameSource(db);
  db.exec(await readFile(resolve(process.cwd(), "migrations", "003_moon_connector.sql"), "utf8"));
}

export function widenMoonGameSource(db) {
  if (Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 0)
    throw new Error("Moon migration requires foreign_keys OFF before its transaction");
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='play_games'")
    .get()?.sql;
  if (typeof schema !== "string") throw new Error("play_games schema is missing");
  const sourceCheck = /CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i;
  const sourceValues = schema.match(sourceCheck)?.[1];
  if (!sourceValues) throw new Error("play_games source constraint is not recognized");
  if (sourceValues.includes("'moon_connector'")) return;
  if (!sourceValues.includes("'nintendo_connector'"))
    throw new Error("play_games source constraint is incompatible");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='play_games_moon_v3'").get())
    throw new Error("Moon migration temporary table already exists");
  const tablePrefix =
    /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"play_games"|`play_games`|\[play_games\]|play_games)\s*\(/i;
  if (!tablePrefix.test(schema)) throw new Error("play_games table declaration is not recognized");
  const replacement = schema
    .replace(sourceCheck, `CHECK(source IN (${sourceValues},'moon_connector'))`)
    .replace(tablePrefix, 'CREATE TABLE "play_games_moon_v3" (');
  const secondary = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name='play_games' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all();
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('play_games')")
    .all()
    .map(({ name }) => `"${String(name).replaceAll('"', '""')}"`)
    .join(",");
  db.exec(replacement);
  db.exec(`INSERT INTO play_games_moon_v3 (${columns}) SELECT ${columns} FROM play_games`);
  db.exec("DROP TABLE play_games; ALTER TABLE play_games_moon_v3 RENAME TO play_games");
  for (const item of secondary) db.exec(item.sql);
}
