export const playHistoryLimits = {
  maxRequestBytes: 2 * 1024 * 1024,
  maxControlRequestBytes: 8 * 1024,
  maxGames: 500,
  maxSessions: 5_000,
  maxTitle: 200,
  maxExternalId: 160,
  maxUrl: 2_048,
} as const;

export type CanonicalPlaySession = {
  externalId: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
};

export type CanonicalPlayObservation = {
  externalId: string;
  observedAt: string;
  totalSeconds: number;
  firstPlayedAt: string;
};

export type CanonicalPlayGame = {
  externalId: string;
  title: string;
  normalizedTitle: string;
  titleId: string;
  officialUrl: string;
  sessions: CanonicalPlaySession[];
  observations: CanonicalPlayObservation[];
};

export type ImportIssue = { index: number; path: string; message: string };

export type ImportPreview = {
  valid: boolean;
  itemCount: number;
  sessionCount: number;
  duplicateGames: number;
  duplicateSessions: number;
  issues: ImportIssue[];
  games: CanonicalPlayGame[];
};

export type PlayGameSummary = {
  id: string;
  entityId: string;
  sourceGameId: string;
  source: "json_import" | "manual" | "nintendo_connector" | "nintendo_store" | "moon_connector";
  title: string;
  titleId: string;
  platform: string;
  officialUrl: string;
  coverUrl: string;
  totalSeconds: number;
  playDays: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
  timeSemantics: "play_timeline" | "snapshot_observation" | "daily_aggregate";
  sessionCount: number;
  link: null | {
    status: "suggested" | "confirmed" | "rejected";
    method: "title_id" | "official_url" | "normalized_title" | "manual";
    confidence: number;
    purchaseRecordId: string | null;
    purchaseTitle: string | null;
  };
};

export type RecentPlaySession = {
  id: string;
  gameId: string;
  title: string;
  coverUrl: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
};

export type RecentPlayActivity = {
  id: string;
  gameId: string;
  title: string;
  platform: string;
  coverUrl: string;
  occurredAt: string;
  endedAt: string | null;
  seconds: number;
  timeSemantics: PlayGameSummary["timeSemantics"];
  source: PlayGameSummary["source"];
  /** Official Moon calendar date; do not convert it through a browser time zone. */
  date: string | null;
  reportStatus: "CALCULATING" | "ACHIEVED" | "UNACHIEVED" | "UNKNOWN" | null;
};

export type ManualPlayEntryInput = {
  playGameId: string | null;
  purchaseRecordId: string | null;
  title: string;
  platform: string;
  startedAt: string;
  durationSeconds: number;
};

export type PlayGameDetail = PlayGameSummary & {
  sessions: Array<{
    id: string;
    source: "json_import" | "manual" | "nintendo_connector";
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
  }>;
  dailyReports: Array<{
    id: string;
    date: string;
    deviceId: string;
    seconds: number;
    reportStatus: NonNullable<RecentPlayActivity["reportStatus"]>;
    timeZoneOffsetSeconds: number;
  }>;
};

export type DashboardStats = {
  purchases: {
    total: number;
    nintendo: number;
    playStation: number;
    linked: number;
    unlinked: number;
  };
  play: null | {
    games: number;
    totalSeconds: number;
    sessions: number;
    lastPlayedAt: string | null;
    timeSemantics: PlayGameSummary["timeSemantics"] | "mixed";
  };
};

export type PurchasePlaySummary = {
  purchaseRecordId: string;
  totalSeconds: number;
  firstPlayedAt: string;
  lastPlayedAt: string;
  timeSemantics: PlayGameSummary["timeSemantics"] | "mixed";
};
