import { describe, expect, it } from "vitest";
import {
  ImportLimitError,
  normalizeOfficialUrl,
  normalizeTitle,
  validateImportPayload,
} from "../lib/play-history/validation";

const valid = {
  version: 1,
  games: [
    {
      externalId: "game-1",
      title: "The Legend of Zelda™",
      titleId: "0100TEST00001",
      officialUrl: "https://www.nintendo.com/store/products/zelda?utm_source=test",
      sessions: [
        {
          externalId: "session-1",
          startedAt: "2026-08-20T10:00:00+08:00",
          endedAt: "2026-08-20T11:30:00+08:00",
          durationSeconds: 5400,
        },
      ],
      observations: [],
    },
  ],
};

describe("play import validation", () => {
  it("canonicalizes a valid payload", () => {
    const preview = validateImportPayload(valid);
    expect(preview.valid).toBe(true);
    expect(preview.sessionCount).toBe(1);
    expect(preview.games[0]).toMatchObject({
      externalId: "game-1",
      normalizedTitle: "thelegendofzelda",
    });
  });

  it("rejects unknown fields and inconsistent duration", () => {
    const preview = validateImportPayload({
      ...valid,
      games: [
        {
          ...valid.games[0],
          token: "must-not-be-accepted",
          sessions: [{ ...valid.games[0].sessions[0], durationSeconds: 1 }],
        },
      ],
    });
    expect(preview.valid).toBe(false);
    expect(preview.issues.map((item) => item.path)).toContain("$.games[0].token");
    expect(preview.issues.some((item) => item.message.includes("偏差"))).toBe(true);
  });

  it("normalizes title and strips tracking parameters", () => {
    expect(normalizeTitle("  ZELDA：王国之泪™ ")).toBe("zelda王国之泪");
    expect(normalizeOfficialUrl("https://example.com/game/?utm_source=x&region=hk#buy")).toBe(
      "https://example.com/game?region=hk",
    );
  });

  it("rejects credential-bearing or non-https URLs", () => {
    expect(normalizeOfficialUrl("http://example.com/game")).toBe("");
    expect(normalizeOfficialUrl("https://user:secret@example.com/game")).toBe("");
  });

  it("aborts immediately on game/session cardinality limits", () => {
    expect(() =>
      validateImportPayload({ version: 1, games: Array.from({ length: 501 }, () => null) }),
    ).toThrowError(ImportLimitError);
    expect(() =>
      validateImportPayload({
        version: 1,
        games: [{ ...valid.games[0], sessions: Array.from({ length: 5001 }, () => null) }],
      }),
    ).toThrowError(ImportLimitError);
  });
});
