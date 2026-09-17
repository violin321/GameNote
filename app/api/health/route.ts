import { NextResponse } from "next/server";
import { verifyPlayDatabaseHealth } from "@/lib/play-history/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const secret = process.env.JWT_SECRET || "";
    if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("invalid configuration");
    await verifyPlayDatabaseHealth();
    return NextResponse.json(
      { status: "ok" },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "unhealthy" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
