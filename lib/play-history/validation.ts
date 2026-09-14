import { createHash } from "node:crypto";
import { normalizeChineseSearchText } from "@/lib/game/title-normalization";
import type { CanonicalPlayGame, CanonicalPlaySession, ImportIssue, ImportPreview } from "./types";
import { defaultPlaySourceId, playHistoryLimits } from "./types";

const allowedRootKeys = new Set(["version", "sourceId", "games"]);
const allowedGameKeys = new Set([
  "externalId",
  "title",
  "titleId",
  "officialUrl",
  "platform",
  "sessions",
]);
const allowedSessionKeys = new Set([
  "externalId",
  "startedAt",
  "endedAt",
  "playedDate",
  "durationSeconds",
]);
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/;
const sourceIdPattern = /^[A-Za-z0-9._:-]{1,80}$/;
const unicodeMark = /^\p{Mark}$/u;
const latinCharacter = /^\p{Script=Latin}$/u;

export class ImportLimitError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "ImportLimitError";
  }
}

export function normalizeTitle(value: string) {
  const withoutMarks = value.replace(/[™®©]/g, "");
  const searchable = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(withoutMarks)
    ? withoutMarks
        .normalize("NFKC")
        .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
        .trim()
        .toLowerCase()
        .normalize("NFD")
    : normalizeChineseSearchText(withoutMarks).normalize("NFD");
  let normalized = "";
  let previousBaseIsLatin = false;
  for (const character of searchable) {
    if (unicodeMark.test(character)) {
      if (!previousBaseIsLatin) normalized += character;
      continue;
    }
    normalized += character;
    previousBaseIsLatin = latinCharacter.test(character);
  }
  return normalized.normalize("NFC").replace(/\s+/g, "");
}

export function normalizeOfficialUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "";
    const parameters = [...url.searchParams.entries()].filter(
      ([key]) => !key.toLowerCase().startsWith("utm_"),
    );
    url.search = "";
    for (const [key, item] of parameters) url.searchParams.append(key, item);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return "";
  }
}

export function payloadSha256(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

export function validateImportPayload(value: unknown): ImportPreview {
  const issues: ImportIssue[] = [];
  if (!isObject(value)) return invalidRoot("$", "根节点必须是对象");

  rejectUnknownKeys(value, allowedRootKeys, "$", 0, issues);
  const sourceId =
    value.sourceId === undefined ? defaultPlaySourceId : safeSourceId(value.sourceId);
  if (!sourceId) {
    issues.push({ index: 0, path: "$.sourceId", message: "sourceId 格式无效" });
  }
  if (value.version !== 1) {
    issues.push({ index: 0, path: "$.version", message: "version 必须为 1" });
  }
  if (!Array.isArray(value.games)) {
    issues.push({ index: 0, path: "$.games", message: "games 必须是数组" });
    return emptyPreview(issues);
  }
  if (value.games.length > playHistoryLimits.maxGames) {
    throw new ImportLimitError(`游戏数量不能超过 ${playHistoryLimits.maxGames}`);
  }

  let declaredSessions = 0;
  for (const entry of value.games) {
    if (!isObject(entry)) continue;
    if (Array.isArray(entry.sessions)) declaredSessions += entry.sessions.length;
    if (declaredSessions > playHistoryLimits.maxSessions) {
      throw new ImportLimitError(`会话与观测总数不能超过 ${playHistoryLimits.maxSessions}`);
    }
  }

  const seenGames = new Map<string, string>();
  const seenEvents = new Map<string, { gameExternalId: string; fingerprint: string }>();
  let duplicateGames = 0;
  let duplicateSessions = 0;
  let sessionCount = 0;
  const games: CanonicalPlayGame[] = [];

  value.games.forEach((entry, index) => {
    const path = `$.games[${index}]`;
    if (!isObject(entry)) {
      issues.push({ index, path, message: "游戏必须是对象" });
      return;
    }

    rejectUnknownKeys(entry, allowedGameKeys, path, index, issues);
    const externalId = safeId(entry.externalId);
    const title = safeText(entry.title, playHistoryLimits.maxTitle);
    const titleId = safeId(entry.titleId, true);
    const officialUrlInput = safeText(entry.officialUrl, playHistoryLimits.maxUrl, true);
    const officialUrl = normalizeOfficialUrl(officialUrlInput);
    const platform =
      entry.platform === undefined || entry.platform === "Nintendo Switch"
        ? "Nintendo Switch"
        : entry.platform === "PlayStation"
          ? "PlayStation"
          : null;

    if (!externalId) {
      issues.push({ index, path: `${path}.externalId`, message: "externalId 格式无效" });
    }
    if (!title) {
      issues.push({ index, path: `${path}.title`, message: "title 必须为 1-200 字符" });
    }
    if (officialUrlInput && !officialUrl) {
      issues.push({
        index,
        path: `${path}.officialUrl`,
        message: "officialUrl 必须是无凭据的 HTTPS URL",
      });
    }
    if (!platform) {
      issues.push({
        index,
        path: `${path}.platform`,
        message: "platform 必须为 Nintendo Switch 或 PlayStation",
      });
    }

    const rawSessions = Array.isArray(entry.sessions) ? entry.sessions : [];
    if (!rawSessions.length) {
      issues.push({ index, path: `${path}.sessions`, message: "sessions 必须至少有一项" });
      return;
    }
    sessionCount += rawSessions.length;
    const sessions = validateSessions(
      rawSessions,
      path,
      index,
      externalId,
      issues,
      seenEvents,
      () => {
        duplicateSessions += 1;
      },
    );
    if (externalId && title && platform && sessions.length) {
      const game: CanonicalPlayGame = {
        itemIndex: index,
        externalId,
        title,
        normalizedTitle: normalizeTitle(title),
        titleId,
        officialUrl,
        platform,
        sessions,
      };
      const fingerprint = gameFingerprint(game);
      const previousFingerprint = seenGames.get(externalId);
      if (previousFingerprint === undefined) {
        seenGames.set(externalId, fingerprint);
      } else if (previousFingerprint === fingerprint) {
        duplicateGames += 1;
      } else {
        issues.push({
          index,
          path: `${path}.externalId`,
          message: "同一 sourceId 内的 game externalId 对应不同规范化内容",
        });
      }
      games.push(game);
    }
  });

  return {
    valid: issues.length === 0,
    sourceId: sourceId || defaultPlaySourceId,
    itemCount: value.games.length,
    sessionCount,
    duplicateGames,
    duplicateSessions,
    existingGames: 0,
    existingSessions: 0,
    conflictingGames: 0,
    conflictingSessions: 0,
    issues: issues.slice(0, 100),
    games,
  };
}

function validateSessions(
  values: unknown[],
  gamePath: string,
  gameIndex: number,
  gameExternalId: string,
  issues: ImportIssue[],
  seenEvents: Map<string, { gameExternalId: string; fingerprint: string }>,
  recordDuplicate: () => void,
) {
  const sessions: CanonicalPlaySession[] = [];
  values.forEach((value, index) => {
    const path = `${gamePath}.sessions[${index}]`;
    if (!isObject(value)) {
      issues.push({ index: gameIndex, path, message: "会话必须是对象" });
      return;
    }
    rejectUnknownKeys(value, allowedSessionKeys, path, gameIndex, issues);
    const externalId = safeId(value.externalId);
    const startedAtInput = typeof value.startedAt === "string" ? value.startedAt : "";
    const startedAt = safeDate(startedAtInput);
    const endedAt = safeDate(value.endedAt);
    const hasPlayedDate = value.playedDate !== undefined;
    const playedDate = hasPlayedDate
      ? safeCalendarDate(value.playedDate)
      : safeCalendarDate(startedAtInput.slice(0, 10));
    const requestedDuration = Number.isInteger(value.durationSeconds)
      ? Number(value.durationSeconds)
      : null;
    const calculatedDuration =
      startedAt && endedAt ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000) : -1;
    const durationSeconds = requestedDuration ?? calculatedDuration;

    if (!externalId) {
      issues.push({ index: gameIndex, path: `${path}.externalId`, message: "externalId 格式无效" });
    }
    if (!startedAt) {
      issues.push({
        index: gameIndex,
        path: `${path}.startedAt`,
        message: "startedAt 必须为 ISO 8601",
      });
    }
    if (!endedAt) {
      issues.push({
        index: gameIndex,
        path: `${path}.endedAt`,
        message: "endedAt 必须为 ISO 8601",
      });
    }
    if (!playedDate) {
      issues.push({
        index: gameIndex,
        path: `${path}.playedDate`,
        message: "playedDate 必须为 YYYY-MM-DD；省略时会使用 startedAt 的来源本地日期",
      });
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 31_536_000) {
      issues.push({
        index: gameIndex,
        path: `${path}.durationSeconds`,
        message: "durationSeconds 必须为 0-31536000 的整数",
      });
    }
    if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
      issues.push({ index: gameIndex, path, message: "endedAt 不能早于 startedAt" });
    }
    if (
      requestedDuration !== null &&
      calculatedDuration >= 0 &&
      Math.abs(requestedDuration - calculatedDuration) > 60
    ) {
      issues.push({
        index: gameIndex,
        path: `${path}.durationSeconds`,
        message: "durationSeconds 与起止时间偏差超过 60 秒",
      });
    }
    if (
      externalId &&
      startedAt &&
      endedAt &&
      playedDate &&
      Number.isInteger(durationSeconds) &&
      durationSeconds >= 0 &&
      durationSeconds <= 31_536_000
    ) {
      const session = { externalId, startedAt, endedAt, playedDate, durationSeconds };
      if (gameExternalId) {
        const fingerprint = sessionFingerprint(session);
        const previous = seenEvents.get(externalId);
        if (!previous) {
          seenEvents.set(externalId, { gameExternalId, fingerprint });
        } else if (
          previous.gameExternalId === gameExternalId &&
          previous.fingerprint === fingerprint
        ) {
          recordDuplicate();
        } else {
          issues.push({
            index: gameIndex,
            path: `${path}.externalId`,
            message: "同一 sourceId 内的 session externalId 对应不同规范化内容或游戏",
          });
        }
      }
      sessions.push(session);
    }
  });
  return sessions;
}

function gameFingerprint(game: CanonicalPlayGame) {
  return JSON.stringify({
    normalizedTitle: game.normalizedTitle,
    titleId: game.titleId,
    officialUrl: game.officialUrl,
    platform: game.platform,
    sessions: [...game.sessions]
      .sort((left, right) => left.externalId.localeCompare(right.externalId))
      .map((session) => sessionFingerprint(session)),
  });
}

function sessionFingerprint(session: CanonicalPlaySession) {
  return JSON.stringify({
    externalId: session.externalId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    playedDate: session.playedDate,
    durationSeconds: session.durationSeconds,
  });
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  index: number,
  issues: ImportIssue[],
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ index, path: `${path}.${key}`, message: "不允许的字段" });
    }
  }
}

function safeId(value: unknown, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  return typeof value === "string" && idPattern.test(value) ? value : "";
}

function safeSourceId(value: unknown) {
  return typeof value === "string" && sourceIdPattern.test(value) ? value : "";
}

function safeText(value: unknown, maximum: number, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  if (typeof value !== "string") return "";
  const result = value.trim();
  return result && result.length <= maximum ? result : "";
}

function safeDate(value: unknown, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  if (typeof value !== "string" || !isoDate.test(value) || !Number.isFinite(Date.parse(value))) {
    return "";
  }
  return new Date(value).toISOString();
}

function safeCalendarDate(value: unknown) {
  if (typeof value !== "string" || !calendarDate.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function emptyPreview(issues: ImportIssue[]): ImportPreview {
  return {
    valid: false,
    sourceId: defaultPlaySourceId,
    itemCount: 0,
    sessionCount: 0,
    duplicateGames: 0,
    duplicateSessions: 0,
    existingGames: 0,
    existingSessions: 0,
    conflictingGames: 0,
    conflictingSessions: 0,
    issues,
    games: [],
  };
}

function invalidRoot(path: string, message: string) {
  return emptyPreview([{ index: 0, path, message }]);
}
