export const nintendoDataSource = {
  provider: "Nintendo Coral",
  coralVersion: "3.4.0",
  completeness:
    "Nintendo PlayLog is a read-only aggregate snapshot. Snapshot capturedAt is the observation time, not a claimed last-played timestamp or complete lifetime history.",
} as const;

export type NintendoConsentChallenge = {
  required: boolean;
  schema: string | null;
  version: number | null;
  recipient: string | null;
  riskNotice: string;
  riskNoticeHash: string | null;
};

export type NintendoStatus = {
  linked: boolean;
  provider: {
    mode: string;
    enabled: boolean;
    recipient: string | null;
    receipt: { status: string; version: number | null; recipient: string | null };
  };
  sync: {
    inFlight: boolean;
    lastSuccessAt: string | null;
    nextSyncAt: string | null;
    hasSnapshot: boolean;
    lastError: string | null;
  };
  readOnly: true;
};

export type NintendoPlayLog = {
  titleId?: string;
  name?: string;
  imageUrl?: string;
  officialUrl?: string;
  totalPlayTime?: number;
  firstPlayedAt?: string;
  lastPlayedAt?: string;
};

export type NintendoSnapshot = {
  schema: "gamenote.nintendo.readonly.v1";
  capturedAt: string;
  source: { provider: string; coralVersion: string; readOnly: true };
  currentUser?: { playLog?: NintendoPlayLog[] };
  userShow?: { playLog?: NintendoPlayLog[] };
  friends?: unknown[];
  presence?: unknown[];
};
