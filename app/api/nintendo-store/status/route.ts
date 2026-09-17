import { NextRequest } from "next/server";
import {
  json,
  nintendoStoreErrorResponse,
  requireNintendoStoreAdmin,
} from "@/lib/nintendo-store/api";
import { readNintendoStoreScheduleStatus } from "@/lib/nintendo-store/scheduler";
import { readNintendoStoreStatus } from "@/lib/nintendo-store/service";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const access = await requireNintendoStoreAdmin(request);
    if ("response" in access) return access.response;
    return json({
      ...(await readNintendoStoreStatus()),
      ...readNintendoStoreScheduleStatus(),
    });
  } catch (error) {
    return nintendoStoreErrorResponse(error);
  }
}
