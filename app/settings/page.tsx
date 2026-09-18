import { LedgerClient } from "@/features/ledger";
import { getAppRelease } from "@/lib/release/version";

export default function SettingsPage() {
  return (
    <LedgerClient
      initialPlatform="Nintendo Switch"
      initialView="settings"
      appRelease={getAppRelease()}
    />
  );
}
