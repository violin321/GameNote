import { LedgerClient } from "@/features/ledger";

export default function PlayHistoryPage() {
  return <LedgerClient initialPlatform="Nintendo Switch" initialView="play-history" />;
}
