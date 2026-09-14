/** Moon reports are official calendar-day aggregates, never precise sessions. */
export type MoonDailyGame = {
  externalId: string;
  title: string;
  titleId: string;
  officialUrl: string;
  imageUrl: string;
  totalSeconds: number;
};

export type MoonDailyReport = {
  deviceId: string;
  date: string;
  timeZoneOffsetSeconds: number;
  result: "CALCULATING" | "ACHIEVED" | "UNACHIEVED" | "UNKNOWN";
  updatedAt: string | null;
  totalSeconds: number;
  games: MoonDailyGame[];
};

export type MoonSnapshot = {
  schema: "gamenote.moon.daily.v1";
  fetchedAt: string;
  /** Installation-keyed pseudonym, not the Nintendo account identifier. */
  accountScope: string;
  devices: Array<{ id: string }>;
  dailyReports: MoonDailyReport[];
};

export type MoonStatus = {
  configured: boolean;
  linked: boolean;
  pendingAuthorization: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextSyncAt: string | null;
  syncing: boolean;
  deviceCount: number;
  reportCount: number;
  latestReportDate: string | null;
  scheduler: { enabled: boolean; intervalSeconds: number };
};

export type MoonImportResult = {
  importedReports: number;
  importedGames: number;
  replayed: boolean;
  latestDate: string | null;
};
