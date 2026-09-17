import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import {
  commitImportBatch,
  ImportConflictError,
  ImportInvalidError,
  ImportNotFoundError,
} from "@/lib/play-history/repository";
import { playHistoryLimits } from "@/lib/play-history/types";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    assertSameOriginWrite(request);
    if (!(await getAccessIdentity(request)))
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { value } = await readBoundedJson<unknown>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { batchId?: unknown }).batchId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test((value as { batchId: string }).batchId)
    )
      return NextResponse.json({ error: "batchId 无效" }, { status: 400 });
    return NextResponse.json(await commitImportBatch((value as { batchId: string }).batchId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiRequestError)
      return NextResponse.json({ error: error.publicMessage }, { status: error.status });
    if (error instanceof ImportNotFoundError)
      return NextResponse.json({ error: "导入批次不存在" }, { status: 404 });
    if (error instanceof ImportInvalidError)
      return NextResponse.json({ error: "preview 有错误，不能 commit" }, { status: 422 });
    if (error instanceof ImportConflictError)
      return NextResponse.json({ error: "导入批次状态冲突" }, { status: 409 });
    throw error;
  }
}
