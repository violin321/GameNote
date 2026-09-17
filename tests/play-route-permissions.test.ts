import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  getAccessIdentity,
  listPlayGames,
  listRecentPlayActivity,
  listUnlinkedPlayGames,
  getPlayGameDetail,
  readAppSettings,
} = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  listPlayGames: vi.fn(),
  listRecentPlayActivity: vi.fn(),
  listUnlinkedPlayGames: vi.fn(),
  getPlayGameDetail: vi.fn(),
  readAppSettings: vi.fn(),
}));
vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/ledger/repository", () => ({ readAppSettings }));
vi.mock("../lib/play-history/repository", () => ({
  listPlayGames,
  listRecentPlayActivity,
  listUnlinkedPlayGames,
  getPlayGameDetail,
}));

import { GET as getHistory } from "../app/api/play-history/route";
import { GET as getDetail } from "../app/api/play-history/[id]/route";
import { GET as getRecent } from "../app/api/play-recent/route";
import { GET as getUnlinked } from "../app/api/play-unlinked/route";

describe("play data permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessIdentity.mockResolvedValue(null);
    readAppSettings.mockResolvedValue({ showPlayStation: true });
  });

  it.each([
    ["history", () => getHistory(new Request("http://localhost/api/play-history") as never)],
    ["recent", () => getRecent(new Request("http://localhost/api/play-recent?days=90") as never)],
    ["unlinked", () => getUnlinked(new Request("http://localhost/api/play-unlinked") as never)],
    [
      "detail",
      () =>
        getDetail(new Request("http://localhost/api/play-history/game-1") as never, {
          params: Promise.resolve({ id: "game-1" }),
        }),
    ],
  ])("does not query or reveal %s data to guests", async (_name, request) => {
    const response = await request();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(listPlayGames).not.toHaveBeenCalled();
    expect(listRecentPlayActivity).not.toHaveBeenCalled();
    expect(listUnlinkedPlayGames).not.toHaveBeenCalled();
    expect(getPlayGameDetail).not.toHaveBeenCalled();
  });

  it("passes a bounded unlinked-title query for authenticated users", async () => {
    getAccessIdentity.mockResolvedValue({ username: "admin" });
    listUnlinkedPlayGames.mockResolvedValue([]);
    const query = "集合啦动物森友会".repeat(20);
    const response = await getUnlinked(
      new NextRequest(`http://localhost/api/play-unlinked?q=${encodeURIComponent(query)}`),
    );
    expect(response.status).toBe(200);
    expect(listUnlinkedPlayGames).toHaveBeenCalledWith(query.slice(0, 100));
  });
});
