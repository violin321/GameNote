import { LedgerClient } from "@/features/ledger";

export default function RecentPlayPage() {
  return <LedgerClient initialPlatform="Nintendo Switch" initialView="play-recent" />;
}
