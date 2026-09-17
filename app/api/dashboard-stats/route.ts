import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { getDashboardStats } from "@/lib/play-history/repository";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const identity = await getAccessIdentity(request).catch(() => null);
  return NextResponse.json(await getDashboardStats(Boolean(identity)), {
    headers: { "cache-control": "no-store" },
  });
}
