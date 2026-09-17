export function isPlayStationPlatform(platform: string) {
  const normalized = platform.trim().toLowerCase();
  return normalized.includes("playstation") || /^ps(?:\s|\d|$)/.test(normalized);
}
