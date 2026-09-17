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
    return json(await syncNintendoStoreScheduled());
  } catch (error) {
    return nintendoStoreErrorResponse(error);
  }
}
