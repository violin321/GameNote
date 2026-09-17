import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { isPlayStationPlatform } from "@/lib/game/platform";
import { readAppSettings } from "@/lib/ledger/repository";
import { listRecentPlayActivity } from "@/lib/play-history/repository";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Number(request.nextUrl.searchParams.get("days") || 7);
  const days = parsed === 30 || parsed === 90 ? parsed : 7;
  const [settings, activities] = await Promise.all([
    readAppSettings(),
    listRecentPlayActivity(days),
  ]);
  return NextResponse.json(
    {
      days,
      activities: settings.showPlayStation
        ? activities
        : activities.filter((activity) => !isPlayStationPlatform(activity.platform)),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
