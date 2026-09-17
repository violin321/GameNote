import { NextRequest } from "next/server";
import { assertEmptyMoonBody, json, moonErrorResponse, requireMoonAdmin } from "@/lib/moon/api";
import { syncMoonAndImport } from "@/lib/moon/scheduler";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireMoonAdmin(request, true);
    if ("response" in access) return access.response;
    await assertEmptyMoonBody(request);
    return json(await syncMoonAndImport());
  } catch (error) {
    return moonErrorResponse(error);
  }
}
