import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importNintendoSnapshot, nintendoSnapshotToImportPayload } from "../lib/nintendo/import";
import type { NintendoSnapshot } from "../lib/nintendo/types";
import {
  getPlayTableCounts,
  listPlayGames,
  migratePlayDatabase,
} from "../lib/play-history/repository";
import { writeLedgerToSqlite } from "../lib/ledger/repository";

let directory = "";
let fixture: NintendoSnapshot;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-nintendo-import-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  await migratePlayDatabase();
  fixture = JSON.parse(
    await readFile("tests/fixtures/nintendo-coral34-snapshot.json", "utf8"),
  ) as NintendoSnapshot;
});
afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(directory, { recursive: true, force: true });
});

describe("Nintendo snapshot import bridge", () => {
  it("imports the official Coral Game shape as an idempotent observation", async () => {
    await expect(importNintendoSnapshot(fixture)).resolves.toMatchObject({
      replayed: false,
      insertedGames: 1,
      insertedSessions: 0,
      insertedObservations: 1,
      dataSource: {
        provider: "Nintendo Coral",
        coralVersion: "3.4.0",
      },
    });
    await expect(importNintendoSnapshot(fixture)).resolves.toMatchObject({
      replayed: true,
      insertedGames: 0,
      insertedSessions: 0,
      insertedObservations: 0,
    });
    expect(await getPlayTableCounts()).toMatchObject({
      import_batches: 1,
      play_games: 1,
      play_sessions: 0,
      play_observations: 1,
    });
    const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
    expect(db.prepare("SELECT source FROM play_games").get()).toEqual({
      source: "nintendo_connector",
    });
    expect(db.prepare("SELECT observed_at, total_seconds FROM play_observations").get()).toEqual({
      observed_at: fixture.capturedAt,
      total_seconds: 7200,
    });
    expect(db.prepare("SELECT external_id FROM play_games").get()).toEqual({
      external_id: expect.stringMatching(/^nintendo:url:[a-f0-9]{40}$/),
    });
    db.close();
  });

  it("imports PlayLog when Presence is empty and preserves purchase association", async () => {
    expect(fixture.presence).toEqual([]);
    await writeLedgerToSqlite({
      version: 1,
      updatedAt: new Date().toISOString(),
      records: [
        {
          id: "purchase-fixture",
          title: "Fixture Game",
          platform: "Nintendo Switch",
          price: 0,
          currency: "CNY",
          purchaseDate: "2026-08-24",
          region: "港版",
          format: "数字版",
          seller: "",
          coverUrl: "",
          officialUrl: "",
          notes: "",
          soldDate: "",
          soldPrice: 0,
          soldCurrency: "CNY",
        },
      ],
    });
    await importNintendoSnapshot(fixture);
    expect((await listPlayGames("recent", "desc", "Fixture"))[0]).toMatchObject({
      sessionCount: 0,
      totalSeconds: 7200,
      link: {
        status: "suggested",
        method: "normalized_title",
        purchaseRecordId: "purchase-fixture",
      },
    });
  });

  it("does not infer PlayLog from Presence", () => {
    const withoutPlayLog = structuredClone(fixture);
    withoutPlayLog.currentUser = { playLog: [] };
    withoutPlayLog.presence = [{ state: "PLAYING", game: { name: "must-not-import" } }];
    expect(nintendoSnapshotToImportPayload(withoutPlayLog)).toEqual({ version: 1, games: [] });
  });

  it("uses a deterministic content hash when Coral provides no stable ID or shop URI", () => {
    const withoutStableFields = structuredClone(fixture);
    delete withoutStableFields.currentUser!.playLog![0].officialUrl;
    const first = nintendoSnapshotToImportPayload(withoutStableFields);
    const second = nintendoSnapshotToImportPayload(structuredClone(withoutStableFields));
    expect(first).toEqual(second);
    expect(first.games[0]).toMatchObject({
      externalId: expect.stringMatching(/^nintendo:content-v1:[a-f0-9]{40}$/),
      titleId: "",
      sessions: [],
      observations: [
        {
          observedAt: fixture.capturedAt,
          totalSeconds: 7200,
          firstPlayedAt: "2026-08-23T15:46:40.000Z",
        },
      ],
    });
  });

  it("commits a later aggregate observation without inventing a play session", async () => {
    await importNintendoSnapshot(fixture);
    const later = structuredClone(fixture);
    later.capturedAt = "2026-08-25T15:00:00.000Z";
    later.currentUser!.playLog![0].totalPlayTime = 180;
    await importNintendoSnapshot(later);
    expect(await getPlayTableCounts()).toMatchObject({
      import_batches: 2,
      play_games: 1,
      play_sessions: 0,
      play_observations: 2,
    });
    expect((await listPlayGames("recent", "desc", "Fixture"))[0]).toMatchObject({
      totalSeconds: 10_800,
      sessionCount: 0,
      // A cumulative observation time is a fetch timestamp, not a locatable
      // play event. It must not masquerade as the game's latest activity.
      lastPlayedAt: "",
    });
    await expect(importNintendoSnapshot(later)).resolves.toMatchObject({
      replayed: true,
      insertedObservations: 0,
    });
  });
});
