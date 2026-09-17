import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import {
  createCollectionFromPlayGame,
  LedgerPlayGameNotFoundError,
  type PlayCollectionInput,
} from "@/lib/ledger/repository";
import { ledgerLimits, limitText, validLedgerNumber } from "@/lib/ledger/limits";
import { playHistoryLimits } from "@/lib/play-history/types";

export const runtime = "nodejs";

const formats = new Set(["实体卡带", "实体光盘", "数字版"]);
const regions = new Set(["日版", "港版", "台版", "美版", "欧版", "其他"]);
const currencies = new Set(["CNY", "JPY", "HKD", "USD", "EUR", "BRL"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginWrite(request);
    const identity = await getAccessIdentity(request);
    if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;
    if (!id || id.length > playHistoryLimits.maxExternalId)
      return NextResponse.json({ error: "游玩游戏不存在" }, { status: 404 });
    const { value: payload } = await readBoundedJson<Record<string, unknown>>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    const input = normalizeCollectionInput(payload);
    if (!input) return NextResponse.json({ error: "收藏资料无效" }, { status: 400 });
    const result = await createCollectionFromPlayGame(id, input, identity.username);
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiRequestError)
      return NextResponse.json({ error: error.publicMessage }, { status: error.status });
    if (error instanceof LedgerPlayGameNotFoundError)
      return NextResponse.json({ error: "游玩游戏不存在" }, { status: 404 });
    throw error;
  }
}

function normalizeCollectionInput(payload: Record<string, unknown>): PlayCollectionInput | null {
  const format =
    typeof payload.format === "string" && formats.has(payload.format)
      ? (payload.format as PlayCollectionInput["format"])
      : null;
  const region =
    typeof payload.region === "string" && regions.has(payload.region)
      ? (payload.region as PlayCollectionInput["region"])
      : null;
  const currency =
    typeof payload.currency === "string" && currencies.has(payload.currency)
      ? (payload.currency as PlayCollectionInput["currency"])
      : null;
  const soldCurrency =
    typeof payload.soldCurrency === "string" && currencies.has(payload.soldCurrency)
      ? (payload.soldCurrency as PlayCollectionInput["soldCurrency"])
      : currency;
  const purchaseDate = typeof payload.purchaseDate === "string" ? payload.purchaseDate : "";
  const soldDate = typeof payload.soldDate === "string" ? payload.soldDate : "";
  if (
    !format ||
    !region ||
    !currency ||
    !soldCurrency ||
    (purchaseDate && !datePattern.test(purchaseDate)) ||
    (soldDate && !datePattern.test(soldDate))
  )
    return null;
  const physical = format !== "数字版";
  return {
    ...(typeof payload.title === "string"
      ? { title: limitText(payload.title, ledgerLimits.title) }
      : {}),
    ...(typeof payload.coverUrl === "string"
      ? { coverUrl: limitText(payload.coverUrl, ledgerLimits.url) }
      : {}),
    ...(typeof payload.officialUrl === "string"
      ? { officialUrl: limitText(payload.officialUrl, ledgerLimits.url) }
      : {}),
    format,
    region,
    purchaseDate,
    seller: limitText(payload.seller, ledgerLimits.seller),
    price: validLedgerNumber(payload.price),
    currency,
    notes: limitText(payload.notes, ledgerLimits.notes),
    soldDate: physical ? soldDate : "",
    soldPrice: physical && soldDate ? validLedgerNumber(payload.soldPrice) : 0,
    soldCurrency,
  };
}
