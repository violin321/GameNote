import { NextRequest, NextResponse } from "next/server";
import { hasValidAccessCookie } from "@/lib/auth/access";
import { createLedgerDocument, type GameRecord } from "@/lib/ledger/schema";
import {
  LedgerConflictError,
  readAppSettings,
  readLedgerFromSqlite,
  writeLedgerToSqlite,
} from "@/lib/ledger/repository";

export const runtime = "nodejs";
const feedUrl = "https://blog.playstation.com/category/ps-plus/feed/";

export async function POST(request: NextRequest) {
  if (!(await hasValidAccessCookie(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const settings = await readAppSettings();
  if (!settings.showPlayStation)
    return NextResponse.json({ added: 0, games: [], message: "PlayStation 游戏库未启用" });
  if (!settings.psPlusEnabled)
    return NextResponse.json({ added: 0, games: [], message: "PS Plus 会员未开启" });
  if (!settings.psPlusAutoAddMonthly)
    return NextResponse.json({ added: 0, games: [], message: "PS Plus 会免自动入库未开启" });
  if (
    settings.psPlusExpiresAt &&
    settings.psPlusExpiresAt < new Date().toISOString().slice(0, 10)
  ) {
    return NextResponse.json({ added: 0, games: [], message: "PS Plus 会员已到期" });
  }

  try {
    const response = await fetch(feedUrl, {
      headers: { "user-agent": "GameNote/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const monthly = parseMonthlyGames(await response.text());
    if (!monthly)
      return NextResponse.json({ added: 0, games: [], message: "暂未找到当月 PS Plus 会免阵容" });
    let additions: GameRecord[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ledger = await readLedgerFromSqlite();
      additions = monthly.games
        .filter(
          (title) =>
            !ledger.records.some(
              (record) =>
                record.notes.includes(`PS Plus 会免 ${monthly.month}`) &&
                normalizeTitle(record.title) === normalizeTitle(title),
            ),
        )
        .map((title): GameRecord => ({
          id: crypto.randomUUID(),
          platform: "PlayStation",
          title,
          price: 0,
          currency: "CNY",
          purchaseDate: new Date().toISOString().slice(0, 10),
          region: "其他",
          format: "数字版",
          seller: "PlayStation Plus",
          coverUrl: "",
          officialUrl: monthly.url,
          notes: `PS Plus 会免 ${monthly.month}`,
          soldDate: "",
          soldPrice: 0,
          soldCurrency: "CNY",
        }));
      if (!additions.length) break;
      try {
        await writeLedgerToSqlite(
          createLedgerDocument([...additions, ...ledger.records]),
          ledger.updatedAt,
        );
        break;
      } catch (error) {
        if (!(error instanceof LedgerConflictError) || attempt === 2) throw error;
      }
    }
    return NextResponse.json({
      added: additions.length,
      games: monthly.games,
      month: monthly.month,
      records: additions,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `PS Plus 会免同步失败：${error instanceof Error ? error.message : String(error)}` },
      { status: 502 },
    );
  }
}

function parseMonthlyGames(xml: string) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const match of items) {
    const item = match[1];
    const rawTitle = decodeEntities(textBetween(item, "title"));
    if (!/PlayStation Plus Monthly Games for/i.test(rawTitle) || /Game Catalog/i.test(rawTitle))
      continue;
    const monthName = rawTitle.match(/Monthly Games for ([A-Za-z]+)/i)?.[1];
    const currentMonth = new Date().toLocaleString("en-US", { month: "long" });
    if (!monthName || monthName.toLowerCase() !== currentMonth.toLowerCase()) continue;
    const separator = rawTitle.match(/(?:–|—|:| - )/);
    if (!separator || separator.index === undefined) continue;
    const games = rawTitle
      .slice(separator.index + separator[0].length)
      .split(/,| and /i)
      .map((title) => title.trim())
      .filter(Boolean);
    if (!games.length) continue;
    const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    return { games, month, url: decodeEntities(textBetween(item, "link")) };
  }
  return null;
}

function textBetween(value: string, tag: string) {
  return (
    value
      .match(
        new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"),
      )?.[1]
      ?.trim() || ""
  );
}
function decodeEntities(value: string) {
  return value
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "–")
    .replace(/&#8217;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "");
}
function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}
