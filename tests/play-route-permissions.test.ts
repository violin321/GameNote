import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  getAccessIdentity,
  saveImportPreview,
  commitImportBatch,
  decidePurchaseLink,
  listPlayGames,
  listRecentSessions,
  listUnlinkedPlayGames,
} = vi.hoisted(() => ({
  getAccessIdentity: vi.fn(),
  saveImportPreview: vi.fn(),
  commitImportBatch: vi.fn(),
  decidePurchaseLink: vi.fn(),
  listPlayGames: vi.fn(),
  listRecentSessions: vi.fn(),
  listUnlinkedPlayGames: vi.fn(),
}));

vi.mock("../lib/auth/access", () => ({ getAccessIdentity }));
vi.mock("../lib/play-history/repository", () => ({
  saveImportPreview,
  commitImportBatch,
  decidePurchaseLink,
  listPlayGames,
  listRecentSessions,
  listUnlinkedPlayGames,
}));

import { GET as getHistory } from "../app/api/play-history/route";
import { POST as commitImport } from "../app/api/play-import/commit/route";
import { POST as previewImport } from "../app/api/play-import/preview/route";
import { POST as decideLink } from "../app/api/play-links/decision/route";
import { GET as getRecent } from "../app/api/play-recent/route";
import { GET as getUnlinked } from "../app/api/play-unlinked/route";

const repositoryCalls = [
  saveImportPreview,
  commitImportBatch,
  decidePurchaseLink,
  listPlayGames,
  listRecentSessions,
  listUnlinkedPlayGames,
];

describe("play route permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessIdentity.mockResolvedValue(null);
  });

  it.each([
    ["history", () => getHistory(getRequest("/api/play-history"))],
    ["recent", () => getRecent(getRequest("/api/play-recent?days=90"))],
    ["unlinked", () => getUnlinked(getRequest("/api/play-unlinked"))],
    [
      "import preview",
      () =>
        previewImport(
          postRequest(
            "/api/play-import/preview",
            { version: 1, games: [] },
            {
              "idempotency-key": "guest-preview-1",
            },
          ),
        ),
    ],
    [
      "import commit",
      () => commitImport(postRequest("/api/play-import/commit", { batchId: crypto.randomUUID() })),
    ],
    [
      "link decision",
      () =>
        decideLink(
          postRequest("/api/play-links/decision", {
            action: "confirm",
            playGameId: "game-1",
            purchaseRecordId: "purchase-1",
          }),
        ),
    ],
  ])("returns 401 without querying the repository for guest %s requests", async (_name, call) => {
    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    for (const repositoryCall of repositoryCalls) {
      expect(repositoryCall).not.toHaveBeenCalled();
    }
  });

  it("uses ascending title order by default while keeping first-played newest-first", async () => {
    getAccessIdentity.mockResolvedValue({ username: "owner" });
    listPlayGames.mockResolvedValue([]);

    await getHistory(getRequest("/api/play-history?sort=title"));
    expect(listPlayGames).toHaveBeenLastCalledWith("title", "asc", "");

    await getHistory(getRequest("/api/play-history?sort=first"));
    expect(listPlayGames).toHaveBeenLastCalledWith("first", "desc", "");
  });

  it("returns 422 when repository conflict checks invalidate an otherwise valid preview", async () => {
    getAccessIdentity.mockResolvedValue({ username: "owner" });
    saveImportPreview.mockResolvedValue({
      batchId: crypto.randomUUID(),
      status: "previewed",
      replayed: false,
      preview: {
        valid: false,
        issues: [{ index: 0, path: "$.games[0].sessions", message: "stored conflict" }],
      },
    });

    const response = await previewImport(
      postRequest(
        "/api/play-import/preview",
        { version: 1, games: [] },
        { "idempotency-key": "owner-preview-1" },
      ),
    );

    expect(response.status).toBe(422);
  });
});

function getRequest(path: string) {
  return new NextRequest(`http://localhost${path}`);
}

function postRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
