import { redirect } from "next/navigation";
import { LedgerClient } from "@/features/ledger";
import { readAppSettings } from "@/lib/ledger/repository";

export const dynamic = "force-dynamic";

export default async function PsPlusCatalogPage() {
  const settings = await readAppSettings();
  if (!settings.showPlayStation || !settings.showPsPlusCatalog) redirect("/");
  return <LedgerClient initialPlatform="PlayStation" initialView="ps-plus-catalog" />;
}
