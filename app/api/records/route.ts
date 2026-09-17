import { NextRequest, NextResponse } from "next/server";
import { hasValidAccessCookie } from "@/lib/auth/access";
import {
  LedgerConflictError,
  readLedgerFromSqlite,
  writeLedgerToSqlite,
} from "@/lib/ledger/repository";
import { createLedgerDocument, normalizeRecords } from "@/lib/ledger/schema";
import { ledgerLimits } from "@/lib/ledger/limits";
import { listPlayGames, listPurchasePlaySummaries } from "@/lib/play-history/repository";

type SavePayload = {
  records?: unknown;
  updatedAt?: unknown;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const document = await readLedgerFromSqlite();
    const authenticated = await hasValidAccessCookie(request);
    return NextResponse.json(
      {
        ...document,
        ...(authenticated
          ? {
              playSummaries: await listPurchasePlaySummaries(),
              libraryPlayGames: (await listPlayGames("recent", "desc", "")).filter(
                (game) => !game.platform.toLowerCase().includes("playstation"),
              ),
            }
          : {}),
      },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return storageFailure("读取数据库记录失败", error);
  }
}

export async function PUT(request: NextRequest) {
  if (!(await hasValidAccessCookie(request))) {
    return unauthorized();
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > ledgerLimits.maxRequestBytes)
    return NextResponse.json({ error: "导入数据超过 5MB 限制" }, { status: 413 });

  const payload = (await request.json().catch(() => ({}))) as SavePayload;

  if (!Array.isArray(payload.records)) {
    return NextResponse.json({ error: "records must be an array" }, { status: 400 });
  }
  if (payload.records.length > ledgerLimits.maxRecords)
    return NextResponse.json(
      { error: `记录数量不能超过 ${ledgerLimits.maxRecords} 条` },
      { status: 413 },
    );
  if (typeof payload.updatedAt !== "string")
    return NextResponse.json({ error: "缺少数据版本，请刷新后重试" }, { status: 400 });

  const records = normalizeRecords(payload.records);

  try {
    const document = createLedgerDocument(records);

    await writeLedgerToSqlite(document, payload.updatedAt);

    return NextResponse.json(document, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof LedgerConflictError)
      return NextResponse.json(
        { error: "数据已被其他页面更新，请刷新后再保存", conflict: true },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    return storageFailure("保存数据库记录失败", error);
  }
}

function unauthorized() {
  return NextResponse.json(
    { error: "unauthorized" },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

function storageFailure(action: string, error: unknown) {
  console.error(action, error);

  return NextResponse.json(
    { error: action },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}
