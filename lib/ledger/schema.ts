import {
  normalizeStoredGameTitle,
  stripPlayStationStoreTitleMetadata,
} from "@/lib/game/title-normalization";
import { ledgerLimits, limitText, validLedgerNumber } from "./limits";

export type Region = "日版" | "港版" | "台版" | "美版" | "欧版" | "其他";
export type GamePlatform = "Nintendo Switch" | "PlayStation";
export type GameFormat = "实体卡带" | "实体光盘" | "数字版";
export type Currency = "CNY" | "JPY" | "HKD" | "USD" | "EUR" | "BRL";

export type GameRecord = {
  id: string;
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

export type LedgerDocument = {
  version: 1;
  updatedAt: string;
  records: GameRecord[];
};

export const currencies = ["CNY", "JPY", "HKD", "USD", "EUR", "BRL"] as const;
export const gamePlatforms = ["Nintendo Switch", "PlayStation"] as const;
export const regions = ["日版", "港版", "台版", "美版", "欧版", "其他"] as const;
export const gameFormats = ["实体卡带", "实体光盘", "数字版"] as const;

export function createEmptyLedger(): LedgerDocument {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    records: [],
  };
}

export function createLedgerDocument(records: GameRecord[]): LedgerDocument {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    records,
  };
}

export function normalizeLedgerDocument(value: unknown): LedgerDocument {
  if (Array.isArray(value)) {
    return {
      ...createEmptyLedger(),
      records: normalizeRecords(value),
    };
  }

  const source = value && typeof value === "object" ? value : null;
  const rawRecords =
    source && "records" in source ? (source as { records?: unknown }).records : null;
  const updatedAt =
    source && "updatedAt" in source
      ? String((source as { updatedAt?: unknown }).updatedAt || "")
      : "";

  return {
    version: 1,
    updatedAt: updatedAt || new Date(0).toISOString(),
    records: Array.isArray(rawRecords) ? normalizeRecords(rawRecords) : [],
  };
}

export function normalizeRecords(values: unknown[]): GameRecord[] {
  return values
    .slice(0, ledgerLimits.maxRecords)
    .map(normalizeRecord)
    .filter((record): record is GameRecord => Boolean(record));
}

export function normalizeRecord(value: unknown): GameRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Partial<GameRecord> & {
    condition?: unknown;
    nintendoUrl?: unknown;
    playstationUrl?: unknown;
  };
  if (!record.title || typeof record.title !== "string") {
    return null;
  }

  const platform = gamePlatforms.includes(record.platform as GamePlatform)
    ? (record.platform as GamePlatform)
    : typeof record.playstationUrl === "string" && record.playstationUrl
      ? "PlayStation"
      : "Nintendo Switch";
  const currency = currencies.includes(record.currency as Currency)
    ? (record.currency as Currency)
    : "CNY";
  const region = regions.includes(record.region as Region) ? (record.region as Region) : "其他";
  const rawFormat = gameFormats.includes(record.format as GameFormat)
    ? (record.format as GameFormat)
    : record.condition === "数字版"
      ? "数字版"
      : physicalFormatForPlatform(platform);
  const format = normalizeFormatForPlatform(rawFormat, platform);
  const soldDate =
    isPhysicalFormat(format) && typeof record.soldDate === "string" && record.soldDate
      ? record.soldDate
      : "";
  const soldCurrency = currencies.includes(record.soldCurrency as Currency)
    ? (record.soldCurrency as Currency)
    : currency;
  const officialUrl =
    typeof record.officialUrl === "string"
      ? record.officialUrl
      : typeof record.nintendoUrl === "string"
        ? record.nintendoUrl
        : typeof record.playstationUrl === "string"
          ? record.playstationUrl
          : "";

  return {
    id: limitText(record.id, ledgerLimits.id) || createId(),
    platform,
    title: normalizeStoredGameTitle(
      limitText(
        platform === "PlayStation"
          ? stripPlayStationStoreTitleMetadata(record.title)
          : record.title,
        ledgerLimits.title,
      ),
    ),
    price: validLedgerNumber(record.price),
    currency,
    purchaseDate: typeof record.purchaseDate === "string" ? record.purchaseDate : "",
    region,
    format,
    seller: limitText(record.seller, ledgerLimits.seller),
    coverUrl: limitText(record.coverUrl, ledgerLimits.url),
    officialUrl: limitText(officialUrl, ledgerLimits.url),
    notes: limitText(record.notes, ledgerLimits.notes),
    soldDate,
    soldPrice: soldDate ? validLedgerNumber(record.soldPrice) : 0,
    soldCurrency,
  };
}

export function physicalFormatForPlatform(platform: GamePlatform): GameFormat {
  return platform === "PlayStation" ? "实体光盘" : "实体卡带";
}

export function normalizeFormatForPlatform(format: GameFormat, platform: GamePlatform): GameFormat {
  if (format === "数字版") {
    return format;
  }

  return physicalFormatForPlatform(platform);
}

export function isPhysicalFormat(format: GameFormat) {
  return format !== "数字版";
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
