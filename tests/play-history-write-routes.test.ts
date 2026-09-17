import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createCollectionFromPlayGame,
  createManualPlayEntry,
  getAccessIdentity,
  ImportInvalidError,
  ImportNotFoundError,
  LedgerPlayGameNotFoundError,
} = vi.hoisted(() => {
  class ImportNotFoundError extends Error {}
  class ImportInvalidError extends Error {}
  class LedgerPlayGameNotFoundError extends Error {}
  return {
    createCollectionFromPlayGame: vi.fn(),
    createManualPlayEntry: vi.fn(),
    getAccessIdentity: vi.fn(),
    ImportInvalidError,
    ImportNotFoundError,
    LedgerPlayGameNotFoundError,
  };
});

vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/play-history/repository", () => ({
  createManualPlayEntry,
  ImportInvalidError,
  ImportNotFoundError,
}));
vi.mock("../lib/ledger/repository", () => ({
  createCollectionFromPlayGame,
  LedgerPlayGameNotFoundError,
}));

import { POST as createManualEntry } from "../app/api/play-history/route";
import { POST as createCollection } from "../app/api/play-history/[id]/collection/route";

const validManualEntry = {
  playGameId: "game-1",
  purchaseRecordId: "",
  title: "",
  platform: "",
  startedAt: "2026-09-14T10:00:00+08:00",
  durationSeconds: 2700,
};

const validCollection = {
  format: "数字版",
  region: "港版",
  purchaseDate: "",
  seller: "Nintendo eShop",
  price: 59.99,
  currency: "HKD",
  notes: "历史游玩生成",
  soldDate: "2026-09-01",
  soldPrice: 20,
  soldCurrency: "USD",
};

function post(
  path: string,
  body: unknown,
  options: {
    origin?: string | null;
    contentLength?: string;
    contentType?: string | null;
    fetchSite?: string;
  } = {},
) {
  const origin = options.origin === undefined ? "https://games.example" : options.origin;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (contentType) headers["content-type"] = contentType;
  if (options.contentLength) headers["content-length"] = options.contentLength;
  if (options.fetchSite) headers["sec-fetch-site"] = options.fetchSite;
  return new NextRequest(`https://games.example${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function collection(request: NextRequest, id = "game-1") {
  return createCollection(request, { params: Promise.resolve({ id }) });
}

describe("play history write routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessIdentity.mockResolvedValue({ username: "admin" });
  });

  it("requires authentication before manual sessions or collections are created", async () => {
    getAccessIdentity.mockResolvedValue(null);

    const manualResponse = await createManualEntry(post("/api/play-history", validManualEntry));
    const collectionResponse = await collection(
      post("/api/play-history/game-1/collection", validCollection),
    );

    expect(manualResponse.status).toBe(401);
    expect(collectionResponse.status).toBe(401);
    expect(createManualPlayEntry).not.toHaveBeenCalled();
    expect(createCollectionFromPlayGame).not.toHaveBeenCalled();
  });

  it.each([
    [
      "manual session",
      (request: NextRequest) => createManualEntry(request),
      "/api/play-history",
      validManualEntry,
    ],
    [
      "collection",
      (request: NextRequest) => collection(request),
      "/api/play-history/game-1/collection",
      validCollection,
    ],
  ] as const)(
    "rejects cross-origin and unverifiable browser %s writes",
    async (_name, run, path, body) => {
      const crossOrigin = await run(post(path, body, { origin: "https://evil.example" }));
      const missingOrigin = await run(post(path, body, { origin: null, fetchSite: "same-origin" }));

      expect(crossOrigin.status).toBe(403);
      expect(missingOrigin.status).toBe(403);
      expect(createManualPlayEntry).not.toHaveBeenCalled();
      expect(createCollectionFromPlayGame).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["manual session", (request: NextRequest) => createManualEntry(request), "/api/play-history"],
    [
      "collection",
      (request: NextRequest) => collection(request),
      "/api/play-history/game-1/collection",
    ],
  ] as const)("bounds the JSON body for %s writes", async (_name, run, path) => {
    const response = await run(post(path, {}, { contentLength: "8193" }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "JSON 请求体过大" });
    expect(createManualPlayEntry).not.toHaveBeenCalled();
    expect(createCollectionFromPlayGame).not.toHaveBeenCalled();
  });

  it("normalizes and creates a manual session for an existing history game", async () => {
    createManualPlayEntry.mockResolvedValue({ gameId: "game-1", sessionId: "session-1" });

    const response = await createManualEntry(post("/api/play-history", validManualEntry));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createManualPlayEntry).toHaveBeenCalledExactlyOnceWith(
      {
        playGameId: "game-1",
        purchaseRecordId: null,
        title: "",
        platform: "Nintendo Switch",
        startedAt: "2026-09-14T02:00:00.000Z",
        durationSeconds: 2700,
      },
      "admin",
    );
  });

  it.each([
    [{ ...validManualEntry, durationSeconds: 59 }, "游玩时长需为 1 分钟至 24 小时"],
    [{ ...validManualEntry, durationSeconds: 86_401 }, "游玩时长需为 1 分钟至 24 小时"],
    [{ ...validManualEntry, durationSeconds: 60.5 }, "游玩时长需为 1 分钟至 24 小时"],
    [{ ...validManualEntry, startedAt: "not-a-date" }, "游玩时间无效"],
    [
      { ...validManualEntry, playGameId: "", purchaseRecordId: "", title: "" },
      "请填写游戏名称或选择已有游戏",
    ],
  ])("rejects invalid manual session input", async (body, message) => {
    const response = await createManualEntry(post("/api/play-history", body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(createManualPlayEntry).not.toHaveBeenCalled();
  });

  it("keeps an optional purchase date and digital purchase channel when creating a collection", async () => {
    createCollectionFromPlayGame.mockResolvedValue({
      created: true,
      record: { id: "purchase-1", title: "Animal Crossing" },
    });

    const response = await collection(post("/api/play-history/game-1/collection", validCollection));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(createCollectionFromPlayGame).toHaveBeenCalledExactlyOnceWith(
      "game-1",
      {
        format: "数字版",
        region: "港版",
        purchaseDate: "",
        seller: "Nintendo eShop",
        price: 59.99,
        currency: "HKD",
        notes: "历史游玩生成",
        soldDate: "",
        soldPrice: 0,
        soldCurrency: "USD",
      },
      "admin",
    );
  });

  it("accepts title, cover and official URL edits from the NS library completion form", async () => {
    createCollectionFromPlayGame.mockResolvedValue({
      created: true,
      record: { id: "purchase-1", title: "集合啦！动物森友会" },
    });

    const response = await collection(
      post("/api/play-history/game-1/collection", {
        ...validCollection,
        title: "集合啦！动物森友会",
        coverUrl: "https://example.com/cover.jpg",
        officialUrl: "https://example.com/title/01006F8002326000",
      }),
    );

    expect(response.status).toBe(201);
    expect(createCollectionFromPlayGame).toHaveBeenCalledWith(
      "game-1",
      expect.objectContaining({
        title: "集合啦！动物森友会",
        coverUrl: "https://example.com/cover.jpg",
        officialUrl: "https://example.com/title/01006F8002326000",
      }),
      "admin",
    );
  });

  it.each([
    [{ ...validCollection, format: "盒装" }, "game-1"],
    [{ ...validCollection, purchaseDate: "September 14" }, "game-1"],
    [{ ...validCollection, soldDate: "2026/09/14" }, "game-1"],
    [validCollection, "x".repeat(161)],
  ])("rejects invalid collection input or game identifiers", async (body, id) => {
    const response = await collection(post(`/api/play-history/${id}/collection`, body), id);

    expect([400, 404]).toContain(response.status);
    expect(createCollectionFromPlayGame).not.toHaveBeenCalled();
  });

  it("maps missing history games and deleted purchase selections without leaking internals", async () => {
    createManualPlayEntry.mockRejectedValueOnce(new ImportNotFoundError("private path"));
    const missingGame = await createManualEntry(post("/api/play-history", validManualEntry));
    expect(missingGame.status).toBe(404);
    expect(await missingGame.json()).toEqual({ error: "游玩游戏不存在" });

    createManualPlayEntry.mockRejectedValueOnce(new ImportInvalidError("private record"));
    const deletedPurchase = await createManualEntry(post("/api/play-history", validManualEntry));
    expect(deletedPurchase.status).toBe(422);
    expect(await deletedPurchase.json()).toEqual({ error: "收藏记录不存在或已删除" });

    createCollectionFromPlayGame.mockRejectedValueOnce(
      new LedgerPlayGameNotFoundError("private game"),
    );
    const missingCollectionGame = await collection(
      post("/api/play-history/game-1/collection", validCollection),
    );
    expect(missingCollectionGame.status).toBe(404);
    expect(await missingCollectionGame.json()).toEqual({ error: "游玩游戏不存在" });
  });
});
