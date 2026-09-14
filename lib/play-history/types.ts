import type { GamePlatform } from "@/lib/ledger/schema";

export const playHistoryLimits = {
  maxRequestBytes: 2 * 1024 * 1024,
  maxControlRequestBytes: 8 * 1024,
  maxGames: 500,
  maxSessions: 5_000,
  maxTitle: 200,
  maxExternalId: 160,
  maxSourceId: 80,
  maxUrl: 2_048,
} as const;

export type PlaySource = "json_import" | "manual" | "moon_connector" | "nintendo_store";

export type PlayTimeSemantics = "play_timeline" | "daily_aggregate" | "snapshot_observation";

export type PlayObservationSemantics = Exclude<PlayTimeSemantics, "play_timeline">;
export type PlayReportStatus = "CALCULATING" | "ACHIEVED" | "UNACHIEVED" | "UNKNOWN";

export const defaultPlaySourceId = "default";

export type CanonicalPlaySession = {
  externalId: string;
  startedAt: string;
  endedAt: string;
  playedDate: string;
  durationSeconds: number;
};

export type CanonicalPlayGame = {
  itemIndex: number;
  externalId: string;
  title: string;
  normalizedTitle: string;
  titleId: string;
  officialUrl: string;
  platform: GamePlatform;
  sessions: CanonicalPlaySession[];
};

export type ImportIssue = {
  index: number;
  path: string;
  message: string;
};

export type ImportPreview = {
  valid: boolean;
  sourceId: string;
  itemCount: number;
  sessionCount: number;
  duplicateGames: number;
  duplicateSessions: number;
  existingGames: number;
  existingSessions: number;
  conflictingGames: number;
  conflictingSessions: number;
  issues: ImportIssue[];
  games: CanonicalPlayGame[];
};

export type PlayPurchaseLink = {
  status: "suggested" | "confirmed" | "rejected";
  method: "official_url" | "normalized_title" | "manual";
  confidence: number;
  purchaseRecordId: string | null;
  purchaseTitle: string | null;
};

export type PlayGameSummary = {
  id: string;
  source: PlaySource;
  sourceId: string;
  aggregateKey: string;
  title: string;
  titleId: string;
  platform: GamePlatform;
  officialUrl: string;
  coverUrl: string;
  totalSeconds: number;
  playDays: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
  timeSemantics: PlayTimeSemantics;
  sessionCount: number;
  observationCount: number;
  link: PlayPurchaseLink | null;
};

type RecentPlayActivityBase = {
  id: string;
  gameId: string;
  sourceId: string;
  title: string;
  coverUrl: string;
  playedDate: string;
  durationSeconds: number;
  source: PlaySource;
  link: PlayPurchaseLink | null;
};

export type RecentPlayActivity =
  | (RecentPlayActivityBase & {
      startedAt: string;
      endedAt: string;
      timeSemantics: "play_timeline";
      reportStatus: null;
    })
  | (RecentPlayActivityBase & {
      startedAt: null;
      endedAt: null;
      timeSemantics: "daily_aggregate";
      reportStatus: PlayReportStatus | null;
    });

/** Backward-compatible API name; recent activity now also includes daily observations. */
export type RecentPlaySession = RecentPlayActivity;
