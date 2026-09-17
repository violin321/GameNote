import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Moon connector settings UI", () => {
  it("turns an unavailable sidecar into an explicit retry action", async () => {
    const panel = await readFile("features/moon/moon-connector-panel.tsx", "utf8");

    expect(panel).toContain("const serviceUnavailable = status?.configured === false;");
    expect(panel).toContain('id="moon-service-unavailable"');
    expect(panel).toContain(
      'aria-describedby={serviceUnavailable ? "moon-service-unavailable" : undefined}',
    );
    expect(panel).toContain('"重新检查采集服务"');
    expect(panel).toContain("void refreshStatus(true)");
    expect(panel).not.toContain("disabled={busy || loading || !status?.configured}");
  });
});
