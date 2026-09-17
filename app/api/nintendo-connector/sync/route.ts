import { NextRequest } from "next/server";
import {
  json,
  nintendoClient,
  nintendoErrorResponse,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";
import { importNintendoSnapshot } from "@/lib/nintendo/import";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    const client = await nintendoClient();
    await client.sync();
    // Deliberately read through the explicit snapshot endpoint after sync so no
    // raw upstream response can bypass the normalized snapshot contract.
    return json(await importNintendoSnapshot(await client.snapshot()));
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}
