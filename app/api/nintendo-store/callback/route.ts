import { NextRequest } from "next/server";
import {
  assertStoreCallback,
  empty,
  json,
  nintendoStoreErrorResponse,
  readNintendoStoreJson,
  requireNintendoStoreAdmin,
} from "@/lib/nintendo-store/api";
import { withNintendoStoreConnectionChange } from "@/lib/nintendo-store/scheduler";
import { callbackNintendoStore } from "@/lib/nintendo-store/service";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoStoreAdmin(request, true);
    if ("response" in access) return access.response;
    if (request.nextUrl.search) return json({ error: "callback_query_forbidden" }, 400);
    const value = await readNintendoStoreJson(request);
    if (!assertStoreCallback(value)) return json({ error: "invalid_callback" }, 400);
    await withNintendoStoreConnectionChange(() => callbackNintendoStore(value.callbackUrl));
    return empty();
  } catch (error) {
    return nintendoStoreErrorResponse(error);
  }
}
