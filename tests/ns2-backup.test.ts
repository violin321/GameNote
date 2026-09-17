import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve();
const temporary: string[] = [];

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env, NODE_ENV: "test" },
  });
}

afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("NS2 full SQLite backup", () => {
  it("backs up live WAL state, verifies, and restores to a new private file without overwrites", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gamenote-backup-test-"));
    temporary.push(directory);
    const database = join(directory, "ns2.sqlite");
    const snapshot = join(directory, "snapshot.sqlite");
    const restored = join(directory, "restored.sqlite");
    expect(run("migrate-play-history.mjs", [], { APP_DATABASE_FILE: database }).status).toBe(0);
    const writer = new DatabaseSync(database);
    try {
      writer.exec("PRAGMA journal_mode=WAL");
      writer
        .prepare("INSERT INTO ledger_documents(id,records,updated_at) VALUES('default','[]',?)")
        .run(new Date().toISOString());
      const backup = run("ns2-backup.mjs", ["backup", database, snapshot]);
      expect(backup.status, backup.stderr).toBe(0);
      expect(JSON.parse(backup.stdout).counts.ledger_documents).toBe(1);
      expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
      expect(run("ns2-backup.mjs", ["verify", snapshot]).status).toBe(0);
      writer.prepare("DELETE FROM ledger_documents WHERE id='default'").run();
      const restore = run("ns2-backup.mjs", ["restore", snapshot, restored]);
      expect(restore.status, restore.stderr).toBe(0);
      expect((await stat(restored)).mode & 0o777).toBe(0o600);
      const db = new DatabaseSync(restored, { readOnly: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM ledger_documents").get()).toEqual({
        count: 1,
      });
      db.close();
      expect(run("ns2-backup.mjs", ["restore", snapshot, restored]).status).not.toBe(0);
      expect(run("ns2-backup.mjs", ["backup", database, snapshot]).status).not.toBe(0);
      expect((await readFile(restored)).byteLength).toBeGreaterThan(0);
    } finally {
      writer.close();
    }
  });

  it("rejects a foreign/corrupt database before creating an output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gamenote-backup-test-"));
    temporary.push(directory);
    const foreign = join(directory, "foreign.sqlite");
    const output = join(directory, "output.sqlite");
    await writeFile(foreign, "not a sqlite database");
    expect(run("ns2-backup.mjs", ["backup", foreign, output]).status).not.toBe(0);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
