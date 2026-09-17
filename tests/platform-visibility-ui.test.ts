import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlayStationPlatform } from "../lib/game/platform";
import { readAppSettings, writeAppSettings } from "../lib/ledger/repository";
import { migratePlayDatabase } from "../lib/play-history/repository";

let testDirectory = "";

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "gamenote-platform-visibility-"));
  process.env.APP_DATABASE_FILE = join(testDirectory, "ns2.sqlite");
  await migratePlayDatabase();
});

afterEach(async () => {
  delete process.env.APP_DATABASE_FILE;
  await rm(testDirectory, { recursive: true, force: true });
});

describe("PlayStation visibility", () => {
  it("treats PlayStation as the parent switch for the PS Plus catalog", async () => {
    const current = await readAppSettings();
    await writeAppSettings({
      ...current,
      showPlayStation: false,
      showPsPlusCatalog: true,
    });

    await expect(readAppSettings()).resolves.toMatchObject({
      showPlayStation: false,
      showPsPlusCatalog: false,
    });
  });

  it("recognizes common PlayStation platform labels", () => {
    expect(isPlayStationPlatform("PlayStation")).toBe(true);
    expect(isPlayStationPlatform("PS5")).toBe(true);
    expect(isPlayStationPlatform("Nintendo Switch 2")).toBe(false);
  });

  it("updates the shell immediately and hides dependent PS surfaces", async () => {
    const [shell, ledger, settingsPage, historyPage, playStationPage, catalogPage] =
      await Promise.all([
        readFile("features/app-shell/app-shell.tsx", "utf8"),
        readFile("features/ledger/ledger-client.tsx", "utf8"),
        readFile("features/ledger/components/settings-pages.tsx", "utf8"),
        readFile("features/play-history/play-history-client.tsx", "utf8"),
        readFile("app/playstation/page.tsx", "utf8"),
        readFile("app/ps-plus-catalog/page.tsx", "utf8"),
      ]);

    expect(shell).toContain('shellSettingsChangedEvent = "gamenote:settings-changed"');
    expect(shell).toContain("settings.showPlayStation !== false &&");
    expect(ledger).toContain("new Event(shellSettingsChangedEvent)");
    expect(ledger).toContain('platform !== "PlayStation" || settings.showPlayStation');
    expect(settingsPage).toContain("showPsPlusCatalog: event.target.checked");
    expect(settingsPage).toContain("{settings.showPlayStation ? (");
    expect(historyPage).toContain("showPlayStation={showPlayStation}");
    expect(historyPage).toContain("!isPlayStationPlatform(purchase.platform)");
    expect(playStationPage).toContain('if (!settings.showPlayStation) redirect("/")');
    expect(catalogPage).toContain(
      'if (!settings.showPlayStation || !settings.showPsPlusCatalog) redirect("/")',
    );
  });
});
