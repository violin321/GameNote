import { normalizeChineseSearchText } from "@/lib/game/title-normalization";
import { currencies, emptyForm } from "./constants";
import type {
  ActiveView,
  Currency,
  ExchangeRatePayload,
  FormState,
  GameFormat,
  GamePlatform,
  GameRecord,
  NintendoCoverResult,
  Region,
  SaveStatus,
  ShareOptions,
} from "./types";

const currencyFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function formatMoney(value: number, currency: Currency) {
  const symbol = { CNY: "¥", JPY: "¥", HKD: "HK$", USD: "$", EUR: "€", BRL: "R$" }[currency];
  return `${symbol}${currencyFormatter.format(value)}`;
}

export function currencyLabel(currency: Currency) {
  return {
    CNY: "CNY 人民币",
    JPY: "JPY 日元",
    HKD: "HKD 港币",
    USD: "USD 美元",
    EUR: "EUR 欧元",
    BRL: "BRL 巴西雷亚尔",
  }[currency];
}

export function platformLabel(platform: GamePlatform) {
  return { "Nintendo Switch": "Nintendo Switch", PlayStation: "PlayStation" }[platform];
}

export function physicalFormatForPlatform(platform: GamePlatform): GameFormat {
  return platform === "PlayStation" ? "实体光盘" : "实体卡带";
}

export function formatOptionsForPlatform(platform: GamePlatform): GameFormat[] {
  return [physicalFormatForPlatform(platform), "数字版"];
}

export function normalizeFormatForPlatform(format: GameFormat, platform: GamePlatform): GameFormat {
  return format === "数字版" ? format : physicalFormatForPlatform(platform);
}

export function isPhysicalFormat(format: GameFormat) {
  return format !== "数字版";
}
export function officialUrlLabel(platform: GamePlatform) {
  return platform === "PlayStation" ? "PlayStation 页面" : "Nintendo 页面";
}
export function officialUrlPlaceholder(platform: GamePlatform) {
  return platform === "PlayStation"
    ? "https://store.playstation.com/zh-hant-hk/product/..."
    : "https://www.nintendo.com/...";
}

export function isSafeOfficialUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function convertToCny(
  amount: number,
  currency: Currency,
  exchangeRates: ExchangeRatePayload | null,
) {
  if (currency === "CNY") return amount;
  const rate = exchangeRates?.rates[currency];
  return typeof rate === "number" && Number.isFinite(rate) ? amount * rate : null;
}

export function sumRecordsInCny(
  records: GameRecord[],
  exchangeRates: ExchangeRatePayload | null,
  valueForRecord: (record: GameRecord) => { amount: number; currency: Currency } | null,
) {
  return records.reduce(
    (sum, record) => {
      const value = valueForRecord(record);
      if (!value) return sum;
      const cnyValue = convertToCny(value.amount, value.currency, exchangeRates);
      return cnyValue === null
        ? { total: sum.total, missingRates: true }
        : { total: sum.total + cnyValue, missingRates: sum.missingRates };
    },
    { total: 0, missingRates: false },
  );
}

export function formatCnyTotal(total: number, missingRates: boolean) {
  return `${missingRates ? "部分 " : ""}${formatMoney(total, "CNY")}`;
}

export function formatCnyConversion(
  amount: number,
  currency: Currency,
  exchangeRates: ExchangeRatePayload | null,
) {
  if (currency === "CNY") return "";
  const cnyValue = convertToCny(amount, currency, exchangeRates);
  return cnyValue === null ? "等待汇率" : `≈ ${formatMoney(cnyValue, "CNY")}`;
}

export function coverLabel(title: string) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export function coverSourceLabel(source: NintendoCoverResult["source"]) {
  return {
    mainland: "大陆站",
    "hong-kong": "香港站",
    algolia: "美国站",
    page: "页面",
    "playstation-hong-kong": "PS 香港",
    "playstation-page": "PS 页面",
  }[source];
}

export function normalizeLookupCurrency(value: string | null): Currency | null {
  return currencies.includes(value as Currency) ? (value as Currency) : null;
}

export function lookupPriceLabel(result: NintendoCoverResult) {
  const currency = normalizeLookupCurrency(result.currency);
  return result.price !== null && currency ? formatMoney(result.price, currency) : "";
}

function loadShareCover(url: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    if (!url) return resolve(null);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = `/api/share-cover?url=${encodeURIComponent(url)}`;
  });
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function truncateCanvasText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (context.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

export const maxShareImageRecords = 160;

export async function createLibraryShareImage(records: GameRecord[], options: ShareOptions) {
  const visibleRecords = records.slice(0, maxShareImageRecords);
  const width = 1200;
  const columns = 4;
  const gap = 18;
  const pagePadding = 48;
  const cardWidth = (width - pagePadding * 2 - gap * (columns - 1)) / columns;
  const coverHeight = (cardWidth * 9) / 16;
  const detailLines =
    Number(options.showPrice) +
    Number(options.showDate) +
    Number(options.showSale) +
    Number(options.showNotes);
  const cardHeight = coverHeight + 76 + detailLines * 24;
  const rows = Math.max(1, Math.ceil(visibleRecords.length / columns));
  const headerHeight = 170;
  const footerHeight = 72;
  const height = headerHeight + rows * cardHeight + (rows - 1) * gap + footerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建分享图片");

  context.fillStyle = "#f5eee8";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#b9472f";
  context.fillRect(0, 0, width, 10);
  context.fillStyle = "#3c302b";
  context.font = "700 42px Arial, sans-serif";
  context.fillText("我的游戏收藏", pagePadding, 78);
  context.fillStyle = "#786b65";
  context.font = "24px Arial, sans-serif";
  context.fillText(
    records.length > visibleRecords.length
      ? `共 ${records.length} 款，本图展示前 ${visibleRecords.length} 款`
      : `共 ${records.length} 款游戏`,
    pagePadding,
    120,
  );
  context.textAlign = "right";
  context.fillText(new Date().toLocaleDateString("zh-CN"), width - pagePadding, 120);
  context.textAlign = "left";

  const covers = await mapWithConcurrency(visibleRecords, 6, (record) =>
    loadShareCover(record.coverUrl),
  );
  visibleRecords.forEach((record, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = pagePadding + column * (cardWidth + gap);
    const y = headerHeight + row * (cardHeight + gap);
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.roundRect(x, y, cardWidth, cardHeight, 8);
    context.fill();
    context.save();
    context.beginPath();
    context.roundRect(x, y, cardWidth, coverHeight, [8, 8, 0, 0]);
    context.clip();
    context.fillStyle = "#b9472f";
    context.fillRect(x, y, cardWidth, coverHeight);
    const cover = covers[index];
    if (cover) drawCoverImage(context, cover, x, y, cardWidth, coverHeight);
    else {
      context.fillStyle = "#ffffff";
      context.font = "700 28px Arial, sans-serif";
      context.textAlign = "center";
      context.fillText(
        coverLabel(record.title) || "GAME",
        x + cardWidth / 2,
        y + coverHeight / 2 + 10,
      );
      context.textAlign = "left";
    }
    context.restore();

    let textY = y + coverHeight + 34;
    context.fillStyle = "#3c302b";
    context.font = "700 20px Arial, sans-serif";
    context.fillText(truncateCanvasText(context, record.title, cardWidth - 28), x + 14, textY);
    textY += 27;
    context.fillStyle = "#786b65";
    context.font = "16px Arial, sans-serif";
    context.fillText(
      `${record.platform === "PlayStation" ? "PS" : "NS"} · ${record.region} · ${record.format}`,
      x + 14,
      textY,
    );
    const details: Array<{ text: string; color?: string }> = [];
    if (options.showPrice)
      details.push({
        text: `买入 ${formatMoney(record.price, record.currency)}`,
        color: "#b9472f",
      });
    if (options.showDate) details.push({ text: `购买于 ${record.purchaseDate}` });
    if (options.showSale)
      details.push({
        text: record.soldDate
          ? `已卖出 ${formatMoney(record.soldPrice, record.soldCurrency)} · ${record.soldDate}`
          : "持有中",
        color: record.soldDate ? "#287a50" : undefined,
      });
    if (options.showNotes)
      details.push({ text: record.notes ? `备注 ${record.notes}` : "备注 无" });
    context.font = "15px Arial, sans-serif";
    details.forEach((detail) => {
      textY += 24;
      context.fillStyle = detail.color || "#786b65";
      context.fillText(truncateCanvasText(context, detail.text, cardWidth - 28), x + 14, textY);
    });
  });
  context.fillStyle = "#8b7d76";
  context.font = "16px Arial, sans-serif";
  context.textAlign = "center";
  context.fillText("GameNote", width / 2, height - 28);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("图片生成失败"))),
      "image/png",
    );
  });
}

async function mapWithConcurrency<T, Result>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<Result>,
) {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function saveStatusLabel(status: SaveStatus) {
  return { idle: "", saving: "保存中", saved: "已保存", error: "保存失败" }[status];
}
export function todayString() {
  return new Date().toISOString().slice(0, 10);
}
export function defaultRegionForPlatform(platform: GamePlatform): Region {
  return platform === "PlayStation" ? "港版" : "日版";
}
export function createEmptyForm(platform: GamePlatform = "Nintendo Switch"): FormState {
  return {
    ...emptyForm,
    platform,
    region: defaultRegionForPlatform(platform),
    format: physicalFormatForPlatform(platform),
    purchaseDate: todayString(),
  };
}
export function platformPath(platform: GamePlatform) {
  return platform === "PlayStation" ? "/playstation" : "/nintendo-switch";
}
export function platformFromPath(pathname: string): GamePlatform | null {
  if (pathname.startsWith("/memberships") || pathname.startsWith("/play/"))
    return "Nintendo Switch";
  if (pathname.startsWith("/ps-plus-catalog") || pathname.startsWith("/playstation"))
    return "PlayStation";
  if (pathname === "/" || pathname.startsWith("/nintendo-switch")) return "Nintendo Switch";
  return null;
}
export function setPlatformUrl(platform: GamePlatform, mode: "push" | "replace") {
  if (typeof window === "undefined" || window.location.pathname === platformPath(platform)) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](
    { platform },
    "",
    platformPath(platform),
  );
}
export function setViewUrl(view: ActiveView, mode: "push" | "replace" = "push") {
  if (typeof window === "undefined") return;
  const path =
    view === "ps-plus-catalog"
      ? "/ps-plus-catalog"
      : view === "memberships"
        ? "/memberships"
        : view === "play-recent"
          ? "/play/recent"
          : view === "play-history"
            ? "/play/history"
            : view === "play-unlinked"
              ? "/play/unlinked"
              : platformPath(platformFromPath(window.location.pathname) || "Nintendo Switch");
  if (window.location.pathname === path) return;
  window.history[mode === "push" ? "pushState" : "replaceState"]({ view }, "", path);
}
export function textMatchesQuery(value: string, normalizedQuery: string) {
  const normalizedValue = normalizeChineseSearchText(value);
  const compactValue = normalizedValue.replace(/\s+/g, "");
  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  return (
    normalizedValue.includes(normalizedQuery) ||
    (Boolean(compactQuery) && compactValue.includes(compactQuery))
  );
}
