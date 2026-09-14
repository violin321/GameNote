export type Region = "日版" | "港版" | "台版" | "美版" | "欧版" | "其他";
export type GamePlatform = "Nintendo Switch" | "PlayStation";
export type GameFormat = "实体卡带" | "实体光盘" | "数字版";
export type Currency = "CNY" | "JPY" | "HKD" | "USD" | "EUR" | "BRL";
export type MembershipService = "Nintendo Switch Online" | "PlayStation Plus";

export type MembershipPeriod = {
  id: string;
  service: MembershipService;
  startDate: string;
  endDate: string;
  price: number;
  currency: Currency;
};

export type GameRecord = {
  id: string;
  sourceKey?: string;
  platform: GamePlatform;
  title: string;
  price: number;
  currency: Currency;
  purchaseDate: string;
  region: Region;
  format: GameFormat;
  seller: string;
  coverUrl: string;
  officialUrl: string;
  notes: string;
  soldDate: string;
  soldPrice: number;
  soldCurrency: Currency;
};

export type FormState = Omit<GameRecord, "id">;
export type AccessStatus = "checking" | "locked" | "unlocked";
export type SaveStatus = "idle" | "saving" | "saved" | "error";
export type ActiveView =
  | "records"
  | "form"
  | "settings"
  | "ps-plus-catalog"
  | "memberships"
  | "play-recent"
  | "play-history"
  | "play-unlinked";
export type RecordDisplayMode = "grid" | "list";

export type VersionInfo = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkedAt: string;
  stale?: boolean;
  error?: string;
};

export type ShareOptions = {
  showPrice: boolean;
  showSale: boolean;
  showDate: boolean;
  showNotes: boolean;
};

export type RecognizedGame = {
  title: string;
  price: number;
  currency: Currency;
  platform: GamePlatform;
  region: Region;
  format: GameFormat;
  seller: string;
  purchaseDate: string;
  notes: string;
  confidence: number;
  warning: string;
};

export type SettingsState = {
  siteTitle: string;
  avatarUrl: string;
  themeColor: string;
  showNintendoSwitch: boolean;
  showPlayStation: boolean;
  showPsPlusCatalog: boolean;
  showMemberships: boolean;
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  aiApiKeyConfigured: boolean;
  currentPassword: string;
  newPassword: string;
  psPlusEnabled: boolean;
  psPlusExpiresAt: string;
  psPlusAutoAddMonthly: boolean;
  nsOnlineEnabled: boolean;
  nsOnlineExpiresAt: string;
  membershipPeriods: MembershipPeriod[];
};

export type PsPlusCatalogGame = {
  id: string;
  title: string;
  localizedTitle: string;
  coverUrl: string;
  officialUrl: string;
  platforms: string[];
  tier: string;
};

export type PsPlusCatalog = {
  fetchedAt: string;
  games: PsPlusCatalogGame[];
  cached?: boolean;
  stale?: boolean;
};

export type HistoricalMonthlyGame = {
  title: string;
  sourceTitle: string;
  coverUrl: string;
  officialUrl: string;
  alreadyAdded: boolean;
};

export type NintendoCoverResult = {
  id: string;
  title: string;
  displayTitle?: string;
  coverUrl: string;
  officialUrl?: string;
  nintendoUrl?: string;
  platform: string;
  releaseDate: string | null;
  price: number | null;
  currency: string | null;
  source:
    | "mainland"
    | "hong-kong"
    | "algolia"
    | "page"
    | "playstation-hong-kong"
    | "playstation-page";
};

export type LedgerDocument = {
  version: 1;
  updatedAt: string;
  records: GameRecord[];
};

export type ExchangeRatePayload = {
  base: "CNY";
  date: string;
  rates: Partial<Record<Currency, number>>;
  source: string;
};

export type ToolbarItem = {
  id: string;
  label: string;
  icon: string;
  active: boolean;
  badge?: number;
  onSelect: () => void;
};

export type ToolbarGroup = { id: string; label: string; items: ToolbarItem[] };
