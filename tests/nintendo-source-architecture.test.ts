import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Nintendo connector source architecture", () => {
  it("has no generic sidecar proxy or user-controlled internal path", async () => {
    const client = await readFile("lib/nintendo/sidecar-client.ts", "utf8");
    expect(client).not.toMatch(/public\s+proxy|generic\s+proxy/i);
    expect(client).not.toMatch(/call\([^\n]*request/i);
    for (const path of [
      "/v1/status",
      "/v1/provider/consent/challenge",
      "/v1/provider/consent",
      "/v1/auth/authorize",
      "/v1/auth/callback",
      "/v1/sync",
      "/v1/snapshot",
      "/v1/link",
    ])
      expect(client).toContain(`\"${path}\"`);
  });

  it("keeps callback secrets out of query, storage, database and logs", async () => {
    const callback = await readFile("app/api/nintendo-connector/callback/route.ts", "utf8");
    expect(callback).not.toContain("searchParams");
    expect(callback).not.toContain("localStorage");
    expect(callback).not.toContain("console.");
    expect(callback).not.toContain("repository");
    expect(callback).not.toContain("session_token_code");
  });

  it("exposes only the named administrator routes", async () => {
    const entries = await readdir("app/api/nintendo-connector", { withFileTypes: true });
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "authorize",
      "callback",
      "consent",
      "disconnect",
      "status",
      "sync",
    ]);
  });
});
