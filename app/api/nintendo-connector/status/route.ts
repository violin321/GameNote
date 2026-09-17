import { NextRequest } from "next/server";
import {
  json,
  nintendoClient,
  nintendoErrorResponse,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";
import { nintendoDataSource } from "@/lib/nintendo/types";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request);
    if ("response" in access) return access.response;
    return json({ ...(await (await nintendoClient()).status()), dataSource: nintendoDataSource });
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}
