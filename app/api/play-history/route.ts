import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { listPlayGames } from "@/lib/play-history/repository";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request))) {
    return noStoreJson({ error: "unauthorized" }, 401);
  }
  const sort = request.nextUrl.searchParams.get("sort") || "recent";
  const direction =
    request.nextUrl.searchParams.get("direction") || (sort === "title" ? "asc" : "desc");
  const query = (request.nextUrl.searchParams.get("q") || "").slice(0, 100);
  return noStoreJson({ games: await listPlayGames(sort, direction, query) });
}

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
