import { backup, DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { chmod, link, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const tables = [
  "ledger_documents",
  "purchase_records",
  "game_entities",
  "play_games",
  "moon_connector_reports",
  "nintendo_store_sync_snapshots",
  "nintendo_store_daily_history",
];

function absolutePath(path) {
  if (!path || !isAbsolute(path)) throw new Error("请使用明确的绝对路径");
  return path;
}

function preventRepositoryOutput(path) {
  const root = process.cwd();
  if (path === root || path.startsWith(`${root}${sep}`))
    throw new Error("备份和恢复文件必须放在仓库以外的私有目录");
}

function verify(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const identity = db
      .prepare("SELECT value FROM app_metadata WHERE key='database_identity'")
      .get();
    const version = db.prepare("SELECT value FROM app_metadata WHERE key='schema_version'").get();
    if (identity?.value !== "gamenote-ns2" || version?.value !== "6")
      throw new Error("数据库身份或 schema v6 不匹配");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("SQLite integrity_check 未通过");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("SQLite foreign_key_check 未通过");
    const counts = Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      ]),
    );
    return counts;
  } finally {
    db.close();
  }
}

async function checkSource(file) {
  if (!(await stat(file)).isFile()) throw new Error("来源不是普通文件");
  return verify(file);
}

async function doBackup(source, output) {
  if (typeof backup !== "function")
    throw new Error("在线备份需要 Node.js >=22.16.0；当前运行时不支持 node:sqlite backup");
  await checkSource(source);
  if (source === output) throw new Error("来源与目标不能相同");
  preventRepositoryOutput(output);
  if (!(await stat(dirname(output))).isDirectory()) throw new Error("备份目录不存在");
  // Work in a private sibling directory. link() publishes the verified backup
  // atomically and refuses to overwrite even if the destination appeared meanwhile.
  const temporaryDir = await mkdtemp(join(dirname(output), ".ns2-backup-"));
  const temporary = join(temporaryDir, "ns2.sqlite");
  try {
    await chmod(temporaryDir, 0o700);
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, temporary);
    } finally {
      db.close();
    }
    await chmod(temporary, 0o600);
    const counts = verify(temporary);
    await link(temporary, output);
    return counts;
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function doRestore(source, output) {
  const counts = await checkSource(source);
  if (source === output) throw new Error("来源与目标不能相同");
  preventRepositoryOutput(output);
  const target = await open(output, "wx", 0o600);
  try {
    await pipeline(createReadStream(source), target.createWriteStream());
    verify(output);
    return counts;
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await target.close();
  }
}

async function main() {
  const [action, sourceArg, outputArg, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !["backup", "verify", "restore"].includes(action) ||
    !sourceArg ||
    (action === "verify" ? outputArg : !outputArg)
  )
    throw new Error(
      "用法: ns2-backup.mjs backup <数据库绝对路径> <新备份绝对路径> | verify <备份绝对路径> | restore <备份绝对路径> <不存在的新文件绝对路径>",
    );
  const source = absolutePath(sourceArg);
  const counts =
    action === "backup"
      ? await doBackup(source, absolutePath(outputArg))
      : action === "restore"
        ? await doRestore(source, absolutePath(outputArg))
        : await checkSource(source);
  console.log(JSON.stringify({ action, status: "ok", counts }));
}

main().catch((error) => {
  console.error(`NS2 ${process.argv[2] || "backup"} failed: ${error.message}`);
  process.exitCode = 1;
});
