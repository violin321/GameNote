import { LedgerClient } from "@/features/ledger";

export default function UnlinkedPlayPage() {
  return <LedgerClient initialPlatform="Nintendo Switch" initialView="play-unlinked" />;
}
