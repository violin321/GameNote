type WikidataSearchResponse = {
  search?: Array<{ id?: string; description?: string }>;
};

type WikidataTextValue = { value?: string };

type WikidataEntityResponse = {
  entities?: Record<
    string,
    {
      labels?: Partial<Record<"en" | "zh" | "zh-cn" | "zh-hans" | "zh-hant", WikidataTextValue>>;
      sitelinks?: Partial<Record<"enwiki" | "zhwiki", { title?: string }>>;
    }
  >;
};

export type ResolvedGameTitle = {
  englishTitle: string;
  chineseTitle: string;
};

const hanPattern = /[\u3400-\u9fff]/u;
const titleCache = new Map<string, { expiresAt: number; value: ResolvedGameTitle[] }>();
const titleCacheTtl = 24 * 60 * 60 * 1000;

export async function resolveGameTitles(query: string): Promise<ResolvedGameTitle[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const cacheKey = normalizeComparableTitle(trimmed);
  const cached = titleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const searchLanguage = hanPattern.test(trimmed) ? "zh" : "en";
    const gameIds: string[] = [];

    for (const candidate of buildTitleLookupCandidates(trimmed)) {
      const searchUrl = new URL("https://www.wikidata.org/w/api.php");
      searchUrl.search = new URLSearchParams({
        action: "wbsearchentities",
        search: candidate,
        language: searchLanguage,
        uselang: searchLanguage,
        type: "item",
        limit: "6",
        format: "json",
        origin: "*",
      }).toString();

      const searchResponse = await fetch(searchUrl, {
        headers: { "user-agent": "GameNote/0.1 game title lookup" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!searchResponse.ok) {
        continue;
      }

      const searchPayload = (await searchResponse.json()) as WikidataSearchResponse;
      for (const item of searchPayload.search ?? []) {
        if (
          item.id &&
          /\bvideo game\b|\bgame\b|游戏|遊戲|電玩/i.test(item.description ?? "") &&
          !gameIds.includes(item.id)
        ) {
          gameIds.push(item.id);
        }
      }
    }

    if (!gameIds.length) {
      const fallback = await resolveTranslatedTitles(trimmed);
      cacheResolvedTitles(cacheKey, fallback);
      return fallback;
    }

    const entityUrl = new URL("https://www.wikidata.org/w/api.php");
    entityUrl.search = new URLSearchParams({
      action: "wbgetentities",
      ids: gameIds.join("|"),
      props: "labels|sitelinks",
      languages: "en|zh|zh-cn|zh-hans|zh-hant",
      sitefilter: "zhwiki|enwiki",
      format: "json",
      origin: "*",
    }).toString();

    const entityResponse = await fetch(entityUrl, {
      headers: { "user-agent": "GameNote/0.1 game title lookup" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!entityResponse.ok) {
      const fallback = await resolveTranslatedTitles(trimmed);
      cacheResolvedTitles(cacheKey, fallback);
      return fallback;
    }

    const entityPayload = (await entityResponse.json()) as WikidataEntityResponse;
    const resolved = gameIds
      .map((id) => {
        const entity = entityPayload.entities?.[id];
        const englishTitle = cleanWikipediaTitle(
          entity?.labels?.en?.value || entity?.sitelinks?.enwiki?.title || "",
        );
        const chineseTitle = cleanWikipediaTitle(
          entity?.labels?.["zh-cn"]?.value ||
            entity?.labels?.["zh-hans"]?.value ||
            entity?.labels?.zh?.value ||
            entity?.sitelinks?.zhwiki?.title ||
            (hanPattern.test(trimmed) ? trimmed : ""),
        );

        return { englishTitle, chineseTitle };
      })
      .filter((title) => title.englishTitle || title.chineseTitle)
      .slice(0, 8);

    const value = resolved.length ? resolved : await resolveTranslatedTitles(trimmed);
    cacheResolvedTitles(cacheKey, value);
    return value;
  } catch {
    return resolveTranslatedTitles(trimmed);
  }
}

export async function resolveEnglishGameTitles(query: string) {
  return (await resolveGameTitles(query)).map((title) => title.englishTitle).filter(Boolean);
}

export function findChineseGameTitle(officialTitle: string, resolvedTitles: ResolvedGameTitle[]) {
  const normalizedOfficial = normalizeComparableTitle(officialTitle);
  let bestMatch: { score: number; title: string } | null = null;

  for (const resolved of resolvedTitles) {
    if (!resolved.chineseTitle) {
      continue;
    }

    const normalizedEnglish = normalizeComparableTitle(resolved.englishTitle);
    if (!normalizedEnglish) {
      continue;
    }

    const localizedTitle = localizeResolvedTitle(officialTitle, resolved);
    const score = normalizedOfficial === normalizedEnglish ? 100 : localizedTitle ? 80 : 0;

    if (score && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { score, title: localizedTitle };
    }
  }

  return bestMatch?.title ?? "";
}

export async function resolveChineseGameTitle(query: string) {
  return findChineseGameTitle(query, await resolveGameTitles(query));
}

function buildTitleLookupCandidates(value: string) {
  const cleaned = value
    .replace(/^《(.+)》$/u, "$1")
    .replace(/[\u2122\u00ae©]/g, "")
    .trim();
  const candidates = new Set([cleaned]);
  const baseTitle = cleaned
    .replace(
      /(?:\s*[:\-]​?\s*|\s+)(?:digital\s+)?(?:director['’]s\s+cut|deluxe(?:\s+edition)?|ultimate(?:\s+edition)?|complete(?:\s+edition)?|definitive(?:\s+edition)?|gold(?:\s+edition)?|standard(?:\s+edition)?|collector['’]s(?:\s+edition)?|game\s+of\s+the\s+year(?:\s+edition)?|goty(?:\s+edition)?|enhanced(?:\s+edition)?|anniversary(?:\s+edition)?|royal(?:\s+edition)?|premium(?:\s+edition)?|remastered|remake)\s*$/iu,
      "",
    )
    .trim();

  if (baseTitle && baseTitle !== cleaned) {
    candidates.add(baseTitle);
  }

  return [...candidates].slice(0, 2);
}

function localizeResolvedTitle(officialTitle: string, resolved: ResolvedGameTitle) {
  const normalizedOfficial = normalizeComparableTitle(officialTitle);
  const normalizedEnglish = normalizeComparableTitle(resolved.englishTitle);

  if (!normalizedEnglish || !resolved.chineseTitle) {
    return "";
  }

  if (normalizedOfficial === normalizedEnglish) {
    return resolved.chineseTitle;
  }

  if (!normalizedOfficial.startsWith(`${normalizedEnglish} `)) {
    return "";
  }

  const suffix = normalizedOfficial.slice(normalizedEnglish.length).trim();
  const localizedSuffix = localizeEditionSuffix(suffix);
  return localizedSuffix ? `${resolved.chineseTitle}：${localizedSuffix}` : "";
}

function localizeEditionSuffix(value: string) {
  const normalized = value.replace(/^edition\s+/i, "").trim();
  const editions: Array<[RegExp, string]> = [
    [/^(?:digital )?director s cut$/i, "导演剪辑版"],
    [/^digital deluxe(?: edition)?$/i, "数字豪华版"],
    [/^deluxe(?: edition)?$/i, "豪华版"],
    [/^ultimate(?: edition)?$/i, "终极版"],
    [/^complete(?: edition)?$/i, "完整版"],
    [/^definitive(?: edition)?$/i, "决定版"],
    [/^gold(?: edition)?$/i, "黄金版"],
    [/^standard(?: edition)?$/i, "标准版"],
    [/^collector s(?: edition)?$/i, "收藏版"],
    [/^(?:game of the year|goty)(?: edition)?$/i, "年度版"],
    [/^enhanced(?: edition)?$/i, "增强版"],
    [/^anniversary(?: edition)?$/i, "纪念版"],
    [/^royal(?: edition)?$/i, "皇家版"],
    [/^premium(?: edition)?$/i, "高级版"],
    [/^(?:remastered|remake)$/i, "重制版"],
    [/^nintendo switch 2 edition(?: upgrade pack)?$/i, "Nintendo Switch 2版"],
    [/^nintendo switch 2 edition upgrade pack$/i, "Nintendo Switch 2版升级包"],
  ];

  return editions.find(([pattern]) => pattern.test(normalized))?.[1] ?? "";
}

function cacheResolvedTitles(key: string, value: ResolvedGameTitle[]) {
  if (titleCache.size >= 100) {
    const oldestKey = titleCache.keys().next().value;
    if (oldestKey) {
      titleCache.delete(oldestKey);
    }
  }

  titleCache.set(key, { expiresAt: Date.now() + titleCacheTtl, value });
}

async function resolveTranslatedTitles(query: string): Promise<ResolvedGameTitle[]> {
  const translated: ResolvedGameTitle[] = [];
  const candidates = buildTitleLookupCandidates(query);
  const translationCandidates = candidates.length > 1 ? candidates.slice(-1) : candidates;

  for (const candidate of translationCandidates) {
    const targetLanguage = hanPattern.test(candidate) ? "en" : "zh-CN";
    const translatedTitle = await translateTitle(candidate, targetLanguage);
    if (!translatedTitle) {
      continue;
    }

    translated.push(
      targetLanguage === "en"
        ? { englishTitle: translatedTitle, chineseTitle: candidate }
        : { englishTitle: candidate, chineseTitle: translatedTitle },
    );
  }

  return translated;
}

async function translateTitle(value: string, targetLanguage: "en" | "zh-CN") {
  try {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.search = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: targetLanguage,
      dt: "t",
      q: value,
    }).toString();
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 Game Purchase Ledger" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return "";
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
      return "";
    }

    return payload[0]
      .map((segment) =>
        Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "",
      )
      .join("")
      .replace(/《([^\u300b]+)》/gu, "$1")
      .trim();
  } catch {
    return "";
  }
}

function cleanWikipediaTitle(value: string) {
  return value.replace(/\s*[（(](?:video game|電子遊戲|电子游戏|遊戲|游戏)[）)]$/iu, "").trim();
}

function normalizeComparableTitle(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[™®©]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLowerCase();
}
