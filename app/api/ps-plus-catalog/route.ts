import { NextRequest, NextResponse } from "next/server";
import { hasValidAccessCookie } from "@/lib/auth/access";
import { normalizeChineseGameTitle } from "@/lib/game/title-normalization";
import { readAppCache, readAppSettings, writeAppCache } from "@/lib/ledger/repository";

export const runtime = "nodejs";

const catalogUrl =
  "https://www.playstation.com/bin/imagic/gameslist?locale=zh-hans-hk&categoryList=plus-games-list";
const configuredRefreshHours = Number(process.env.PS_PLUS_CATALOG_REFRESH_HOURS || 12);
const cacheLifetime =
  (Number.isFinite(configuredRefreshHours) && configuredRefreshHours > 0
    ? configuredRefreshHours
    : 12) *
  60 *
  60 *
  1000;

type SourceGame = {
  conceptId?: number;
  name?: string;
  nameEn?: string;
  imageUrl?: string;
  conceptUrl?: string;
  device?: string[];
};
type SourceGroup = { games?: SourceGame[] };
type CatalogGame = {
  id: string;
  title: string;
  localizedTitle: string;
  coverUrl: string;
  officialUrl: string;
  platforms: string[];
  tier: string;
};
type CatalogPayload = { fetchedAt: string; games: CatalogGame[] };

const catalogCacheKey = "ps-plus-catalog-v1";

export async function GET(request: NextRequest) {
  const settings = await readAppSettings();
  if (!settings.showPlayStation || !settings.showPsPlusCatalog)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  if (force && !(await hasValidAccessCookie(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const storedCache = await readAppCache(catalogCacheKey).catch(() => null);
  const cachedPayload = normalizeCachedPayload(storedCache?.value);
  if (!force && cachedPayload && Date.parse(storedCache?.expiresAt || "") > Date.now()) {
    return NextResponse.json({ ...cachedPayload, cached: true });
  }

  try {
    const response = await fetch(catalogUrl, {
      cache: "no-store",
      headers: { "user-agent": "GameNote/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("完整目录返回 HTTP " + response.status);
    const games = normalizeCatalog((await response.json()) as SourceGroup[]);
    if (!games.length) throw new Error("完整目录暂时为空");
    const payload = { fetchedAt: new Date().toISOString(), games };
    await writeAppCache(
      catalogCacheKey,
      payload,
      new Date(Date.now() + cacheLifetime).toISOString(),
    ).catch((error) => console.error("PS Plus 游戏库缓存写入失败", error));
    return NextResponse.json({ ...payload, cached: false });
  } catch (error) {
    if (cachedPayload) return NextResponse.json({ ...cachedPayload, cached: true, stale: true });
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "PS Plus 游戏库更新失败：" + detail }, { status: 502 });
  }
}

function normalizeCachedPayload(value: unknown): CatalogPayload | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<CatalogPayload>;
  if (typeof source.fetchedAt !== "string" || !Array.isArray(source.games)) return null;
  const games = source.games.filter((game): game is CatalogGame =>
    Boolean(
      game &&
      typeof game === "object" &&
      typeof game.id === "string" &&
      typeof game.title === "string" &&
      typeof game.localizedTitle === "string" &&
      typeof game.coverUrl === "string" &&
      typeof game.officialUrl === "string" &&
      Array.isArray(game.platforms) &&
      typeof game.tier === "string",
    ),
  );
  return games.length ? { fetchedAt: source.fetchedAt, games } : null;
}

function normalizeCatalog(groups: SourceGroup[]): CatalogGame[] {
  const games = Array.isArray(groups)
    ? groups.flatMap((group) => (Array.isArray(group.games) ? group.games : []))
    : [];
  const seen = new Set<string>();
  return games.flatMap((game) => {
    const id = String(game.conceptId || game.nameEn || game.name || "");
    const title = cleanTitle(game.nameEn || game.name || "");
    if (!id || !title || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        title,
        localizedTitle: cleanTitle(game.name || title),
        coverUrl: typeof game.imageUrl === "string" ? game.imageUrl : "",
        officialUrl:
          typeof game.conceptUrl === "string" &&
          game.conceptUrl.startsWith("https://store.playstation.com/")
            ? game.conceptUrl
            : "https://store.playstation.com/zh-hans-hk/concept/" + id,
        platforms: Array.isArray(game.device)
          ? game.device.filter((item) => /^PS[45]$/i.test(item))
          : [],
        tier: "升级 / 高级",
      },
    ];
  });
}

function cleanTitle(value: string) {
  const normalized = normalizeChineseGameTitle(value).trim();
  const bracketedChinese = normalized.match(/^《([^》]*[\u3400-\u9fff][^》]*)》(?:\s+.+)?$/u)?.[1];
  return (bracketedChinese || normalized)
    .replace(/^《(.+)》$/u, "$1")
    .replace(/[《》]/g, "")
    .replace(/\s+(?:PS4\s*&\s*PS5|PS5\s*&\s*PS4|PS4|PS5)$/i, "")
    .trim();
}
