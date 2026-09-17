import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("history collection completion UI", () => {
  it("requires explicit version and media choices instead of inventing collection details", async () => {
    const client = await readFile("features/play-history/play-history-client.tsx", "utf8");

    expect(client).toContain('useState<GameFormat | "">("")');
    expect(client).toContain('useState<Region | "">("")');
    expect(client).toContain('setError("请先选择版本和介质")');
    expect(client).toContain("请选择介质");
    expect(client).toContain("请选择版本");
  });

  it("offers collection completion directly from history, while hiding an empty link picker", async () => {
    const client = await readFile("features/play-history/play-history-client.tsx", "utf8");

    expect(client).toContain("onCreateCollection={(id) => openDetail(id, true)}");
    expect(client).toContain("initialCreatingCollection={collectionTargetId === detail.id}");
    expect(client).toContain("onCreate={() => onCreateCollection(game.id)}");
    expect(client).toContain("{purchases.length ? (");
  });
});
