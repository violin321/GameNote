import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import { isPlayStationPlatform } from "@/lib/game/platform";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import { readAppSettings } from "@/lib/ledger/repository";
import {
  createManualPlayEntry,
  ImportInvalidError,
  ImportNotFoundError,
  listPlayGames,
} from "@/lib/play-history/repository";
import { playHistoryLimits } from "@/lib/play-history/types";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  const sort = request.nextUrl.searchParams.get("sort") || "recent";
  const direction = request.nextUrl.searchParams.get("direction") || "desc";
  const query = (request.nextUrl.searchParams.get("q") || "").slice(0, 100);
  const [settings, games] = await Promise.all([
    readAppSettings(),
    listPlayGames(sort, direction, query),
  ]);
  return NextResponse.json(
    {
      games: settings.showPlayStation
        ? games
        : games.filter((game) => !isPlayStationPlatform(game.platform)),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginWrite(request);
    const identity = await getAccessIdentity(request);
    if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { value: payload } = await readBoundedJson<Record<string, unknown>>(
      request,
      playHistoryLimits.maxControlRequestBytes,
    );
    const playGameId = optionalId(payload.playGameId);
    const purchaseRecordId = optionalId(payload.purchaseRecordId);
    const title = typeof payload.title === "string" ? payload.title.trim() : "";
    const platform = typeof payload.platform === "string" ? payload.platform.trim() : "";
    const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : "";
    const durationSeconds = Number(payload.durationSeconds);
    if ((!playGameId && !purchaseRecordId && !title) || title.length > playHistoryLimits.maxTitle)
      return NextResponse.json({ error: "请填写游戏名称或选择已有游戏" }, { status: 400 });
    if (platform.length > 80) return NextResponse.json({ error: "游戏平台过长" }, { status: 400 });
    if (isPlayStationPlatform(platform)) {
      const settings = await readAppSettings();
      if (!settings.showPlayStation)
        return NextResponse.json({ error: "PlayStation 游戏库当前未启用" }, { status: 400 });
    }
    if (!startedAt || !Number.isFinite(Date.parse(startedAt)))
      return NextResponse.json({ error: "游玩时间无效" }, { status: 400 });
    if (!Number.isInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 86_400)
      return NextResponse.json({ error: "游玩时长需为 1 分钟至 24 小时" }, { status: 400 });
    const result = await createManualPlayEntry(
      {
        playGameId,
        purchaseRecordId,
        title,
        platform: platform || "Nintendo Switch",
        startedAt: new Date(startedAt).toISOString(),
        durationSeconds,
      },
      identity.username,
    );
    return NextResponse.json(result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiRequestError)
      return NextResponse.json({ error: error.publicMessage }, { status: error.status });
    if (error instanceof ImportNotFoundError)
      return NextResponse.json({ error: "游玩游戏不存在" }, { status: 404 });
    if (error instanceof ImportInvalidError)
      return NextResponse.json({ error: "收藏记录不存在或已删除" }, { status: 422 });
    throw error;
  }
}

function optionalId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && value.length <= playHistoryLimits.maxExternalId
    ? value
    : null;
}
