import { describe, expect, it } from "vitest";
import { playHistoryLimits } from "../lib/play-history/types";
import {
  ImportLimitError,
  normalizeOfficialUrl,
  normalizeTitle,
  validateImportPayload,
} from "../lib/play-history/validation";

const validPayload = {
  version: 1,
  games: [
    {
      externalId: "game-1",
      title: "Skyward Atlas™",
      titleId: "TITLE0001",
      officialUrl: "https://example.com/title/TITLE0001?utm_source=fixture&region=hk",
      sessions: [
        {
          externalId: "session-1",
          startedAt: "2026-08-20T10:00:00+08:00",
          endedAt: "2026-08-20T11:30:00+08:00",
          durationSeconds: 5_400,
        },
      ],
    },
  ],
};

describe("play import validation", () => {
  it("canonicalizes titles, URLs and timezone-aware timestamps", () => {
    const preview = validateImportPayload(validPayload);

    expect(preview).toMatchObject({
      valid: true,
      sourceId: "default",
      itemCount: 1,
      sessionCount: 1,
      duplicateGames: 0,
      duplicateSessions: 0,
    });
    expect(preview.games[0]).toMatchObject({
      externalId: "game-1",
      normalizedTitle: "skywardatlas",
      officialUrl: "https://example.com/title/TITLE0001?region=hk",
      sessions: [
        {
          startedAt: "2026-08-20T02:00:00.000Z",
          endedAt: "2026-08-20T03:30:00.000Z",
          playedDate: "2026-08-20",
          durationSeconds: 5_400,
        },
      ],
    });
  });

  it("rejects unknown fields and a duration inconsistent with the time range", () => {
    const preview = validateImportPayload({
      ...validPayload,
      games: [
        {
          ...validPayload.games[0],
          accessToken: "must-not-be-accepted",
          sessions: [{ ...validPayload.games[0].sessions[0], durationSeconds: 1 }],
        },
      ],
    });

    expect(preview.valid).toBe(false);
    expect(preview.issues.map((issue) => issue.path)).toContain("$.games[0].accessToken");
    expect(preview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.games[0].sessions[0].durationSeconds",
          message: expect.stringContaining("偏差"),
        }),
      ]),
    );
  });

  it("rejects conflicting games that reuse an externalId in the same source", () => {
    const preview = validateImportPayload({
      ...validPayload,
      sourceId: "conflict-source",
      games: [
        validPayload.games[0],
        {
          ...validPayload.games[0],
          title: "A Different Canonical Game",
        },
      ],
    });

    expect(preview).toMatchObject({ valid: false, duplicateGames: 0 });
    expect(preview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.games[1].externalId",
          message: expect.stringContaining("不同规范化内容"),
        }),
      ]),
    );
  });

  it("rejects conflicting sessions that reuse an externalId in the same source", () => {
    const preview = validateImportPayload({
      ...validPayload,
      sourceId: "conflict-source",
      games: [
        {
          ...validPayload.games[0],
          sessions: [
            validPayload.games[0].sessions[0],
            {
              ...validPayload.games[0].sessions[0],
              startedAt: "2026-08-21T10:00:00+08:00",
              endedAt: "2026-08-21T11:30:00+08:00",
            },
          ],
        },
      ],
    });

    expect(preview).toMatchObject({ valid: false, duplicateSessions: 0 });
    expect(preview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.games[0].sessions[1].externalId",
          message: expect.stringContaining("不同规范化内容或游戏"),
        }),
      ]),
    );
  });

  it("counts only fully equivalent normalized games and sessions as duplicates", () => {
    const preview = validateImportPayload({
      ...validPayload,
      games: [
        validPayload.games[0],
        {
          ...validPayload.games[0],
          title: "SKYWARD：Atlas™",
          sessions: [{ ...validPayload.games[0].sessions[0] }],
        },
      ],
    });

    expect(preview).toMatchObject({
      valid: true,
      duplicateGames: 1,
      duplicateSessions: 1,
    });
  });

  it("requires explicit ISO-8601 offsets and an ordered, bounded time range", () => {
    const preview = validateImportPayload({
      version: 1,
      games: [
        {
          externalId: "invalid-time-game",
          title: "Invalid Time Game",
          sessions: [
            {
              externalId: "missing-offset",
              startedAt: "2026-08-20T10:00:00",
              endedAt: "2026-08-20T11:00:00Z",
              durationSeconds: 3_600,
            },
            {
              externalId: "reversed-range",
              startedAt: "2026-08-21T11:00:00Z",
              endedAt: "2026-08-21T10:00:00Z",
              durationSeconds: 31_536_001,
            },
          ],
        },
      ],
    });

    expect(preview.valid).toBe(false);
    expect(preview.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.games[0].sessions[0].startedAt" }),
        expect.objectContaining({ path: "$.games[0].sessions[1]" }),
        expect.objectContaining({ path: "$.games[0].sessions[1].durationSeconds" }),
      ]),
    );
  });

  it("stops before traversing payloads beyond the game or session limits", () => {
    expect(() =>
      validateImportPayload({
        version: 1,
        games: Array.from({ length: playHistoryLimits.maxGames + 1 }, () => null),
      }),
    ).toThrowError(ImportLimitError);

    expect(() =>
      validateImportPayload({
        version: 1,
        games: [
          {
            ...validPayload.games[0],
            sessions: Array.from({ length: playHistoryLimits.maxSessions + 1 }, () => null),
          },
        ],
      }),
    ).toThrowError(ImportLimitError);
  });

  it("normalizes matching fields without accepting unsafe URLs", () => {
    expect(normalizeTitle("  SKYWARD：Atlas™ ")).toBe("skywardatlas");
    expect(normalizeTitle("薩爾達傳說 王國之淚")).toBe(normalizeTitle("塞尔达传说 王国之泪"));
    expect(normalizeTitle("ゼルダの伝説 ティアーズ オブ ザ キングダム")).toBe(
      "ゼルダの伝説ティアーズオブザキングダム",
    );
    expect(normalizeTitle("Pokémon Café")).toBe("pokemoncafe");
    expect(normalizeTitle("Cafe\u0301")).toBe(normalizeTitle("Café"));
    expect(normalizeOfficialUrl("http://example.com/game")).toBe("");
    expect(normalizeOfficialUrl("https://user:secret@example.com/game")).toBe("");
  });

  it("accepts a non-sensitive source namespace and explicit source-local play dates", () => {
    const preview = validateImportPayload({
      ...validPayload,
      sourceId: "living-room-console",
      games: [
        {
          ...validPayload.games[0],
          sessions: [
            {
              ...validPayload.games[0].sessions[0],
              startedAt: "2026-08-20T23:30:00Z",
              endedAt: "2026-08-21T00:30:00Z",
              playedDate: "2026-08-21",
              durationSeconds: 3_600,
            },
          ],
        },
      ],
    });

    expect(preview).toMatchObject({ sourceId: "living-room-console", valid: true });
    expect(preview.games[0].sessions[0]).toMatchObject({ playedDate: "2026-08-21" });
  });

  it("rejects invalid source namespaces and calendar dates", () => {
    const preview = validateImportPayload({
      ...validPayload,
      sourceId: "not/a/source",
      games: [
        {
          ...validPayload.games[0],
          sessions: [{ ...validPayload.games[0].sessions[0], playedDate: "2026-02-30" }],
        },
      ],
    });

    expect(preview.valid).toBe(false);
    expect(preview.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(["$.sourceId", "$.games[0].sessions[0].playedDate"]),
    );
  });
});
