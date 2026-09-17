import { NextRequest } from "next/server";
import {
  json,
  nintendoClient,
  nintendoErrorResponse,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    return json(await (await nintendoClient()).authorize(), 201);
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}
