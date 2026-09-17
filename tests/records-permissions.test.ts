import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasValidAccessCookie, readLedgerFromSqlite, listPlayGames, listPurchasePlaySummaries } =
  vi.hoisted(() => ({
    hasValidAccessCookie: vi.fn(),
    readLedgerFromSqlite: vi.fn(),
    listPlayGames: vi.fn(),
    listPurchasePlaySummaries: vi.fn(),
  }));
vi.mock("../lib/auth/access", () => ({ hasValidAccessCookie }));
vi.mock("../lib/ledger/repository", () => ({
  LedgerConflictError: class extends Error {},
  readLedgerFromSqlite,
  writeLedgerToSqlite: vi.fn(),
}));
vi.mock("../lib/play-history/repository", () => ({ listPlayGames, listPurchasePlaySummaries }));

import { GET } from "../app/api/records/route";

describe("purchase ledger read permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readLedgerFromSqlite.mockResolvedValue({
      version: 1,
      updatedAt: "2026-08-24T00:00:00Z",
      records: [{ id: "purchase-1", title: "Visible purchase" }],
    });
    listPurchasePlaySummaries.mockResolvedValue([
      {
        purchaseRecordId: "purchase-1",
        totalSeconds: 3600,
        firstPlayedAt: "2026-08-20T00:00:00Z",
        lastPlayedAt: "2026-08-21T00:00:00Z",
      },
    ]);
    listPlayGames.mockResolvedValue([
      {
        id: "history-1",
        platform: "Nintendo Switch",
        title: "History game",
      },
      {
        id: "history-ps",
        platform: "PlayStation 5",
        title: "PS history game",
      },
    ]);
  });

  it("preserves guest access to the purchase ledger without exposing play summaries", async () => {
    hasValidAccessCookie.mockResolvedValue(false);
    const response = await GET(new Request("http://localhost/api/records") as never);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.records).toHaveLength(1);
    expect(payload).not.toHaveProperty("playSummaries");
    expect(payload).not.toHaveProperty("libraryPlayGames");
    expect(listPurchasePlaySummaries).not.toHaveBeenCalled();
    expect(listPlayGames).not.toHaveBeenCalled();
  });

  it("adds joined play summaries for an authenticated administrator", async () => {
    hasValidAccessCookie.mockResolvedValue(true);
    const response = await GET(new Request("http://localhost/api/records") as never);
    const payload = await response.json();
    expect(payload.playSummaries).toHaveLength(1);
    expect(payload.libraryPlayGames).toEqual([
      expect.objectContaining({ id: "history-1", title: "History game" }),
    ]);
    expect(listPurchasePlaySummaries).toHaveBeenCalledOnce();
    expect(listPlayGames).toHaveBeenCalledWith("recent", "desc", "");
  });
});
