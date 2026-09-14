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
    if (!(await getAccessIdentity(request))) {
      return publicError(401, "unauthorized");
    }
    assertSameOriginWrite(request);
    const { value } = await readBoundedJson<unknown>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { batchId?: unknown }).batchId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test((value as { batchId: string }).batchId)
    ) {
      return publicError(400, "batchId 无效");
    }
    return NextResponse.json(await commitImportBatch((value as { batchId: string }).batchId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiRequestError) return publicError(error.status, error.publicMessage);
    if (error instanceof ImportNotFoundError) return publicError(404, "导入批次不存在");
    if (error instanceof ImportInvalidError) return publicError(422, "preview 有错误，不能 commit");
    if (error instanceof ImportConflictError) return publicError(409, "导入批次状态冲突");
    throw error;
  }
}

function publicError(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}
