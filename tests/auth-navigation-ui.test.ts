import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("administrator authentication navigation", () => {
  it("opens the existing login dialog during same-page client navigation", async () => {
    const [shell, ledger] = await Promise.all([
      readFile("features/app-shell/app-shell.tsx", "utf8"),
      readFile("features/ledger/ledger-client.tsx", "utf8"),
    ]);

    expect(shell).toContain('shellAuthRequestedEvent = "gamenote:auth-requested"');
    expect(shell).toContain("new Event(shellAuthRequestedEvent)");
    expect(ledger).toContain("window.addEventListener(shellAuthRequestedEvent, openAuthPanel)");
    expect(ledger).toContain("window.removeEventListener(shellAuthRequestedEvent, openAuthPanel)");
  });
});
