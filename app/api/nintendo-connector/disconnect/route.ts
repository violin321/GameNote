import { NextRequest } from "next/server";
import {
  empty,
  nintendoClient,
  nintendoErrorResponse,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    await (await nintendoClient()).disconnect();
    return empty();
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}
