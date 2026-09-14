import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import {
  decidePurchaseLink,
  ImportInvalidError,
  ImportNotFoundError,
} from "@/lib/play-history/repository";
import { playHistoryLimits } from "@/lib/play-history/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const identity = await getAccessIdentity(request);
    if (!identity) return publicError(401, "unauthorized");
    assertSameOriginWrite(request);
    const { value: payload } = await readBoundedJson<Record<string, unknown>>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    const action =
      payload.action === "confirm" || payload.action === "reject" ? payload.action : null;
    if (
      !action ||
      typeof payload.playGameId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(payload.playGameId) ||
      (payload.purchaseRecordId !== undefined &&
        payload.purchaseRecordId !== null &&
        typeof payload.purchaseRecordId !== "string")
    ) {
      return publicError(400, "请求无效");
    }
    const purchaseRecordId =
      typeof payload.purchaseRecordId === "string" ? payload.purchaseRecordId.slice(0, 200) : null;
    return NextResponse.json(
      await decidePurchaseLink(payload.playGameId, action, purchaseRecordId, identity.username),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ApiRequestError) return publicError(error.status, error.publicMessage);
    if (error instanceof ImportNotFoundError) return publicError(404, "游戏不存在");
    if (error instanceof ImportInvalidError) return publicError(422, "收藏记录不存在");
    throw error;
  }
}

function publicError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
