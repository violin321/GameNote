import { NextRequest } from "next/server";
import {
  assertEmptyNintendoStoreBody,
  json,
  nintendoStoreErrorResponse,
  requireNintendoStoreAdmin,
} from "@/lib/nintendo-store/api";
import { syncNintendoStoreScheduled } from "@/lib/nintendo-store/scheduler";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoStoreAdmin(request, true);
    if ("response" in access) return access.response;
    await assertEmptyNintendoStoreBody(request);
    const result = await syncNintendoStoreScheduled();
    if (!result) return json({ skipped: true });
    // Keep internal audit identifiers and auth metadata out of the browser API.
    return json({
      count: result.count,
      skipped: result.skipped,
      titleCount: result.titleCount,
      dailyCount: result.dailyCount ?? 0,
      skippedDaily: result.skippedDaily ?? 0,
      fetchedAt: result.fetchedAt,
    });
  } catch (error) {
    return nintendoStoreErrorResponse(error);
  }
}
