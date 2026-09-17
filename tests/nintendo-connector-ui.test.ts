import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Nintendo connector settings UI", () => {
  it("mounts the connector panel on the administrator settings page", async () => {
    const settings = await readFile("features/ledger/components/settings-pages.tsx", "utf8");
    expect(settings).toContain(
      'import { NintendoConnectorPanel } from "./nintendo-connector-panel"',
    );
    expect(settings).toContain("<NintendoConnectorPanel />");
  });

  it("supports status, explicit consent, authorization, callback, sync and disconnect operations", async () => {
    const panel = await readFile("features/ledger/components/nintendo-connector-panel.tsx", "utf8");
    for (const operation of ["status", "consent", "authorize", "callback", "sync", "disconnect"])
      expect(panel).toContain(`\${connectorPath}/${operation}`);
    expect(panel).toContain("setInterval(() =>");
    expect(panel).toContain('cache: "no-store"');
  });

  it("requires a visible third-party risk acknowledgment before consent and authorize", async () => {
    const panel = await readFile("features/ledger/components/nintendo-connector-panel.tsx", "utf8");
    expect(panel).toContain("第三方接收者");
    expect(panel).toContain("完整风险说明");
    expect(panel).toContain("{consentChallenge.riskNotice}");
    expect(panel).toContain("不会自动同意");
    expect(panel).toContain('type="checkbox"');
    expect(panel).toContain("!consentAccepted || !consentChallenge?.riskNoticeHash");
    expect(panel).toContain("riskNoticeHash: consentChallenge.riskNoticeHash");
    expect(panel).toContain("acknowledged: true");
    expect(panel).toContain("disabled={busy || loading || !canAuthorize}");
    expect(panel.indexOf("grantConsent()")).toBeLessThan(
      panel.indexOf("async function authorize()"),
    );
  });

  it("keeps callback material in a bounded password field and same-origin POST body", async () => {
    const panel = await readFile("features/ledger/components/nintendo-connector-panel.tsx", "utf8");
    expect(panel).toContain('type="password"');
    expect(panel).toContain("maxLength={4096}");
    expect(panel).toContain("body: JSON.stringify({ callbackUrl: value })");
    expect(panel).not.toContain("localStorage");
    expect(panel).not.toContain("sessionStorage");
    expect(panel).not.toContain("console.");
    expect(panel).not.toContain("window.location = authorization.authorizationUrl");
    expect(panel).not.toContain("userSubject:");
    expect(panel).not.toContain("adminSubject:");
  });

  it("maps every provider consent conflict without referencing an undefined error", async () => {
    const panel = await readFile("features/ledger/components/nintendo-connector-panel.tsx", "utf8");
    for (const code of [
      "provider_consent_missing",
      "provider_consent_legacy",
      "provider_consent_stale",
      "provider_consent_revoked",
    ])
      expect(panel).toContain(`${code}:`);
    expect(panel).not.toMatch(/\berr\s+instanceof\s+Error\b/);
  });
});
