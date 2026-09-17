import { NextRequest, NextResponse } from "next/server";
import { hasValidAccessCookie } from "@/lib/auth/access";
import { readLedgerFromSqlite } from "@/lib/ledger/repository";
import type { GameRecord } from "@/lib/ledger/schema";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await hasValidAccessCookie(request))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const ledger = await readLedgerFromSqlite();

    return NextResponse.json(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        records: ledger.records.map(stripVolatileRecordFields),
      },
      {
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="game-ledger-${new Date()
            .toISOString()
            .slice(0, 10)}.json"`,
        },
      },
    );
  } catch (error) {
    console.error("导出记录失败", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导出记录失败" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

function stripVolatileRecordFields(record: GameRecord) {
  return {
    id: record.id,
    platform: record.platform,
    title: record.title,
    price: record.price,
    currency: record.currency,
    purchaseDate: record.purchaseDate,
    region: record.region,
    format: record.format,
    seller: record.seller,
    coverUrl: record.coverUrl,
    officialUrl: record.officialUrl,
    notes: record.notes,
    soldDate: record.soldDate,
    soldPrice: record.soldPrice,
    soldCurrency: record.soldCurrency,
  };
}
