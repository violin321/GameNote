import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessIdentity, getDashboardStats } = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  getDashboardStats: vi.fn(),
}));
vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/play-history/repository", () => ({ getDashboardStats }));

import { GET } from "../app/api/dashboard-stats/route";

describe("dashboard stats permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDashboardStats.mockResolvedValue({
      purchases: { total: 2, nintendo: 2, playStation: 0, linked: 1, unlinked: 1 },
      play: null,
    });
  });

  it("keeps the guest purchase dashboard while excluding play data", async () => {
    getAccessIdentity.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/api/dashboard-stats") as never);
    expect(response.status).toBe(200);
    expect(getDashboardStats).toHaveBeenCalledWith(false);
    expect((await response.json()).play).toBeNull();
  });

  it("includes play dashboard data only for an authenticated admin", async () => {
    getAccessIdentity.mockResolvedValue({ id: "owner" });
    await GET(new Request("http://localhost/api/dashboard-stats") as never);
    expect(getDashboardStats).toHaveBeenCalledWith(true);
  });
});
