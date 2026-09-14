import { NextRequest } from "next/server";
import {
  assertEmptyMoonBody,
  empty,
  moonClient,
  moonErrorResponse,
  requireMoonAdmin,
} from "@/lib/moon/api";
import { withMoonConnectionChange } from "@/lib/moon/scheduler";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireMoonAdmin(request, true);
    if ("response" in access) return access.response;
    await assertEmptyMoonBody(request);
    await withMoonConnectionChange(async () => (await moonClient()).disconnect());
    return empty();
  } catch (error) {
    return moonErrorResponse(error);
  }
}
