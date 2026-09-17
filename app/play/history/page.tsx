import { PlayHistoryClient } from "@/features/play-history/play-history-client";

export default async function PlayHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const requested = (await searchParams).view;
  const value = Array.isArray(requested) ? requested[0] : requested;
  const mode = value === "recent" || value === "unlinked" ? value : "history";
  return <PlayHistoryClient mode={mode} />;
}
