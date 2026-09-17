import { LedgerClient } from "@/features/ledger";
export default function SettingsPage() {
  return <LedgerClient initialPlatform="Nintendo Switch" initialView="settings" />;
}
