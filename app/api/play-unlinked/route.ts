import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { listUnlinkedPlayGames } from "@/lib/play-history/repository";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const query = (request.nextUrl.searchParams.get("q") || "").slice(0, 100);
  return NextResponse.json(
    { games: await listUnlinkedPlayGames(query) },
    { headers: { "cache-control": "no-store" } },
  );
}
