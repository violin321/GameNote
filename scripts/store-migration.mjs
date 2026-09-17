/** Widen play_games.source to include Nintendo Store snapshots. */
export function widenStoreGameSource(db) {
  if (Number(db.prepare("PRAGMA foreign_keys").get().foreign_keys) !== 0)
    throw new Error("Store migration requires foreign_keys OFF before its transaction");
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='play_games'")
    .get()?.sql;
  if (typeof schema !== "string") throw new Error("play_games schema is missing");
  if (schema.includes("'nintendo_store'")) return;

  const sourceCheck = /CHECK\s*\(\s*source\s+IN\s*\(([^)]*)\)\s*\)/i;
  const sourceValues = schema.match(sourceCheck)?.[1];
  if (!sourceValues || !sourceValues.includes("'moon_connector'"))
    throw new Error("play_games source constraint is incompatible");
  const tablePrefix =
    /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"play_games"|`play_games`|\[play_games\]|play_games)\s*\(/i;
  if (!tablePrefix.test(schema)) throw new Error("play_games table declaration is not recognized");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='play_games_store_v4'").get())
    throw new Error("Store migration temporary table already exists");

  const replacement = schema
    .replace(sourceCheck, `CHECK(source IN (${sourceValues},'nintendo_store'))`)
    .replace(tablePrefix, 'CREATE TABLE "play_games_store_v4" (');
  const secondary = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name='play_games' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
    )
    .all();
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('play_games')")
    .all()
    .map(({ name }) => `"${String(name).replaceAll('"', '""')}"`)
    .join(",");
  if (!columns) throw new Error("play_games columns are missing");

  db.exec(replacement);
  db.exec(`INSERT INTO play_games_store_v4 (${columns}) SELECT ${columns} FROM play_games`);
  db.exec("DROP TABLE play_games; ALTER TABLE play_games_store_v4 RENAME TO play_games");
  for (const item of secondary) if (typeof item.sql === "string") db.exec(item.sql);
}
