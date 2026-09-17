import { NextRequest } from "next/server";
import {
  assertEmptyMoonBody,
  json,
  moonClient,
  moonErrorResponse,
  requireMoonAdmin,
} from "@/lib/moon/api";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireMoonAdmin(request, true);
    if ("response" in access) return access.response;
    await assertEmptyMoonBody(request);
    return json(await (await moonClient()).authorize(), 201);
  } catch (error) {
    return moonErrorResponse(error);
  }
}
