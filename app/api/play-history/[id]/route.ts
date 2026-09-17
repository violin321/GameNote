import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { isPlayStationPlatform } from "@/lib/game/platform";
import { readAppSettings } from "@/lib/ledger/repository";
import { getPlayGameDetail } from "@/lib/play-history/repository";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const [settings, game] = await Promise.all([readAppSettings(), getPlayGameDetail(id)]);
  const visibleGame =
    game && (settings.showPlayStation || !isPlayStationPlatform(game.platform)) ? game : null;
  return visibleGame
    ? NextResponse.json({ game: visibleGame }, { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: "not_found" }, { status: 404 });
}
