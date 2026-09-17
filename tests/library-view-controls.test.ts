import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("NS library view controls", () => {
  it("applies grid and list mode to history-backed games", async () => {
    const client = await readFile("features/ledger/ledger-client.tsx", "utf8");

    expect(client).toContain("history-library-grid history-library-grid--${recordDisplayMode}");
    expect(client).toContain('aria-pressed={recordDisplayMode === "grid"}');
    expect(client).toContain('aria-pressed={recordDisplayMode === "list"}');
  });

  it("uses an accessible custom sort control instead of the native select", async () => {
    const client = await readFile("features/ledger/ledger-client.tsx", "utf8");

    expect(client).toContain('aria-controls="library-sort-options"');
    expect(client).toContain('id="library-sort-options"');
    expect(client).toContain('aria-label="排序方式"');
    expect(client).toContain("disabled={unavailable}");
    expect(client).not.toContain("<select\n                      value={sortBy}");
  });
});
