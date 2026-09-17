import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("application shell architecture", () => {
  it("keeps a legal root document and mounts exactly one global AppShell", async () => {
    const [rootLayout, playLayout] = await Promise.all([
      readFile("app/layout.tsx", "utf8"),
      readFile("app/play/layout.tsx", "utf8"),
    ]);
    expect(rootLayout).toContain('<html lang="zh-CN">');
    expect(rootLayout).toContain("<body");
    expect(rootLayout.match(/<AppShell>/g)).toHaveLength(1);
    expect(playLayout).not.toContain("AppShell");
  });

  it("keeps LedgerClient free of a second sidebar, header and mobile navigation", async () => {
    const ledger = await readFile("features/ledger/ledger-client.tsx", "utf8");
    expect(ledger).not.toContain("ledger-sidebar-left");
    expect(ledger).not.toContain("ledger-header");
    expect(ledger).not.toContain("mobile-navigation");
    expect(ledger).not.toContain("AppToolbar");
    expect(ledger).not.toContain("MobileAccountMenu");
  });

  it("does not expose a projection-only purchase write entry", async () => {
    const [repository, importScript] = await Promise.all([
      readFile("lib/play-history/repository.ts", "utf8"),
      readFile("scripts/import-purchases.mjs", "utf8"),
    ]);
    expect(repository).not.toContain("importPurchaseRecords");
    expect(importScript).not.toMatch(/INSERT\s+INTO\s+purchase_records/i);
    expect(importScript).toContain("INSERT INTO ledger_documents");
  });

  it("declares immutable image revision metadata and non-root runtime", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile).toContain("ARG OCI_REVISION=unknown");
    expect(dockerfile).toContain('org.opencontainers.image.revision="${OCI_REVISION}"');
    expect(dockerfile).toContain("USER nextjs:nodejs");
    expect(dockerfile).toContain("HEALTHCHECK");
  });

  it("routes home, dashboard, play and settings through the root shell", async () => {
    const rootLayout = await readFile("app/layout.tsx", "utf8");
    const pages = await Promise.all(
      [
        "app/page.tsx",
        "app/dashboard/page.tsx",
        "app/play/recent/page.tsx",
        "app/settings/page.tsx",
      ].map((path) => readFile(path, "utf8")),
    );
    expect(rootLayout).toContain("<AppShell>{children}</AppShell>");
    for (const page of pages) expect(page).not.toContain("AppShell");
  });
});
