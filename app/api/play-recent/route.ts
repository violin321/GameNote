import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { listRecentSessions } from "@/lib/play-history/repository";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const parsedDays = Number(request.nextUrl.searchParams.get("days") || 7);
  const days: 7 | 30 | 90 = parsedDays === 30 || parsedDays === 90 ? parsedDays : 7;
  return NextResponse.json(
    { sessions: await listRecentSessions(days) },
    { headers: { "cache-control": "no-store" } },
  );
}
