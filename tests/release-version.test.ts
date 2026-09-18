import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAppRelease } from "@/lib/release/version";
import manifest from "../package.json";

const checker = resolve(process.cwd(), "scripts/check-release-version.mjs");

describe("release version", () => {
  it("accepts the matching Git tag and prints the package version", () => {
    expect(
      execFileSync(process.execPath, [checker, `v${manifest.version}`], {
        encoding: "utf8",
      }).trim(),
    ).toBe(manifest.version);
  });

  it("rejects a tag that disagrees with the package", () => {
    const result = spawnSync(process.execPath, [checker, "v0.0.0"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match package version");
  });

  it("shows only valid build revisions", () => {
    const previous = process.env.APP_REVISION;
    try {
      process.env.APP_REVISION = "a".repeat(40);
      expect(getAppRelease()).toEqual({ version: manifest.version, revision: "aaaaaaa" });
      process.env.APP_REVISION = "unknown";
      expect(getAppRelease().revision).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.APP_REVISION;
      else process.env.APP_REVISION = previous;
    }
  });
});
