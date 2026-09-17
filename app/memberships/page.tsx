import { LedgerClient } from "@/features/ledger";

export const dynamic = "force-dynamic";

export default function MembershipsPage() {
  return <LedgerClient initialPlatform="Nintendo Switch" initialView="memberships" />;
}
