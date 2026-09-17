import type { Currency, FormState, GameFormat, GamePlatform, Region } from "./types";

export const storageKey = "switch-cartridge-ledger";
export const exchangeCacheKey = "switch-ledger-exchange-rates-v1";
export const currencies = [
  "CNY",
  "JPY",
  "HKD",
  "USD",
  "EUR",
  "BRL",
] as const satisfies readonly Currency[];
export const gamePlatforms = [
  "Nintendo Switch",
  "PlayStation",
] as const satisfies readonly GamePlatform[];
export const regions = [
  "日版",
  "港版",
  "台版",
  "美版",
  "欧版",
  "其他",
] as const satisfies readonly Region[];
export const gameFormats = [
  "实体卡带",
  "实体光盘",
  "数字版",
] as const satisfies readonly GameFormat[];
export const catalogPageSize = 24;

export const emptyForm: FormState = {
  platform: "Nintendo Switch",
  title: "",
  price: 0,
  currency: "CNY",
  purchaseDate: "",
  region: "日版",
  format: "实体卡带",
  seller: "",
  coverUrl: "",
  officialUrl: "",
  notes: "",
  soldDate: "",
  soldPrice: 0,
  soldCurrency: "CNY",
};
