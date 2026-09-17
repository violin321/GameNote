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
    assertSameOriginWrite(request);
    const identity = await getAccessIdentity(request);
    if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { value: payload } = await readBoundedJson<Record<string, unknown>>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    const action =
      payload.action === "confirm" || payload.action === "reject" ? payload.action : null;
    if (!action || typeof payload.playGameId !== "string")
      return NextResponse.json({ error: "请求无效" }, { status: 400 });
    return NextResponse.json(
      await decidePurchaseLink(
        payload.playGameId,
        action,
        typeof payload.purchaseRecordId === "string" ? payload.purchaseRecordId : null,
        identity.username,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ApiRequestError)
      return NextResponse.json({ error: error.publicMessage }, { status: error.status });
    if (error instanceof ImportNotFoundError)
      return NextResponse.json({ error: "游戏不存在" }, { status: 404 });
    if (error instanceof ImportInvalidError)
      return NextResponse.json({ error: "购买记录不存在" }, { status: 422 });
    throw error;
  }
}
