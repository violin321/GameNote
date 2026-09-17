import { NextRequest } from "next/server";
import {
  empty,
  json,
  nintendoClient,
  nintendoErrorResponse,
  readNintendoJson,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    if (request.nextUrl.search) return json({ error: "callback_query_forbidden" }, 400);
    // Sensitive callback material is accepted only from this bounded POST body.
    // It is forwarded directly to the Unix sidecar and is never logged or stored.
    const value = await readNintendoJson(request);
    if (!isCallback(value)) return json({ error: "invalid_callback" }, 400);
    await (await nintendoClient()).callback(value.callbackUrl);
    return empty();
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}

function isCallback(value: unknown): value is { callbackUrl: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { callbackUrl?: unknown }).callbackUrl === "string" &&
    (value as { callbackUrl: string }).callbackUrl.length <= 4096,
  );
}
