import { createHmac } from "node:crypto";
import { MoonError } from "./security.mjs";
import { validatedId } from "./nintendo.mjs";

function invalid() {
  throw new MoonError("moon_invalid_upstream_data");
}
function seconds(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 31 * 86400) invalid();
  return value;
}
function applicationId(value) {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{16}$/.test(value)) invalid();
  return value.toLowerCase();
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function officialDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = new Date(value + "T00:00:00.000Z");
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function httpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
    if (!/(^|\.)(nintendo\.(com|net|co\.jp)|nintendo-europe\.com)$/.test(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}
export function pseudonym(key, type, value) {
  return `moon_${type}_${createHmac("sha256", key)
    .update(type + "\0" + value)
    .digest("hex")
    .slice(0, 40)}`;
}

/** nxapi moon-types DailySummary: playingTime is seconds; playedApps itself has no duration. */
export function normalizeMoonSnapshot(raw, installationKey, fetchedAt = new Date().toISOString()) {
  const accountId = validatedId(raw.accountId);
  const devices = [];
  const dailyReports = [];
  const deviceSeen = new Set();
  for (const entry of array(raw.devices, 16)) {
    const rawDeviceId = validatedId(entry.deviceId);
    const deviceId = pseudonym(installationKey, "device", accountId + "\0" + rawDeviceId);
    if (deviceSeen.has(deviceId)) invalid();
    deviceSeen.add(deviceId);
    devices.push({ id: deviceId });
    const dates = new Set();
    for (const report of array(entry.reports, 400)) {
      if (report.deviceId !== rawDeviceId) invalid();
      const date = officialDate(report.date);
      if (dates.has(date)) invalid();
      dates.add(date);
      const offset = report.timeZoneUtcOffsetSeconds;
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 14 * 3600) invalid();
      const games = new Map();
      for (const title of array(report.playedApps, 500)) {
        const titleId = applicationId(title.applicationId);
        if (
          games.has(titleId) ||
          typeof title.title !== "string" ||
          !title.title.trim() ||
          title.title.length > 512
        )
          invalid();
        games.set(titleId, {
          externalId: `moon:${titleId}`,
          title: title.title.trim().slice(0, 200),
          titleId,
          officialUrl: httpsUrl(title.shopUri),
          imageUrl: httpsUrl(title.imageUri?.medium || title.imageUri?.large || ""),
          totalSeconds: 0,
        });
      }
      const players = [...array(report.devicePlayers, 16)];
      const playerIds = new Set();
      for (const player of players) {
        const playerId = validatedId(player.playerId);
        if (playerIds.has(playerId)) invalid();
        playerIds.add(playerId);
      }
      if (report.anonymousPlayer != null) players.push(report.anonymousPlayer);
      const measuredTitles = new Set();
      for (const player of players) {
        const played = new Set();
        for (const title of array(player.playedApps, 500)) {
          const titleId = applicationId(title.applicationId);
          const game = games.get(titleId);
          if (!game || played.has(titleId)) invalid();
          played.add(titleId);
          game.totalSeconds = seconds(game.totalSeconds + seconds(title.playingTime));
          measuredTitles.add(titleId);
        }
      }
      // A title catalog entry is not proof of zero time. The v1 contract has no
      // unknown-duration value, so retain the previous snapshot if duration is absent.
      for (const titleId of games.keys()) if (!measuredTitles.has(titleId)) invalid();
      let updatedAt = null;
      if (report.updatedAt != null) {
        if (
          !Number.isSafeInteger(report.updatedAt) ||
          report.updatedAt < 0 ||
          report.updatedAt > 4_102_444_800_000
        )
          invalid();
        // Moon timestamps are Unix seconds (see nxapi pctl/devices.ts). Accept an
        // explicit millisecond magnitude too, never interpret 10-digit seconds as 1970.
        const milliseconds =
          report.updatedAt <= 4_102_444_800 ? report.updatedAt * 1000 : report.updatedAt;
        if (milliseconds > 4_102_444_800 && milliseconds < 946_684_800_000) invalid();
        updatedAt = new Date(milliseconds).toISOString();
      }
      dailyReports.push({
        deviceId,
        date,
        timeZoneOffsetSeconds: offset,
        result: ["CALCULATING", "ACHIEVED", "UNACHIEVED"].includes(report.result)
          ? report.result
          : "UNKNOWN",
        updatedAt,
        totalSeconds: seconds(report.playingTime),
        games: [...games.values()].sort((a, b) => a.externalId.localeCompare(b.externalId)),
      });
    }
  }
  dailyReports.sort((a, b) => a.date.localeCompare(b.date) || a.deviceId.localeCompare(b.deviceId));
  return {
    schema: "gamenote.moon.daily.v1",
    fetchedAt,
    accountScope: pseudonym(installationKey, "account", accountId),
    devices,
    dailyReports,
  };
}
