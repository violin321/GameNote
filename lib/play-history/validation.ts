import { createHash } from "node:crypto";
import type { CanonicalPlayGame, CanonicalPlaySession, ImportIssue, ImportPreview } from "./types";
import { playHistoryLimits } from "./types";

const allowedRootKeys = new Set(["version", "games"]);
const allowedGameKeys = new Set([
  "externalId",
  "title",
  "titleId",
  "officialUrl",
  "sessions",
  "observations",
]);
const allowedSessionKeys = new Set(["externalId", "startedAt", "endedAt", "durationSeconds"]);
const allowedObservationKeys = new Set([
  "externalId",
  "observedAt",
  "totalSeconds",
  "firstPlayedAt",
]);
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/;

export class ImportLimitError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "ImportLimitError";
  }
}

export function normalizeTitle(value: string) {
  return value
    .replace(/[™®©]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

export function normalizeOfficialUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "";
    const params = [...url.searchParams.entries()].filter(
      ([key]) => !key.toLowerCase().startsWith("utm_"),
    );
    url.search = "";
    for (const [key, item] of params) url.searchParams.append(key, item);
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
  if (value.version !== 1)
    issues.push({ index: 0, path: "$.version", message: "version 必须为 1" });
  if (!Array.isArray(value.games)) {
    issues.push({ index: 0, path: "$.games", message: "games 必须是数组" });
    return emptyPreview(issues);
  }
  if (value.games.length > playHistoryLimits.maxGames)
    throw new ImportLimitError(`游戏数量不能超过 ${playHistoryLimits.maxGames}`);

  let declaredSessions = 0;
  for (const entry of value.games) {
    if (isObject(entry)) {
      if (Array.isArray(entry.sessions)) declaredSessions += entry.sessions.length;
      if (Array.isArray(entry.observations)) declaredSessions += entry.observations.length;
      if (declaredSessions > playHistoryLimits.maxSessions)
        throw new ImportLimitError(`会话与观测总数不能超过 ${playHistoryLimits.maxSessions}`);
    }
  }

  const seenGames = new Set<string>();
  const seenSessions = new Set<string>();
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
    if (!externalId)
      issues.push({ index, path: `${path}.externalId`, message: "externalId 格式无效" });
    if (!title) issues.push({ index, path: `${path}.title`, message: "title 必须为 1-200 字符" });
    if (officialUrlInput && !officialUrl)
      issues.push({
        index,
        path: `${path}.officialUrl`,
        message: "officialUrl 必须是无凭据的 HTTPS URL",
      });
    const rawSessions = Array.isArray(entry.sessions) ? entry.sessions : [];
    const rawObservations = Array.isArray(entry.observations) ? entry.observations : [];
    if (!rawSessions.length && !rawObservations.length) {
      issues.push({
        index,
        path,
        message: "sessions 或 observations 必须至少有一项",
      });
      return;
    }
    sessionCount += rawSessions.length;
    if (externalId && seenGames.has(externalId)) duplicateGames += 1;
    if (externalId) seenGames.add(externalId);

    const sessions: CanonicalPlaySession[] = [];
    rawSessions.forEach((session, sessionIndex) => {
      const sessionPath = `${path}.sessions[${sessionIndex}]`;
      if (!isObject(session)) {
        issues.push({ index, path: sessionPath, message: "会话必须是对象" });
        return;
      }
      rejectUnknownKeys(session, allowedSessionKeys, sessionPath, index, issues);
      const sessionExternalId = safeId(session.externalId);
      const startedAt = safeDate(session.startedAt);
      const endedAt = safeDate(session.endedAt);
      const requestedDuration =
        typeof session.durationSeconds === "number" ? session.durationSeconds : null;
      const calculatedDuration =
        startedAt && endedAt
          ? Math.floor((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)
          : -1;
      const durationSeconds = requestedDuration ?? calculatedDuration;
      if (!sessionExternalId)
        issues.push({ index, path: `${sessionPath}.externalId`, message: "externalId 格式无效" });
      if (!startedAt)
        issues.push({
          index,
          path: `${sessionPath}.startedAt`,
          message: "startedAt 必须为 ISO 8601",
        });
      if (!endedAt)
        issues.push({ index, path: `${sessionPath}.endedAt`, message: "endedAt 必须为 ISO 8601" });
      if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 31_536_000)
        issues.push({
          index,
          path: `${sessionPath}.durationSeconds`,
          message: "durationSeconds 必须为 0-31536000 的整数",
        });
      if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt))
        issues.push({ index, path: sessionPath, message: "endedAt 不能早于 startedAt" });
      if (
        requestedDuration !== null &&
        calculatedDuration >= 0 &&
        Math.abs(requestedDuration - calculatedDuration) > 60
      )
        issues.push({
          index,
          path: `${sessionPath}.durationSeconds`,
          message: "durationSeconds 与起止时间偏差超过 60 秒",
        });
      if (sessionExternalId && seenSessions.has(sessionExternalId)) duplicateSessions += 1;
      if (sessionExternalId) seenSessions.add(sessionExternalId);
      if (
        sessionExternalId &&
        startedAt &&
        endedAt &&
        Number.isInteger(durationSeconds) &&
        durationSeconds >= 0 &&
        durationSeconds <= 31_536_000
      )
        sessions.push({ externalId: sessionExternalId, startedAt, endedAt, durationSeconds });
    });
    const observations = rawObservations.flatMap((observation, observationIndex) => {
      const observationPath = `${path}.observations[${observationIndex}]`;
      if (!isObject(observation)) {
        issues.push({ index, path: observationPath, message: "观测必须是对象" });
        return [];
      }
      rejectUnknownKeys(observation, allowedObservationKeys, observationPath, index, issues);
      const observationExternalId = safeId(observation.externalId);
      const observedAt = safeDate(observation.observedAt);
      const totalSeconds = observation.totalSeconds;
      const firstPlayedAt = safeDate(observation.firstPlayedAt, true);
      if (!observationExternalId)
        issues.push({
          index,
          path: `${observationPath}.externalId`,
          message: "externalId 格式无效",
        });
      if (!observedAt)
        issues.push({
          index,
          path: `${observationPath}.observedAt`,
          message: "observedAt 必须为 ISO 8601",
        });
      if (!Number.isInteger(totalSeconds) || Number(totalSeconds) < 0)
        issues.push({
          index,
          path: `${observationPath}.totalSeconds`,
          message: "totalSeconds 必须为非负整数",
        });
      if (firstPlayedAt && observedAt && Date.parse(firstPlayedAt) > Date.parse(observedAt))
        issues.push({
          index,
          path: `${observationPath}.firstPlayedAt`,
          message: "firstPlayedAt 不能晚于 observedAt",
        });
      if (observationExternalId && seenSessions.has(observationExternalId)) duplicateSessions += 1;
      if (observationExternalId) seenSessions.add(observationExternalId);
      if (observationExternalId && observedAt && Number.isInteger(totalSeconds))
        return [
          {
            externalId: observationExternalId,
            observedAt,
            totalSeconds: Number(totalSeconds),
            firstPlayedAt,
          },
        ];
      return [];
    });
    if (externalId && title && (sessions.length || observations.length))
      games.push({
        externalId,
        title,
        normalizedTitle: normalizeTitle(title),
        titleId,
        officialUrl,
        sessions,
        observations,
      });
  });

  return {
    valid: issues.length === 0,
    itemCount: value.games.length,
    sessionCount,
    duplicateGames,
    duplicateSessions,
    issues: issues.slice(0, 100),
    games,
  };
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  index: number,
  issues: ImportIssue[],
) {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) issues.push({ index, path: `${path}.${key}`, message: "不允许的字段" });
}
function safeId(value: unknown, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  return typeof value === "string" && idPattern.test(value) ? value : "";
}
function safeText(value: unknown, maximum: number, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  if (typeof value !== "string") return "";
  const result = value.trim();
  return result && result.length <= maximum ? result : "";
}
function safeDate(value: unknown, optional = false) {
  if ((value === undefined || value === null || value === "") && optional) return "";
  if (typeof value !== "string" || !isoDate.test(value) || !Number.isFinite(Date.parse(value)))
    return "";
  return new Date(value).toISOString();
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function emptyPreview(issues: ImportIssue[]): ImportPreview {
  return {
    valid: false,
    itemCount: 0,
    sessionCount: 0,
    duplicateGames: 0,
    duplicateSessions: 0,
    issues,
    games: [],
  };
}
function invalidRoot(path: string, message: string) {
  return emptyPreview([{ index: 0, path, message }]);
}
