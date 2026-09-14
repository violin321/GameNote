import { NextRequest } from "next/server";
import {
  assertEmptyNintendoStoreBody,
  empty,
  nintendoStoreErrorResponse,
  requireNintendoStoreAdmin,
} from "@/lib/nintendo-store/api";
import { withNintendoStoreConnectionChange } from "@/lib/nintendo-store/scheduler";
import { disconnectNintendoStore } from "@/lib/nintendo-store/service";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoStoreAdmin(request, true);
    if ("response" in access) return access.response;
    await assertEmptyNintendoStoreBody(request);
    await withNintendoStoreConnectionChange(() => disconnectNintendoStore());
    return empty();
  } catch (error) {
    return nintendoStoreErrorResponse(error);
  }
}
