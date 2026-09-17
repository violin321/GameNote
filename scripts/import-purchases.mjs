import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/import-purchases.mjs <export.json>");
const sourceBuffer = await readFile(source);
const payload = JSON.parse(sourceBuffer.toString("utf8"));
if (payload.version !== 1 || !Array.isArray(payload.records))
  throw new Error("invalid purchase export schema");

const configured = process.env.APP_DATABASE_FILE?.trim();
if (process.env.NODE_ENV === "production" && !configured)
  throw new Error("APP_DATABASE_FILE is required in production");
const file = configured || "data/ns2.sqlite";
if (basename(file).toLowerCase() === "records.sqlite")
  throw new Error("legacy records.sqlite is forbidden for NS2");
if (basename(file).toLowerCase() !== "ns2.sqlite")
  throw new Error("NS2 database path must end in ns2.sqlite");
if (process.env.NODE_ENV === "production" && file !== "/data/ns2.sqlite")
  throw new Error("APP_DATABASE_FILE must be /data/ns2.sqlite in production");

const records = payload.records.flatMap((value) => {
  if (!value || typeof value !== "object" || typeof value.title !== "string") return [];
  const title = value.title.trim().slice(0, 200);
  if (!title) return [];
  return [
    { ...value, id: typeof value.id === "string" && value.id ? value.id : randomUUID(), title },
  ];
});
const db = new DatabaseSync(file);
try {
  const marker = db
    .prepare("SELECT value FROM app_metadata WHERE key='database_identity'")
    .get()?.value;
  const schemaVersion = db
    .prepare("SELECT value FROM app_metadata WHERE key='schema_version'")
    .get()?.value;
  if (marker !== "gamenote-ns2" || schemaVersion !== "1")
    throw new Error("purchase import is allowed only for a marked NS2 schema-v1 database");

  db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO ledger_documents(id,records,updated_at) VALUES('default',?,?)
       ON CONFLICT(id) DO UPDATE SET records=excluded.records,updated_at=excluded.updated_at`,
    ).run(JSON.stringify(records), payload.exportedAt || new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db.close();
}
console.log(
  JSON.stringify({
    imported: records.length,
    sourceSha256: createHash("sha256").update(sourceBuffer).digest("hex"),
  }),
);
