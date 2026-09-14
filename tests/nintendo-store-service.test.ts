import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  authorizeNintendoStore,
  callbackNintendoStore,
  readNintendoStoreStatus,
  syncNintendoStore,
  type StoreCollectResult,
} from "../lib/nintendo-store/service";
import {
  listPlayGames,
  listRecentSessions,
  migratePlayDatabase,
} from "../lib/play-history/repository";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "gamenote-store-service-"));
  process.env.APP_DATABASE_FILE = join(directory, "ns2.sqlite");
  process.env.NINTENDO_STORE_DATA_DIR = join(directory, "store-private");
  await migratePlayDatabase();
  await connectStore();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  delete process.env.NINTENDO_STORE_DATA_DIR;
  await rm(directory, { recursive: true, force: true });
});

async function connectStore() {
  const authorization = await authorizeNintendoStore(Date.now(), process.env);
  const state = new URL(authorization.authorizationUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  await callbackNintendoStore(
    `npf5c38e31cd085304b://auth#session_token_code=fixture-code&state=${state}`,
    {
      environment: process.env,
      client: {
        exchangeCode: async () => "fixture-session-token",
        collect: async () => ({ history: { playHistories: [] } }),
      },
    },
  );
}

function storeResult(
  playHistories: StoreCollectResult["history"]["playHistories"],
  recentPlayHistories?: StoreCollectResult["history"]["recentPlayHistories"],
  lastUpdatedAt?: string,
): StoreCollectResult {
  return {
    history: { playHistories, recentPlayHistories, lastUpdatedAt },
    authentication: "access_token",
  };
}

function withDatabase<T>(run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(process.env.APP_DATABASE_FILE!);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    return run(db);
  } finally {
    db.close();
  }
}

describe("Nintendo Store cumulative import", () => {
  it("stores a cumulative total, replaces decreases, and preserves known dates", async () => {
    const first = await syncNintendoStore({
      environment: process.env,
      now: () => "2026-09-12T05:00:00.000Z",
      client: {
        collect: async () =>
          storeResult(
            [
              {
                titleId: "01006F8002326000",
                titleName: "Animal Crossing: New Horizons",
                platform: "BEE",
                imageUrl: "https://example.test/ac.png",
                firstPlayedAt: "2026-01-01T00:00:00.000Z",
                lastPlayedAt: "2026-09-10T17:25:47.000Z",
                totalPlayedMinutes: 2020,
                totalPlayedDays: 24,
              },
              { titleId: "missing-duration", titleName: "Skipped" },
            ],
            {
              days: [
                {
                  playedDate: "2026-09-10",
                  dailyPlayHistories: [
                    {
                      titleId: "01006F8002326000",
                      titleName: "Animal Crossing: New Horizons",
                      totalPlayedMinutes: 90,
                    },
                  ],
                },
                {
                  playedDate: "2026-09-11",
                  dailyPlayHistories: [
                    {
                      titleId: "01006F8002326000",
                      titleName: "Animal Crossing: New Horizons",
                      totalPlayedMinutes: 30,
                    },
                  ],
                },
              ],
            },
            "2026-09-12T04:30:00Z",
          ),
      },
    });
    expect(first).toMatchObject({
      count: 1,
      skipped: 1,
      titleCount: 1,
      dailyCount: 2,
      skippedDaily: 0,
      fetchedAt: "2026-09-12T05:00:00.000Z",
    });
    expect((await listPlayGames("total", "desc", "Animal Crossing"))[0]).toMatchObject({
      source: "nintendo_store",
      platform: "Nintendo Switch",
      totalSeconds: 2020 * 60,
      playDays: 24,
      firstPlayedAt: "2026-01-01T00:00:00.000Z",
      lastPlayedAt: "2026-09-10T17:25:47.000Z",
    });
    withDatabase((db) => {
      expect(
        db
          .prepare("SELECT platform,time_semantics FROM play_games WHERE source='nintendo_store'")
          .get(),
      ).toEqual({ platform: "BEE", time_semantics: "snapshot_observation" });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM play_sessions WHERE source='nintendo_store'")
          .get(),
      ).toEqual({ count: 0 });
    });

    await syncNintendoStore({
      environment: process.env,
      now: () => "2026-09-13T05:00:00.000Z",
      client: {
        collect: async () =>
          storeResult(
            [
              {
                titleId: "01006f8002326000",
                titleName: "Animal Crossing: New Horizons",
                platform: "Nintendo Switch 2",
                totalPlayedMinutes: 20,
                totalPlayedDays: 2,
              },
            ],
            {
              days: [
                {
                  playedDate: "2026-09-11",
                  dailyPlayHistories: [
                    {
                      titleId: "01006f8002326000",
                      titleName: "Animal Crossing: New Horizons",
                      totalPlayedMinutes: 35,
                    },
                  ],
                },
              ],
            },
          ),
      },
    });
    const games = await listPlayGames("total", "desc", "Animal Crossing");
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      totalSeconds: 1200,
      playDays: 2,
      firstPlayedAt: "2026-01-01T00:00:00.000Z",
      lastPlayedAt: "2026-09-10T17:25:47.000Z",
    });
    withDatabase((db) => {
      expect(
        db
          .prepare(
            `SELECT fetched_at,upstream_updated_at,imported_title_count,skipped_title_count,
              imported_daily_count FROM nintendo_store_sync_snapshots ORDER BY fetched_at`,
          )
          .all(),
      ).toEqual([
        {
          fetched_at: "2026-09-12T05:00:00.000Z",
          upstream_updated_at: "2026-09-12T04:30:00.000Z",
          imported_title_count: 1,
          skipped_title_count: 1,
          imported_daily_count: 2,
        },
        {
          fetched_at: "2026-09-13T05:00:00.000Z",
          upstream_updated_at: null,
          imported_title_count: 1,
          skipped_title_count: 0,
          imported_daily_count: 1,
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT s.fetched_at,g.total_seconds,g.play_days,g.time_semantics
             FROM nintendo_store_game_snapshots g
             JOIN nintendo_store_sync_snapshots s ON s.id=g.snapshot_id ORDER BY s.fetched_at`,
          )
          .all(),
      ).toEqual([
        {
          fetched_at: "2026-09-12T05:00:00.000Z",
          total_seconds: 121_200,
          play_days: 24,
          time_semantics: "snapshot_observation",
        },
        {
          fetched_at: "2026-09-13T05:00:00.000Z",
          total_seconds: 1_200,
          play_days: 2,
          time_semantics: "snapshot_observation",
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT s.fetched_at,d.official_date,d.total_seconds,d.time_semantics
             FROM nintendo_store_daily_snapshots d
             JOIN nintendo_store_sync_snapshots s ON s.id=d.snapshot_id
             ORDER BY s.fetched_at,d.official_date`,
          )
          .all(),
      ).toEqual([
        {
          fetched_at: "2026-09-12T05:00:00.000Z",
          official_date: "2026-09-10",
          total_seconds: 5_400,
          time_semantics: "daily_aggregate",
        },
        {
          fetched_at: "2026-09-12T05:00:00.000Z",
          official_date: "2026-09-11",
          total_seconds: 1_800,
          time_semantics: "daily_aggregate",
        },
        {
          fetched_at: "2026-09-13T05:00:00.000Z",
          official_date: "2026-09-11",
          total_seconds: 2_100,
          time_semantics: "daily_aggregate",
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT official_date,total_seconds,time_semantics,first_seen_at,last_seen_at
             FROM nintendo_store_daily_history ORDER BY official_date`,
          )
          .all(),
      ).toEqual([
        {
          official_date: "2026-09-10",
          total_seconds: 5_400,
          time_semantics: "daily_aggregate",
          first_seen_at: "2026-09-12T05:00:00.000Z",
          last_seen_at: "2026-09-12T05:00:00.000Z",
        },
        {
          official_date: "2026-09-11",
          total_seconds: 2_100,
          time_semantics: "daily_aggregate",
          first_seen_at: "2026-09-12T05:00:00.000Z",
          last_seen_at: "2026-09-13T05:00:00.000Z",
        },
      ]);
      expect(
        db
          .prepare(
            `SELECT source,source_id,external_id,observed_date,observed_at,total_seconds,
              play_days,time_semantics,report_status,image_url
             FROM play_observations ORDER BY observed_date`,
          )
          .all(),
      ).toEqual([
        {
          source: "nintendo_store",
          source_id: "official-store",
          external_id: "daily:2026-09-10:store:01006f8002326000:switch2",
          observed_date: "2026-09-10",
          observed_at: "2026-09-12T05:00:00.000Z",
          total_seconds: 5_400,
          play_days: 1,
          time_semantics: "daily_aggregate",
          report_status: "",
          image_url: "https://example.test/ac.png",
        },
        {
          source: "nintendo_store",
          source_id: "official-store",
          external_id: "daily:2026-09-11:store:01006f8002326000:switch2",
          observed_date: "2026-09-11",
          observed_at: "2026-09-13T05:00:00.000Z",
          total_seconds: 2_100,
          play_days: 1,
          time_semantics: "daily_aggregate",
          report_status: "",
          image_url: "",
        },
      ]);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM play_sessions WHERE source='nintendo_store'")
          .get(),
      ).toEqual({ count: 0 });
    });

    const recent = await listRecentSessions(7, new Date("2026-09-13T12:00:00.000Z"));
    expect(
      recent.map(({ playedDate, durationSeconds, startedAt, endedAt, timeSemantics, source }) => ({
        playedDate,
        durationSeconds,
        startedAt,
        endedAt,
        timeSemantics,
        source,
      })),
    ).toEqual([
      {
        playedDate: "2026-09-11",
        durationSeconds: 2_100,
        startedAt: null,
        endedAt: null,
        timeSemantics: "daily_aggregate",
        source: "nintendo_store",
      },
      {
        playedDate: "2026-09-10",
        durationSeconds: 5_400,
        startedAt: null,
        endedAt: null,
        timeSemantics: "daily_aggregate",
        source: "nintendo_store",
      },
    ]);
  });

  it("keeps unmatched daily rows in Store audit tables only", async () => {
    await syncNintendoStore({
      environment: process.env,
      now: () => "2026-09-13T05:00:00.000Z",
      client: {
        collect: async () =>
          storeResult([], {
            days: [
              {
                playedDate: "2026-09-12",
                dailyPlayHistories: [
                  {
                    titleId: "0100UNMATCHED",
                    titleName: "Unmatched Store title",
                    totalPlayedMinutes: 15,
                  },
                ],
              },
            ],
          }),
      },
    });

    withDatabase((db) => {
      expect(
        db
          .prepare(
            `SELECT official_date,play_game_id,total_seconds
             FROM nintendo_store_daily_history`,
          )
          .get(),
      ).toEqual({ official_date: "2026-09-12", play_game_id: null, total_seconds: 900 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM play_observations").get()).toEqual({
        count: 0,
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM play_sessions WHERE source='nintendo_store'")
          .get(),
      ).toEqual({ count: 0 });
    });
  });

  it("reads status locally and rejects malformed or concurrent synchronization", async () => {
    expect(await readNintendoStoreStatus(process.env)).toMatchObject({
      configured: true,
      connected: true,
      credentialStatus: "connected",
      credentialInvalid: false,
      pendingAuthorization: false,
      titleCount: 0,
      lastSyncedAt: null,
    });

    await expect(
      syncNintendoStore({
        environment: process.env,
        client: {
          collect: async () => ({ history: {} }) as StoreCollectResult,
        },
      }),
    ).rejects.toMatchObject({ code: "store_invalid_upstream_data" });

    await expect(
      syncNintendoStore({
        environment: process.env,
        client: {
          collect: async () => {
            throw Object.assign(new Error("invalid grant"), {
              code: "store_auth_rejected",
              status: 403,
            });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "store_reauthorization_required", status: 401 });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = syncNintendoStore({
      environment: process.env,
      client: {
        collect: async () => {
          await gate;
          return storeResult([]);
        },
      },
    });
    await expect(syncNintendoStore({ environment: process.env })).rejects.toEqual(
      expect.objectContaining({ code: "store_sync_busy", status: 409 }),
    );
    release();
    await expect(first).resolves.toMatchObject({ count: 0, skipped: 0 });
  });
});
