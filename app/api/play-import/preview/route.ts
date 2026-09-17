import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import { ImportConflictError, saveImportPreview } from "@/lib/play-history/repository";
import { playHistoryLimits } from "@/lib/play-history/types";
import {
  ImportLimitError,
  payloadSha256,
  validateImportPayload,
} from "@/lib/play-history/validation";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertSameOriginWrite(request);
    if (!(await getAccessIdentity(request)))
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
      return NextResponse.json({ error: "需要 8-128 位 Idempotency-Key" }, { status: 400 });

    const { raw, value } = await readBoundedJson(request, playHistoryLimits.maxRequestBytes);
    const preview = validateImportPayload(value);
    const saved = await saveImportPreview(idempotencyKey, payloadSha256(raw), preview);
    return NextResponse.json(saved, {
      status: preview.valid ? 200 : 422,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiRequestError)
      return NextResponse.json({ error: error.publicMessage }, { status: error.status });
    if (error instanceof ImportLimitError)
      return NextResponse.json({ error: error.publicMessage }, { status: 413 });
    if (error instanceof ImportConflictError)
      return NextResponse.json({ error: "幂等键已用于不同 payload" }, { status: 409 });
    throw error;
  }
}
