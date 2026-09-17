import { redirect } from "next/navigation";
import { LedgerClient } from "@/features/ledger";
import { readAppSettings } from "@/lib/ledger/repository";

export const dynamic = "force-dynamic";

export default async function PlayStationPage() {
  const settings = await readAppSettings();
  if (!settings.showPlayStation) redirect("/");
  return <LedgerClient initialPlatform="PlayStation" />;
}
