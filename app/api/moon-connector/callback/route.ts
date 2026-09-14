import { NextRequest } from "next/server";
import {
  empty,
  json,
  moonClient,
  moonErrorResponse,
  readMoonJson,
  requireMoonAdmin,
} from "@/lib/moon/api";
import { withMoonConnectionChange } from "@/lib/moon/scheduler";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireMoonAdmin(request, true);
    if ("response" in access) return access.response;
    if (request.nextUrl.search) return json({ error: "callback_query_forbidden" }, 400);
    const value = await readMoonJson(request);
    if (!isCallback(value)) return json({ error: "invalid_callback" }, 400);
    await withMoonConnectionChange(async () => (await moonClient()).callback(value.callbackUrl));
    return empty();
  } catch (error) {
    return moonErrorResponse(error);
  }
}

function isCallback(value: unknown): value is { callbackUrl: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { callbackUrl?: unknown }).callbackUrl === "string" &&
    (value as { callbackUrl: string }).callbackUrl.length > 0 &&
    (value as { callbackUrl: string }).callbackUrl.length <= 4096,
  );
}
