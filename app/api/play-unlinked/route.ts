import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { isPlayStationPlatform } from "@/lib/game/platform";
import { readAppSettings } from "@/lib/ledger/repository";
import { listUnlinkedPlayGames } from "@/lib/play-history/repository";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const query = (request.nextUrl.searchParams.get("q") || "").slice(0, 100);
  const [settings, games] = await Promise.all([readAppSettings(), listUnlinkedPlayGames(query)]);
  return NextResponse.json(
    {
      games: settings.showPlayStation
        ? games
        : games.filter((game) => !isPlayStationPlatform(game.platform)),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
