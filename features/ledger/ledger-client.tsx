"use client";

import Link from "next/link";
import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { normalizeChineseSearchText } from "@/lib/game/title-normalization";
import { ledgerLimits } from "@/lib/ledger/limits";
import { defaultThemeColor, themeColorContent } from "@/lib/ui/theme-color";
import {
  shellAuthChangedEvent,
  shellAuthRequestedEvent,
  shellSettingsChangedEvent,
} from "@/features/app-shell/app-shell";
import { Stat } from "./components/app-toolbar";
import type { DashboardStats } from "@/lib/play-history/types";
import {
  catalogPageSize,
  currencies,
  emptyForm,
  exchangeCacheKey,
  gamePlatforms,
  regions,
} from "./constants";
import { MembershipPage, SettingsPage } from "./components/settings-pages";
import { PsPlusCatalogPage } from "./components/ps-plus-catalog-page";
import { AppleSelect } from "@/features/ui/apple-select";
import { useDialogAccessibility } from "./hooks/use-dialog-accessibility";
import { createFormFromRecognizedGame } from "./recognized-game";
import {
  fetchLedgerFromServer,
  loadLegacyLocalRecords,
  normalizeImportedRecord,
  isExchangeRatePayload,
  readCachedExchangeRates,
  saveLedgerToServer,
} from "./storage";
import type {
  AccessStatus,
  ActiveView,
  ExchangeRatePayload,
  FormState,
  GameFormat,
  GamePlatform,
  GameRecord,
  LibraryPlayGame,
  NintendoCoverResult,
  PsPlusCatalog,
  PurchasePlaySummary,
  RecognizedGame,
  RecordDisplayMode,
  Region,
  SaveStatus,
  SettingsState,
  ShareOptions,
} from "./types";
import {
  convertToCny,
  coverLabel,
  coverSourceLabel,
  createEmptyForm,
  createId,
  createLibraryShareImage,
  currencyLabel,
  formatCnyConversion,
  formatCnyTotal,
  formatMoney,
  formatOptionsForPlatform,
  isPhysicalFormat,
  lookupPriceLabel,
  maxShareImageRecords,
  normalizeFormatForPlatform,
  normalizeLookupCurrency,
  officialUrlLabel,
  officialUrlPlaceholder,
  platformFromPath,
  platformLabel,
  setPlatformUrl,
  sumRecordsInCny,
  textMatchesQuery,
  todayString,
} from "./utils";

type LibrarySort = "date" | "price" | "title";

const librarySortOptions: Array<{
  value: LibrarySort;
  label: string;
  description: string;
  icon: "clock" | "price" | "title";
}> = [
  {
    value: "date",
    label: "最近活动",
    description: "历史按最近游玩，收藏按购买日期",
    icon: "clock",
  },
  {
    value: "title",
    label: "游戏名称",
    description: "按标题顺序排列",
    icon: "title",
  },
  {
    value: "price",
    label: "购买价格",
    description: "按收藏记录的价格排列",
    icon: "price",
  },
];

export default function LedgerClient({
  initialPlatform,
  initialView = "records",
  beforeContent,
}: {
  initialPlatform: GamePlatform;
  initialView?: ActiveView;
  beforeContent?: ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveRequestRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const ledgerUpdatedAtRef = useRef("");
  const coverLookupRequestRef = useRef(0);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [libraryPlayGames, setLibraryPlayGames] = useState<LibraryPlayGame[]>([]);
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [playSummaries, setPlaySummaries] = useState<Record<string, PurchasePlaySummary>>({});
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyGameId, setHistoryGameId] = useState<string | null>(null);
  const [historySaveError, setHistorySaveError] = useState("");
  const [historyRegionConfirmed, setHistoryRegionConfirmed] = useState(true);
  const [historyFormatConfirmed, setHistoryFormatConfirmed] = useState(true);
  const [activeView, setActiveView] = useState<ActiveView>(initialView);
  const [recordDisplayMode, setRecordDisplayMode] = useState<RecordDisplayMode>("grid");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareOptions, setShareOptions] = useState<ShareOptions>({
    showPrice: false,
    showSale: false,
    showDate: false,
    showNotes: false,
  });
  const [shareImageUrl, setShareImageUrl] = useState("");
  const [shareStatus, setShareStatus] = useState<"idle" | "generating" | "error">("idle");
  const purchaseImageInputRef = useRef<HTMLInputElement>(null);
  const catalogTranslationAttemptsRef = useRef(new Set<string>());
  const [recognizeOpen, setRecognizeOpen] = useState(false);
  const [recognizeFiles, setRecognizeFiles] = useState<File[]>([]);
  const [recognizedGames, setRecognizedGames] = useState<RecognizedGame[]>([]);
  const [resumeRecognitionAfterSave, setResumeRecognitionAfterSave] = useState(false);
  const [recognizeStatus, setRecognizeStatus] = useState<"idle" | "recognizing" | "error">("idle");
  const [recognizeError, setRecognizeError] = useState("");
  const [activePlatform, setActivePlatform] = useState<GamePlatform>(initialPlatform);
  const [storageReady, setStorageReady] = useState(false);
  const [recordsDirty, setRecordsDirty] = useState(false);
  const [, setSaveStatus] = useState<SaveStatus>("idle");
  const [storageError, setStorageError] = useState("");
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("checking");
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [, setCurrentUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<LibrarySort>("date");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [coverResults, setCoverResults] = useState<NintendoCoverResult[]>([]);
  const [coverStatus, setCoverStatus] = useState<"idle" | "searching">("idle");
  const [coverError, setCoverError] = useState("");
  const [exchangeRates, setExchangeRates] = useState<ExchangeRatePayload | null>(null);
  const [exchangeError, setExchangeError] = useState("");
  const [settings, setSettings] = useState<SettingsState>({
    siteTitle: "GameNote",
    avatarUrl: "",
    themeColor: defaultThemeColor,
    showNintendoSwitch: true,
    showPlayStation: false,
    showPsPlusCatalog: false,
    showMemberships: true,
    aiBaseUrl: "https://api.openai.com/v1",
    aiModel: "gpt-4.1-mini",
    aiApiKey: "",
    aiApiKeyConfigured: false,
    currentPassword: "",
    newPassword: "",
    psPlusEnabled: false,
    psPlusExpiresAt: "",
    psPlusAutoAddMonthly: true,
    nsOnlineEnabled: false,
    nsOnlineExpiresAt: "",
  });
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [aiActionStatus, setAiActionStatus] = useState("");
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [psPlusStatus, setPsPlusStatus] = useState("");
  const [catalog, setCatalog] = useState<PsPlusCatalog | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "error">("idle");
  const [catalogError, setCatalogError] = useState("");
  const [catalogVisibleCount, setCatalogVisibleCount] = useState(catalogPageSize);
  const [catalogDisplayMode, setCatalogDisplayMode] = useState<RecordDisplayMode>("grid");
  const shareDialogRef = useDialogAccessibility(shareOpen, closeSharePanel);
  const recognizeDialogRef = useDialogAccessibility(recognizeOpen, () => setRecognizeOpen(false));
  const authDialogRef = useDialogAccessibility<HTMLFormElement>(authPanelOpen, () =>
    setAuthPanelOpen(false),
  );

  useEffect(() => {
    if (!sortMenuOpen) return;

    function closeFromOutside(event: PointerEvent) {
      if (!sortMenuRef.current?.contains(event.target as Node)) setSortMenuOpen(false);
    }

    function closeFromKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setSortMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [sortMenuOpen]);

  const loadLedger = useCallback(
    async (authenticated: boolean) => {
      saveRequestRef.current += 1;
      setAccessStatus(authenticated ? "unlocked" : "locked");
      setStorageReady(false);
      setStorageError("");
      setSaveStatus("idle");

      try {
        const serverLedger = await fetchLedgerFromServer();
        const serverRecords = serverLedger.records;
        setPlaySummaries(
          Object.fromEntries(
            (serverLedger.playSummaries || []).map((summary) => [
              summary.purchaseRecordId,
              summary,
            ]),
          ),
        );
        setLibraryPlayGames(serverLedger.libraryPlayGames || []);
        ledgerUpdatedAtRef.current = serverLedger.updatedAt;
        const legacyRecords = authenticated ? loadLegacyLocalRecords() : [];
        const nextRecords =
          serverRecords.length || !legacyRecords.length ? serverRecords : legacyRecords;

        const shouldMigrateLegacyRecords =
          authenticated && !serverRecords.length && legacyRecords.length > 0;

        setRecords(nextRecords);
        setRecordsDirty(shouldMigrateLegacyRecords);
        if (shouldMigrateLegacyRecords) {
          setSaveStatus("saving");
        }
        setForm(createEmptyForm(initialPlatform));
        setHistoryGameId(null);
        setHistorySaveError("");
        setHistoryRegionConfirmed(true);
        setHistoryFormatConfirmed(true);
        setActiveView(initialView);
        setStorageReady(true);
      } catch (error) {
        setRecords([]);
        setLibraryPlayGames([]);
        setRecordsDirty(false);
        setStorageError(error instanceof Error ? error.message : "无法读取服务端记录");
        setStorageReady(false);
      }
    },
    [initialPlatform, initialView],
  );

  const checkAccess = useCallback(async () => {
    try {
      const response = await fetch("/api/access", { cache: "no-store" });
      const payload = (await response.json()) as {
        authenticated?: boolean;
        registrationOpen?: boolean;
        username?: string | null;
      };
      setRegistrationOpen(Boolean(payload.registrationOpen));
      setCurrentUsername(payload.username || "");
      await loadLedger(Boolean(payload.authenticated));
    } catch {
      await loadLedger(false);
    }
  }, [loadLedger]);

  const applyPlatformPage = useCallback(
    (platform: GamePlatform, urlMode: "push" | "replace" | false) => {
      if (urlMode) {
        setPlatformUrl(platform, urlMode);
      }

      setActivePlatform(platform);
      setQuery("");
      setCoverResults([]);
      setCoverError("");

      if (editingId || activeView === "form") {
        setEditingId(null);
        setHistoryGameId(null);
        setHistorySaveError("");
        setHistoryRegionConfirmed(true);
        setHistoryFormatConfirmed(true);
        setForm(createEmptyForm(platform));
        setActiveView("records");
      }
    },
    [activeView, editingId],
  );

  useEffect(() => {
    const openAuthPanel = () => setAuthPanelOpen(true);
    const frame = window.requestAnimationFrame(() => {
      const storedThemeColor = window.localStorage.getItem("gamenote-theme-color");
      if (storedThemeColor && /^#[0-9a-f]{6}$/i.test(storedThemeColor)) {
        document.documentElement.style.setProperty("--color-primary", storedThemeColor);
      }
      checkAccess();
      if (new URLSearchParams(window.location.search).get("auth") === "login")
        setAuthPanelOpen(true);
    });

    window.addEventListener(shellAuthChangedEvent, checkAccess);
    window.addEventListener(shellAuthRequestedEvent, openAuthPanel);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener(shellAuthChangedEvent, checkAccess);
      window.removeEventListener(shellAuthRequestedEvent, openAuthPanel);
    };
  }, [checkAccess]);

  useEffect(() => {
    if (accessStatus === "checking") return;
    let cancelled = false;

    async function loadSettings() {
      try {
        const response = await fetch("/api/settings", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error("无法读取设置");
        if (cancelled) return;
        setSettings((current) => ({ ...current, ...payload }));
        setSettingsReady(true);
        if (payload.themeColor) updateThemeColor(payload.themeColor);
        if (payload.siteTitle) document.title = payload.siteTitle;
      } catch {
        if (!cancelled) {
          setSettingsReady(true);
          setSettingsStatus("无法读取设置");
        }
      }
    }

    loadSettings();
    return () => {
      cancelled = true;
    };
  }, [accessStatus]);

  useEffect(() => {
    if (!settingsReady || activeView === "settings") return;

    const preferredPlatform: GamePlatform = settings.showNintendoSwitch
      ? "Nintendo Switch"
      : "PlayStation";
    const activeLibraryHidden =
      activeView === "records" || activeView === "form"
        ? activePlatform === "Nintendo Switch"
          ? !settings.showNintendoSwitch
          : !settings.showPlayStation
        : false;
    const activeToolHidden =
      (activeView === "ps-plus-catalog" &&
        (!settings.showPlayStation || !settings.showPsPlusCatalog)) ||
      (activeView === "memberships" && !settings.showMemberships);

    if (activeLibraryHidden || activeToolHidden) {
      applyPlatformPage(preferredPlatform, "replace");
      setActiveView("records");
    }
  }, [
    activePlatform,
    activeView,
    applyPlatformPage,
    settings.showMemberships,
    settings.showNintendoSwitch,
    settings.showPlayStation,
    settings.showPsPlusCatalog,
    settingsReady,
  ]);

  function updateThemeColor(color: string) {
    document.documentElement.style.setProperty("--color-primary", color);
    document.documentElement.style.setProperty("--color-primary-content", themeColorContent(color));
    window.localStorage.setItem("gamenote-theme-color", color);
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsStatus("保存中");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "保存失败");
      setSettings((current) => ({ ...current, ...payload, aiApiKey: "" }));
      updateThemeColor(payload.themeColor);
      document.title = payload.siteTitle;
      setSettingsStatus("已保存");
      window.dispatchEvent(new Event(shellSettingsChangedEvent));
      if (payload.showPlayStation && payload.psPlusEnabled && payload.psPlusAutoAddMonthly)
        window.setTimeout(() => syncPsPlusGames(false), 0);
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : "保存失败");
    }
  }

  async function changePassword() {
    setSettingsStatus("修改中");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "修改失败");
      setSettings((current) => ({ ...current, currentPassword: "", newPassword: "" }));
      setSettingsStatus("密码已修改，请重新登录");
      await loadLedger(false);
    } catch (error) {
      setSettingsStatus(error instanceof Error ? error.message : "修改失败");
    }
  }

  async function runAiConfigAction(action: "models" | "test") {
    setAiActionStatus(action === "models" ? "正在获取模型" : "正在测试接口");
    try {
      const response = await fetch("/api/ai-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          baseUrl: settings.aiBaseUrl,
          model: settings.aiModel,
          apiKey: settings.aiApiKey,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "AI 接口请求失败");
      if (action === "models") {
        const models = Array.isArray(payload.models) ? payload.models : [];
        setAiModels(models);
        setAiActionStatus(models.length ? `已获取 ${models.length} 个模型` : "接口未返回可用模型");
      } else {
        setAiActionStatus("接口测试成功");
      }
    } catch (error) {
      setAiActionStatus(error instanceof Error ? error.message : "AI 接口请求失败");
    }
  }

  const syncPsPlusGames = useCallback(
    async (silent = false) => {
      if (!silent) setPsPlusStatus("正在同步");
      try {
        const response = await fetch("/api/ps-plus", { method: "POST" });
        const payload = (await response.json().catch(() => ({}))) as {
          added?: number;
          message?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "同步失败");
        if ((payload.added || 0) > 0) {
          await loadLedger(true);
          setPsPlusStatus(`已自动入库 ${payload.added} 款会免游戏`);
        } else if (!silent) setPsPlusStatus(payload.message || "当月会免已同步");
      } catch (error) {
        if (!silent) setPsPlusStatus(error instanceof Error ? error.message : "同步失败");
      }
    },
    [loadLedger],
  );

  useEffect(() => {
    if (
      accessStatus === "unlocked" &&
      settings.showPlayStation &&
      settings.psPlusEnabled &&
      settings.psPlusAutoAddMonthly
    )
      syncPsPlusGames(true);
  }, [
    accessStatus,
    settings.psPlusAutoAddMonthly,
    settings.psPlusEnabled,
    settings.showPlayStation,
    syncPsPlusGames,
  ]);

  const loadPsPlusCatalog = useCallback(async (force = false) => {
    setCatalogStatus("loading");
    setCatalogError("");
    try {
      const response = await fetch("/api/ps-plus-catalog" + (force ? "?refresh=1" : ""), {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as PsPlusCatalog & {
        error?: string;
      };
      if (!response.ok || !Array.isArray(payload.games))
        throw new Error(payload.error || "无法读取游戏库");
      setCatalog(payload);
      catalogTranslationAttemptsRef.current.clear();
      setCatalogVisibleCount(catalogPageSize);
      setCatalogStatus("idle");
    } catch (error) {
      setCatalogStatus("error");
      setCatalogError(error instanceof Error ? error.message : "无法读取游戏库");
    }
  }, []);

  useEffect(() => {
    if (activeView === "ps-plus-catalog" && !catalog && catalogStatus === "idle")
      loadPsPlusCatalog();
  }, [activeView, catalog, catalogStatus, loadPsPlusCatalog]);

  const filteredCatalogGames = useMemo(() => {
    const normalizedQuery = normalizeChineseSearchText(catalogQuery.trim());
    if (!normalizedQuery) return catalog?.games || [];
    return (catalog?.games || []).filter((game) =>
      textMatchesQuery(
        [game.localizedTitle, game.title, game.platforms.join(" "), game.tier].join(" "),
        normalizedQuery,
      ),
    );
  }, [catalog, catalogQuery]);
  const visibleCatalogGames = useMemo(
    () => filteredCatalogGames.slice(0, catalogVisibleCount),
    [catalogVisibleCount, filteredCatalogGames],
  );

  useEffect(() => {
    setCatalogVisibleCount(catalogPageSize);
  }, [catalogQuery]);

  useEffect(() => {
    if (activeView !== "ps-plus-catalog" || !visibleCatalogGames.length) return;
    const untranslated = visibleCatalogGames
      .filter(
        (game) =>
          !/[\u3400-\u9fff]/u.test(game.localizedTitle) &&
          !catalogTranslationAttemptsRef.current.has(game.id),
      )
      .slice(0, 20);
    if (!untranslated.length) return;
    let cancelled = false;
    untranslated.forEach((game) => catalogTranslationAttemptsRef.current.add(game.id));
    const titles = untranslated.map((game) => game.title);
    fetch("/api/playstation-game", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ titles }),
    })
      .then((response) => response.json())
      .then((payload: { games?: Array<{ requestedTitle: string; localizedTitle: string }> }) => {
        if (cancelled || !Array.isArray(payload.games)) return;
        const translations = new Map(
          payload.games
            .filter((item) => /[\u3400-\u9fff]/u.test(item.localizedTitle))
            .map((item) => [item.requestedTitle, item.localizedTitle]),
        );
        if (!translations.size) return;
        setCatalog((current) =>
          current
            ? {
                ...current,
                games: current.games.map((game) => ({
                  ...game,
                  localizedTitle: translations.get(game.title) || game.localizedTitle,
                })),
              }
            : current,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeView, visibleCatalogGames]);

  useEffect(() => {
    function handlePopState() {
      const platform = platformFromPath(window.location.pathname);

      if (platform) {
        applyPlatformPage(platform, false);
        setActiveView(
          window.location.pathname.startsWith("/ps-plus-catalog")
            ? "ps-plus-catalog"
            : window.location.pathname.startsWith("/memberships")
              ? "memberships"
              : "records",
        );
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyPlatformPage]);

  useEffect(() => {
    if (accessStatus === "checking") return;
    let cancelled = false;
    fetch("/api/dashboard-stats", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setDashboardStats(payload);
      })
      .catch(() => {
        if (!cancelled) setDashboardStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [accessStatus, records]);

  useEffect(() => {
    if (accessStatus === "checking") {
      return;
    }

    let cancelled = false;

    async function loadExchangeRates() {
      setExchangeError("");

      const cached = readCachedExchangeRates();
      if (cached && !cancelled) {
        setExchangeRates(cached);
      }

      try {
        const response = await fetch("/api/exchange-rates", { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as
          | ExchangeRatePayload
          | { error?: string };

        if (!response.ok || !isExchangeRatePayload(payload)) {
          throw new Error("error" in payload && payload.error ? payload.error : "无法更新汇率");
        }

        if (!cancelled) {
          setExchangeRates(payload);
          window.localStorage.setItem(exchangeCacheKey, JSON.stringify(payload));
        }
      } catch (error) {
        if (!cancelled) {
          setExchangeError(error instanceof Error ? error.message : "无法更新汇率");
        }
      }
    }

    loadExchangeRates();

    return () => {
      cancelled = true;
    };
  }, [accessStatus]);

  useEffect(() => {
    if (!storageReady || !recordsDirty || accessStatus !== "unlocked") {
      return;
    }

    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    const timeoutId = window.setTimeout(() => {
      saveChainRef.current = saveChainRef.current
        .then(async () => {
          if (saveRequestRef.current !== requestId) return;
          const updatedAt = await saveLedgerToServer(records, ledgerUpdatedAtRef.current);
          ledgerUpdatedAtRef.current = updatedAt;
          if (saveRequestRef.current === requestId) {
            setRecordsDirty(false);
            setSaveStatus("saved");
            setStorageError("");
          }
        })
        .catch((error) => {
          if (saveRequestRef.current === requestId) {
            setSaveStatus("error");
            setStorageError(error instanceof Error ? error.message : "保存服务端记录失败");
          }
        });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [accessStatus, records, recordsDirty, storageReady]);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!username.trim() || !password) {
      setPasswordError("请输入账号和密码");
      return;
    }

    setPasswordError("");

    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: registrationOpen ? "register" : "login",
          username,
          password,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setPasswordError(payload.error || "登录失败");
        return;
      }

      setPassword("");
      setCurrentUsername(username.trim());
      setRegistrationOpen(false);
      setAuthPanelOpen(false);
      window.dispatchEvent(new Event(shellAuthChangedEvent));
      await loadLedger(true);
      const nextPath = new URLSearchParams(window.location.search).get("next");
      if (nextPath?.startsWith("/") && !nextPath.startsWith("//")) {
        window.location.assign(nextPath);
      }
    } catch {
      setPasswordError("无法验证密码，请稍后重试");
    }
  }

  const platformRecords = useMemo(
    () => records.filter((record) => record.platform === activePlatform),
    [activePlatform, records],
  );

  const activePurchaseIds = useMemo(() => new Set(records.map((record) => record.id)), [records]);
  const unlinkedNintendoHistoryGames = useMemo(
    () =>
      libraryPlayGames.filter(
        (game) =>
          !game.link?.purchaseRecordId || !activePurchaseIds.has(game.link.purchaseRecordId),
      ),
    [activePurchaseIds, libraryPlayGames],
  );
  const unlinkedHistoryGames = useMemo(
    () => (activePlatform === "Nintendo Switch" ? unlinkedNintendoHistoryGames : []),
    [activePlatform, unlinkedNintendoHistoryGames],
  );

  const statsRecords = useMemo(
    () =>
      records.filter((record) =>
        record.platform === "Nintendo Switch"
          ? settings.showNintendoSwitch
          : settings.showPlayStation,
      ),
    [records, settings.showNintendoSwitch, settings.showPlayStation],
  );

  const statsLibraryLabel = settings.showNintendoSwitch
    ? settings.showPlayStation
      ? "NS + PS"
      : "仅 NS"
    : "仅 PS";

  const filteredRecords = useMemo(() => {
    const normalizedQuery = normalizeChineseSearchText(query);
    const source = normalizedQuery
      ? platformRecords.filter((record) =>
          textMatchesQuery(
            [
              record.title,
              record.region,
              record.format,
              record.seller,
              record.notes,
              record.soldDate ? "已卖出" : "持有中",
            ].join(" "),
            normalizedQuery,
          ),
        )
      : platformRecords;

    return [...source].sort((a, b) => {
      if (sortBy === "price") {
        return (
          (convertToCny(b.price, b.currency, exchangeRates) ?? b.price) -
          (convertToCny(a.price, a.currency, exchangeRates) ?? a.price)
        );
      }

      if (sortBy === "title") {
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      }

      return new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime();
    });
  }, [exchangeRates, platformRecords, query, sortBy]);

  const filteredHistoryGames = useMemo(() => {
    const normalizedQuery = normalizeChineseSearchText(query);
    const source = normalizedQuery
      ? unlinkedHistoryGames.filter((game) =>
          textMatchesQuery(
            `${game.title} ${game.platform} ${game.source} 历史游玩 待补资料`,
            normalizedQuery,
          ),
        )
      : unlinkedHistoryGames;
    return [...source].sort((a, b) => {
      if (sortBy === "title") return a.title.localeCompare(b.title, "zh-Hans-CN");
      return b.lastPlayedAt.localeCompare(a.lastPlayedAt);
    });
  }, [query, sortBy, unlinkedHistoryGames]);
  const visibleHistoryGames = useMemo(
    () =>
      query.trim() || historyExpanded ? filteredHistoryGames : filteredHistoryGames.slice(0, 6),
    [filteredHistoryGames, historyExpanded, query],
  );

  const soldCount = statsRecords.filter((record) => record.soldDate).length;
  const totalLibraryGames =
    statsRecords.length + (settings.showNintendoSwitch ? unlinkedNintendoHistoryGames.length : 0);
  const currentPlatformLibraryGames =
    platformRecords.length +
    (activePlatform === "Nintendo Switch" ? unlinkedNintendoHistoryGames.length : 0);
  const purchaseCnyStats = useMemo(
    () =>
      sumRecordsInCny(statsRecords, exchangeRates, (record) => ({
        amount: record.price,
        currency: record.currency,
      })),
    [exchangeRates, statsRecords],
  );
  const saleCnyStats = useMemo(
    () =>
      sumRecordsInCny(statsRecords, exchangeRates, (record) =>
        record.soldDate ? { amount: record.soldPrice, currency: record.soldCurrency } : null,
      ),
    [exchangeRates, statsRecords],
  );

  function updateForm<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    if (key === "title" || key === "officialUrl") {
      coverLookupRequestRef.current += 1;
      setCoverResults([]);
      setCoverError("");
      setCoverStatus("idle");
    }
    setForm((current) => ({ ...current, [key]: value }));
  }

  function resetForm() {
    coverLookupRequestRef.current += 1;
    setEditingId(null);
    setHistoryGameId(null);
    setHistorySaveError("");
    setHistoryRegionConfirmed(true);
    setHistoryFormatConfirmed(true);
    setForm(createEmptyForm(activePlatform));
    setCoverResults([]);
    setCoverError("");
    setCoverStatus("idle");
  }

  function openPurchaseRecognition() {
    setRecognizeOpen(true);
    if (activeView !== "records") setActiveView("records");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (historyGameId && (!historyRegionConfirmed || !historyFormatConfirmed)) {
      setHistorySaveError("请先确认游戏版本和介质");
      return;
    }

    const normalized: FormState = {
      ...form,
      title: form.title.trim(),
      seller: form.seller.trim(),
      coverUrl: form.coverUrl.trim(),
      officialUrl: form.officialUrl.trim(),
      notes: form.notes.trim(),
      price: Number(form.price) || 0,
      format: normalizeFormatForPlatform(form.format, form.platform),
      soldDate: isPhysicalFormat(form.format) ? form.soldDate : "",
      soldPrice: isPhysicalFormat(form.format) && form.soldDate ? Number(form.soldPrice) || 0 : 0,
      soldCurrency: form.soldCurrency,
    };

    if (!normalized.title) {
      return;
    }

    if (historyGameId) {
      setHistorySaveError("");
      setSaveStatus("saving");
      try {
        const response = await fetch(
          `/api/play-history/${encodeURIComponent(historyGameId)}/collection`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(normalized),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) throw new Error(payload.error || "无法保存收藏资料");
        await loadLedger(true);
        setSaveStatus("saved");
      } catch (error) {
        setSaveStatus("error");
        setHistorySaveError(error instanceof Error ? error.message : "无法保存收藏资料");
      }
      return;
    }

    if (editingId) {
      setRecords((current) =>
        current.map((record) =>
          record.id === editingId ? { ...normalized, id: editingId } : record,
        ),
      );
    } else {
      setRecords((current) => [{ ...normalized, id: createId() }, ...current]);
    }
    setRecordsDirty(true);
    setSaveStatus("saving");
    setActiveView("records");

    resetForm();
    if (resumeRecognitionAfterSave && recognizedGames.length) {
      setRecognizeOpen(true);
    } else {
      setRecognizeFiles([]);
      setRecognizedGames([]);
    }
    setResumeRecognitionAfterSave(false);
  }

  function editRecord(record: GameRecord) {
    setResumeRecognitionAfterSave(false);
    setHistoryGameId(null);
    setHistorySaveError("");
    setHistoryRegionConfirmed(true);
    setHistoryFormatConfirmed(true);
    setEditingId(record.id);
    setPlatformUrl(record.platform, "replace");
    setActivePlatform(record.platform);
    setForm({
      platform: record.platform,
      title: record.title,
      price: record.price,
      currency: record.currency,
      purchaseDate: record.purchaseDate,
      region: record.region,
      format: record.format,
      seller: record.seller,
      coverUrl: record.coverUrl,
      officialUrl: record.officialUrl,
      notes: record.notes,
      soldDate: record.soldDate,
      soldPrice: record.soldPrice,
      soldCurrency: record.soldCurrency,
    });
    setActiveView("form");
  }

  function completeHistoryGame(game: LibraryPlayGame) {
    setResumeRecognitionAfterSave(false);
    setEditingId(null);
    setHistoryGameId(game.id);
    setHistorySaveError("");
    setHistoryRegionConfirmed(false);
    setHistoryFormatConfirmed(false);
    setPlatformUrl("Nintendo Switch", "replace");
    setActivePlatform("Nintendo Switch");
    setForm({
      ...createEmptyForm("Nintendo Switch"),
      title: game.title,
      purchaseDate: "",
      region: "其他",
      coverUrl: game.coverUrl,
      officialUrl: game.officialUrl,
    });
    setActiveView("form");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function updateFormat(format: GameFormat) {
    if (historyGameId) setHistoryFormatConfirmed(true);
    setForm((current) => ({
      ...current,
      format,
      soldDate: isPhysicalFormat(format) ? current.soldDate : "",
      soldPrice: isPhysicalFormat(format) ? current.soldPrice : 0,
      soldCurrency: isPhysicalFormat(format) ? current.soldCurrency : current.currency,
    }));
  }

  function updatePlatform(platform: GamePlatform) {
    coverLookupRequestRef.current += 1;
    setCoverStatus("idle");
    setPlatformUrl(platform, "replace");
    setActivePlatform(platform);
    setCoverResults([]);
    setCoverError("");
    setForm((current) => ({
      ...current,
      platform,
      region: platform === "PlayStation" && current.region === "日版" ? "港版" : current.region,
      format: normalizeFormatForPlatform(current.format, platform),
      soldDate: isPhysicalFormat(normalizeFormatForPlatform(current.format, platform))
        ? current.soldDate
        : "",
      soldPrice: isPhysicalFormat(normalizeFormatForPlatform(current.format, platform))
        ? current.soldPrice
        : 0,
    }));
  }

  function toggleSold(checked: boolean) {
    setForm((current) => ({
      ...current,
      soldDate: checked ? current.soldDate || todayString() : "",
      soldPrice: checked ? current.soldPrice : 0,
      soldCurrency: checked ? current.soldCurrency || current.currency : current.currency,
    }));
  }

  function startSaleRecord(record: GameRecord) {
    editRecord({
      ...record,
      soldDate: record.soldDate || todayString(),
      soldPrice: record.soldPrice || 0,
      soldCurrency: record.soldCurrency || record.currency,
    });
    setActiveView("form");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteRecord(recordId: string) {
    setRecords((current) => current.filter((record) => record.id !== recordId));
    setRecordsDirty(true);
    setSaveStatus("saving");
    if (editingId === recordId) {
      resetForm();
    }
  }

  function closeSharePanel() {
    setShareOpen(false);
    if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
    setShareImageUrl("");
    setShareStatus("idle");
  }

  async function generateShareImage() {
    setShareStatus("generating");
    try {
      const blob = await createLibraryShareImage(records, shareOptions);
      if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
      setShareImageUrl(URL.createObjectURL(blob));
      setShareStatus("idle");
    } catch {
      setShareStatus("error");
    }
  }

  async function shareLibraryImage() {
    try {
      const blob = await createLibraryShareImage(records, shareOptions);
      const file = new File([blob], `game-library-${todayString()}.png`, { type: "image/png" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: "我的游戏收藏", files: [file] });
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        window.alert("分享图片生成失败，请稍后重试");
      }
    }
  }

  async function exportRecords() {
    try {
      const response = await fetch("/api/export", { cache: "no-store" });
      const payload = await response.blob();

      if (!response.ok) {
        const error = await payload.text().catch(() => "");
        throw new Error(error || "导出失败");
      }

      const url = URL.createObjectURL(payload);
      const link = document.createElement("a");
      link.href = url;
      link.download = `game-ledger-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "导出失败");
    }
  }

  async function recognizePurchaseImages() {
    if (!recognizeFiles.length) return;
    setRecognizeStatus("recognizing");
    setRecognizeError("");
    const body = new FormData();
    recognizeFiles.forEach((file) => body.append("images", file));

    try {
      const response = await fetch("/api/recognize-purchase", { method: "POST", body });
      const payload = (await response.json().catch(() => ({}))) as {
        games?: RecognizedGame[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "图片识别失败");
      setRecognizedGames(
        (payload.games || []).map((game) => ({
          ...game,
          purchaseDate: game.purchaseDate || todayString(),
          format: normalizeFormatForPlatform(game.format, game.platform),
        })),
      );
      if (!payload.games?.length) setRecognizeError("没有识别到已购买的游戏");
      setRecognizeStatus("idle");
    } catch (error) {
      setRecognizeError(error instanceof Error ? error.message : "图片识别失败");
      setRecognizeStatus("error");
    }
  }

  function openRecognizedGameInForm(game: RecognizedGame, index: number) {
    const remainingGames = recognizedGames.filter((_, gameIndex) => gameIndex !== index);
    const nextForm = createFormFromRecognizedGame(game, todayString());

    setEditingId(null);
    setPlatformUrl(game.platform, "replace");
    setActivePlatform(game.platform);
    setForm(nextForm);
    setCoverResults([]);
    setCoverError("");
    setRecognizedGames(remainingGames);
    setResumeRecognitionAfterSave(remainingGames.length > 0);
    setRecognizeOpen(false);
    if (!remainingGames.length) setRecognizeFiles([]);
    setActiveView("form");
    void lookupOfficialGame("title", nextForm);
  }

  function importRecordsClick() {
    fileInputRef.current?.click();
  }

  async function importRecords(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      if (file.size > ledgerLimits.maxRequestBytes) throw new Error("JSON 文件不能超过 5MB");
      const parsed = JSON.parse(await file.text()) as unknown;
      const parsedRecords = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && "records" in parsed
          ? (parsed as { records?: unknown }).records
          : null;

      if (!Array.isArray(parsedRecords)) {
        throw new Error("Expected an array");
      }
      if (parsedRecords.length > ledgerLimits.maxRecords)
        throw new Error(`记录数量不能超过 ${ledgerLimits.maxRecords} 条`);

      const importedRecords = parsedRecords
        .map(normalizeImportedRecord)
        .filter((record): record is GameRecord => Boolean(record));

      if (!importedRecords.length) {
        throw new Error("No valid records");
      }

      setRecords(importedRecords);
      setRecordsDirty(true);
      setSaveStatus("saving");
      resetForm();
      setSettingsStatus(`已导入 ${importedRecords.length} 条记录`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "JSON 文件不是有效的游戏购买记录");
    } finally {
      event.target.value = "";
    }
  }

  async function lookupOfficialGame(
    mode: "title" | "url",
    source: Pick<FormState, "title" | "officialUrl" | "platform"> = form,
  ) {
    const params = new URLSearchParams();
    const searchTerm = source.title.trim();
    const officialUrl = source.officialUrl.trim();
    const endpoint =
      source.platform === "PlayStation" ? "/api/playstation-game" : "/api/nintendo-cover";

    if (mode === "title") {
      if (!searchTerm) {
        setCoverError("先输入游戏名字");
        return;
      }

      params.set("q", searchTerm);
    } else {
      if (!officialUrl) {
        setCoverError(`先填写${officialUrlLabel(source.platform)}`);
        return;
      }

      params.set("url", officialUrl);
    }

    const requestId = ++coverLookupRequestRef.current;
    setCoverStatus("searching");
    setCoverError("");

    try {
      const response = await fetch(`${endpoint}?${params.toString()}`);
      const payload = (await response.json()) as {
        results?: NintendoCoverResult[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "封面查询失败");
      }
      if (requestId !== coverLookupRequestRef.current) return;

      const results = payload.results ?? [];
      setCoverResults(results);

      if (!results.length) {
        setCoverError("未找到官方数据");
      }
    } catch (error) {
      if (requestId !== coverLookupRequestRef.current) return;
      setCoverResults([]);
      setCoverError(error instanceof Error ? error.message : "官方数据查询失败");
    } finally {
      if (requestId === coverLookupRequestRef.current) setCoverStatus("idle");
    }
  }

  function applyOfficialGame(result: NintendoCoverResult) {
    const currency = normalizeLookupCurrency(result.currency);
    const resultPlatform: GamePlatform = result.source.startsWith("playstation")
      ? "PlayStation"
      : "Nintendo Switch";
    setPlatformUrl(resultPlatform, "replace");
    setActivePlatform(resultPlatform);

    setForm((current) => {
      const format = normalizeFormatForPlatform(current.format, resultPlatform);
      const shouldApplyPrice =
        result.price !== null && (resultPlatform === "PlayStation" || format === "数字版");

      return {
        ...current,
        platform: resultPlatform,
        format,
        title: result.displayTitle || result.title,
        coverUrl: result.coverUrl,
        officialUrl: result.officialUrl || result.nintendoUrl || "",
        price: shouldApplyPrice ? (result.price ?? current.price) : current.price,
        currency: shouldApplyPrice ? (currency ?? current.currency) : current.currency,
      };
    });
    setCoverError("");
  }

  if (accessStatus === "checking") {
    return (
      <section className="login-screen flex min-h-64 items-center justify-center px-4 py-8 text-base-content">
        <p className="text-sm font-semibold text-base-content/70">正在加载游戏记录</p>
      </section>
    );
  }

  return (
    <section className="ledger-workspace">
      <div className="ledger-workspace-main">
        {beforeContent}
        {storageReady ? (
          <section className="min-w-0">
            {activeView === "form" && accessStatus === "unlocked" ? (
              <form onSubmit={handleSubmit} className="app-surface overflow-hidden">
                <div className="surface-toolbar flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div>
                    <p className="text-xs font-bold uppercase text-primary">
                      {historyGameId ? "From play history" : editingId ? "Edit game" : "New game"}
                    </p>
                    <h2 className="mt-1 text-xl font-bold">
                      {historyGameId ? "完善收藏资料" : editingId ? "编辑游戏" : "新增游戏"}
                    </h2>
                    {historyGameId ? (
                      <p className="mt-1 text-sm text-base-content/65">
                        游戏名和历史封面已带入；请确认版本、介质与购买信息，购买日期可以留空。
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {editingId || historyGameId ? (
                      <button type="button" className="ghost-button" onClick={resetForm}>
                        取消编辑
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setResumeRecognitionAfterSave(false);
                        setActiveView("records");
                      }}
                    >
                      返回记录
                    </button>
                  </div>
                </div>

                <div className="grid gap-0 xl:grid-cols-[360px_minmax(0,1fr)]">
                  <aside className="border-b border-base-300 bg-base-200 p-4 sm:p-5 xl:border-b-0 xl:border-r xl:border-base-300">
                    <div className="cover-frame overflow-hidden">
                      {form.coverUrl ? (
                        <img
                          src={form.coverUrl}
                          alt={`${form.title || "游戏"}封面`}
                          className="h-48 w-full object-cover sm:h-60"
                        />
                      ) : (
                        <div className="flex h-48 items-center justify-center bg-primary px-8 text-center text-4xl font-black text-primary-content sm:h-60">
                          {coverLabel(form.title) ||
                            (form.platform === "PlayStation" ? "PS" : "SWITCH")}
                        </div>
                      )}
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={coverStatus === "searching" || !form.title.trim()}
                        onClick={() => lookupOfficialGame("title")}
                      >
                        {coverStatus === "searching" ? "查询中" : "按名称找官方数据"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={coverStatus === "searching" || !form.officialUrl.trim()}
                        onClick={() => lookupOfficialGame("url")}
                      >
                        从页面取数据
                      </button>
                    </div>

                    {coverError ? (
                      <p className="alert alert-warning mt-2 py-2 text-sm font-semibold">
                        {coverError}
                      </p>
                    ) : null}

                    {coverResults.length ? (
                      <div className="mt-3 grid gap-2">
                        {coverResults.map((result) => {
                          const priceLabel = lookupPriceLabel(result);

                          return (
                            <button
                              key={result.id}
                              type="button"
                              className="cover-result"
                              onClick={() => applyOfficialGame(result)}
                            >
                              <img
                                src={result.coverUrl}
                                alt={`${result.displayTitle || result.title}封面`}
                                loading="lazy"
                                decoding="async"
                              />
                              <span>
                                <strong>{result.displayTitle || result.title}</strong>
                                <small>
                                  {coverSourceLabel(result.source)} · {result.platform}
                                  {result.releaseDate
                                    ? ` · ${result.releaseDate.slice(0, 10)}`
                                    : ""}
                                  {priceLabel ? ` · ${priceLabel}` : ""}
                                </small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </aside>

                  <div className="p-4 sm:p-5">
                    <div className="grid gap-3 lg:grid-cols-2">
                      <label className="field">
                        <span>平台</span>
                        <AppleSelect
                          ariaLabel="平台"
                          value={form.platform}
                          options={gamePlatforms
                            .filter(
                              (platform) => platform !== "PlayStation" || settings.showPlayStation,
                            )
                            .map((platform) => ({
                              value: platform,
                              label: platformLabel(platform),
                            }))}
                          onChange={updatePlatform}
                        />
                      </label>

                      <label className="field">
                        <span>游戏名字</span>
                        <input
                          required
                          value={form.title}
                          onChange={(event) => updateForm("title", event.target.value)}
                          placeholder="例如 塞尔达 / Elden Ring / Final Fantasy"
                        />
                      </label>

                      <div className="grid gap-3 sm:grid-cols-[1fr_minmax(12rem,0.55fr)]">
                        <label className="field">
                          <span>价格</span>
                          <input
                            min="0"
                            step="0.01"
                            type="number"
                            value={form.price || ""}
                            onChange={(event) => updateForm("price", Number(event.target.value))}
                            placeholder="0.00"
                          />
                        </label>
                        <label className="field">
                          <span>币种</span>
                          <AppleSelect
                            ariaLabel="币种"
                            value={form.currency}
                            options={currencies.map((currency) => ({
                              value: currency,
                              label: currencyLabel(currency),
                            }))}
                            onChange={(currency) => updateForm("currency", currency)}
                          />
                        </label>
                      </div>
                      {form.price && form.currency !== "CNY" ? (
                        <p className="rounded-xl bg-base-200 px-3 py-2 text-sm font-semibold text-base-content/70 lg:col-span-2">
                          {formatCnyConversion(form.price, form.currency, exchangeRates)}
                        </p>
                      ) : null}

                      <label className="field">
                        <span>购买日期</span>
                        <input
                          type="date"
                          value={form.purchaseDate}
                          onChange={(event) => updateForm("purchaseDate", event.target.value)}
                        />
                      </label>

                      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
                        <label className="field">
                          <span>版本</span>
                          <AppleSelect<Region | "">
                            ariaLabel="版本"
                            required
                            value={historyGameId && !historyRegionConfirmed ? "" : form.region}
                            placeholder="请选择版本"
                            options={regions.map((region) => ({ value: region, label: region }))}
                            onChange={(region) => {
                              if (!region) return;
                              setHistoryRegionConfirmed(true);
                              updateForm("region", region);
                            }}
                          />
                        </label>
                        <label className="field">
                          <span>介质</span>
                          <AppleSelect<GameFormat | "">
                            ariaLabel="介质"
                            required
                            value={historyGameId && !historyFormatConfirmed ? "" : form.format}
                            placeholder="请选择介质"
                            options={formatOptionsForPlatform(form.platform).map((format) => ({
                              value: format,
                              label: format,
                            }))}
                            onChange={(format) => {
                              if (format) updateFormat(format);
                            }}
                          />
                        </label>
                      </div>

                      {isPhysicalFormat(form.format) ? (
                        <div className="sale-panel p-3 lg:col-span-2">
                          <label className="checkbox-field">
                            <input
                              type="checkbox"
                              checked={Boolean(form.soldDate)}
                              onChange={(event) => toggleSold(event.target.checked)}
                            />
                            <span>这份实体游戏已卖出</span>
                          </label>

                          {form.soldDate ? (
                            <>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(12rem,0.8fr)]">
                                <label className="field">
                                  <span>卖出日期</span>
                                  <input
                                    required
                                    type="date"
                                    value={form.soldDate}
                                    onChange={(event) => updateForm("soldDate", event.target.value)}
                                  />
                                </label>
                                <label className="field">
                                  <span>卖出价格</span>
                                  <input
                                    min="0"
                                    step="0.01"
                                    type="number"
                                    value={form.soldPrice || ""}
                                    onChange={(event) =>
                                      updateForm("soldPrice", Number(event.target.value))
                                    }
                                    placeholder="0.00"
                                  />
                                </label>
                                <label className="field">
                                  <span>币种</span>
                                  <AppleSelect
                                    ariaLabel="卖出币种"
                                    value={form.soldCurrency}
                                    options={currencies.map((currency) => ({
                                      value: currency,
                                      label: currencyLabel(currency),
                                    }))}
                                    onChange={(currency) => updateForm("soldCurrency", currency)}
                                  />
                                </label>
                              </div>
                              {form.soldPrice && form.soldCurrency !== "CNY" ? (
                                <p className="mt-3 rounded-xl bg-base-100 px-3 py-2 text-sm font-semibold text-base-content/70">
                                  {formatCnyConversion(
                                    form.soldPrice,
                                    form.soldCurrency,
                                    exchangeRates,
                                  )}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}

                      <label className="field">
                        <span>购买渠道</span>
                        <input
                          value={form.seller}
                          onChange={(event) => updateForm("seller", event.target.value)}
                          placeholder={
                            isPhysicalFormat(form.format)
                              ? "淘宝 / 闲鱼 / 线下店"
                              : "Nintendo eShop / PlayStation Store"
                          }
                        />
                      </label>

                      <label className="field">
                        <span>封面 URL</span>
                        <input
                          value={form.coverUrl}
                          onChange={(event) => updateForm("coverUrl", event.target.value)}
                          placeholder="官方图片地址"
                        />
                      </label>

                      <label className="field">
                        <span>{officialUrlLabel(form.platform)}</span>
                        <input
                          value={form.officialUrl}
                          onChange={(event) => updateForm("officialUrl", event.target.value)}
                          placeholder={officialUrlPlaceholder(form.platform)}
                        />
                      </label>

                      <label className="field lg:col-span-2">
                        <span>备注</span>
                        <textarea
                          value={form.notes}
                          onChange={(event) => updateForm("notes", event.target.value)}
                          placeholder="特典、成色、是否盒说齐全"
                        />
                      </label>
                    </div>

                    <div className="flex flex-col gap-2 border-t border-base-300 pt-4 sm:flex-row sm:justify-end lg:col-span-2">
                      {historySaveError ? (
                        <p className="self-center text-sm font-semibold text-error sm:mr-auto">
                          {historySaveError}
                        </p>
                      ) : null}
                      <button
                        className="ghost-button w-full sm:w-auto"
                        type="button"
                        onClick={() => setActiveView("records")}
                      >
                        返回记录
                      </button>
                      <button className="primary-button w-full sm:w-auto" type="submit">
                        {historyGameId ? "保存并关联收藏" : editingId ? "保存修改" : "加入记录"}
                      </button>
                    </div>
                  </div>
                </div>
              </form>
            ) : null}

            {activeView === "settings" && accessStatus === "unlocked" ? (
              <SettingsPage
                settings={settings}
                setSettings={setSettings}
                settingsStatus={settingsStatus}
                setSettingsStatus={setSettingsStatus}
                aiModels={aiModels}
                aiActionStatus={aiActionStatus}
                onSubmit={saveSettings}
                onThemeColorChange={updateThemeColor}
                onAiAction={runAiConfigAction}
                onChangePassword={changePassword}
                onImportClick={importRecordsClick}
                onImport={importRecords}
                onExport={exportRecords}
                fileInputRef={fileInputRef}
              />
            ) : null}

            {activeView === "memberships" && accessStatus === "unlocked" ? (
              <MembershipPage
                settings={settings}
                setSettings={setSettings}
                settingsStatus={settingsStatus}
                psPlusStatus={psPlusStatus}
                onSubmit={saveSettings}
                onSyncPsPlus={() => syncPsPlusGames(false)}
              />
            ) : null}

            {activeView === "ps-plus-catalog" ? (
              <PsPlusCatalogPage
                accessStatus={accessStatus}
                catalog={catalog}
                catalogQuery={catalogQuery}
                catalogStatus={catalogStatus}
                catalogError={catalogError}
                displayMode={catalogDisplayMode}
                filteredGames={filteredCatalogGames}
                visibleGames={visibleCatalogGames}
                onQueryChange={setCatalogQuery}
                onDisplayModeChange={setCatalogDisplayMode}
                onLoad={loadPsPlusCatalog}
                onLoadMore={(increment) => setCatalogVisibleCount((count) => count + increment)}
              />
            ) : null}

            {activeView === "records" ? (
              <section className="flex min-w-0 flex-col gap-4">
                <div className="filter-panel main-filter-panel">
                  <label className="field">
                    <span>搜索</span>
                    <span className="library-search-control">
                      <LibraryControlIcon name="search" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="游戏、版本、介质、渠道、备注"
                      />
                    </span>
                  </label>
                  <div className="field">
                    <span>展示方式</span>
                    <div className="display-mode-switch" role="group" aria-label="记录展示方式">
                      <button
                        className={recordDisplayMode === "grid" ? "active" : ""}
                        type="button"
                        aria-pressed={recordDisplayMode === "grid"}
                        onClick={() => setRecordDisplayMode("grid")}
                      >
                        <LibraryControlIcon name="grid" />
                        <span>网格</span>
                      </button>
                      <button
                        className={recordDisplayMode === "list" ? "active" : ""}
                        type="button"
                        aria-pressed={recordDisplayMode === "list"}
                        onClick={() => setRecordDisplayMode("list")}
                      >
                        <LibraryControlIcon name="list" />
                        <span>列表</span>
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <span>排序</span>
                    <div className="library-sort-menu" ref={sortMenuRef}>
                      <button
                        className="library-sort-trigger"
                        type="button"
                        aria-controls="library-sort-options"
                        aria-expanded={sortMenuOpen}
                        onClick={() => setSortMenuOpen((open) => !open)}
                      >
                        <span className="library-sort-trigger__label">
                          <LibraryControlIcon
                            name={
                              librarySortOptions.find((option) => option.value === sortBy)?.icon ||
                              "clock"
                            }
                          />
                          <span>
                            {librarySortOptions.find((option) => option.value === sortBy)?.label}
                          </span>
                        </span>
                        <LibraryControlIcon name="chevron" />
                      </button>
                      {sortMenuOpen ? (
                        <div
                          className="library-sort-popover"
                          id="library-sort-options"
                          role="group"
                          aria-label="排序方式"
                        >
                          {librarySortOptions.map((option) => {
                            const unavailable = option.value === "price" && !platformRecords.length;
                            return (
                              <button
                                className="library-sort-option"
                                type="button"
                                aria-pressed={sortBy === option.value}
                                disabled={unavailable}
                                key={option.value}
                                onClick={() => {
                                  setSortBy(option.value);
                                  setSortMenuOpen(false);
                                }}
                              >
                                <LibraryControlIcon name={option.icon} />
                                <span>
                                  <strong>{option.label}</strong>
                                  <small>
                                    {unavailable ? "有收藏记录后可用" : option.description}
                                  </small>
                                </span>
                                {sortBy === option.value ? (
                                  <LibraryControlIcon name="check" />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                {accessStatus === "unlocked" && activePlatform === "Nintendo Switch" ? (
                  <section
                    className="app-surface history-library-surface overflow-hidden"
                    aria-labelledby="history-library-title"
                  >
                    <div className="surface-toolbar history-library-header">
                      <div>
                        <div className="history-library-title-row">
                          <h2 id="history-library-title">待补收藏资料</h2>
                          <span>{filteredHistoryGames.length} 款</span>
                        </div>
                        <p>
                          历史同步已建立游戏档案；补充版本、介质与购买信息后，会自动进入 NS 收藏。
                        </p>
                      </div>
                      <Link className="ghost-button shrink-0" href="/play/history">
                        管理历史游玩
                      </Link>
                    </div>

                    {filteredHistoryGames.length ? (
                      <div
                        className={`history-library-grid history-library-grid--${recordDisplayMode} p-4 sm:p-5`}
                      >
                        {visibleHistoryGames.map((game) => (
                          <article key={game.id} className="history-library-item">
                            <div className="history-library-cover bg-primary">
                              {game.coverUrl ? (
                                <img
                                  src={game.coverUrl}
                                  alt={`${game.title}封面`}
                                  loading="lazy"
                                  decoding="async"
                                />
                              ) : (
                                <span>{coverLabel(game.title) || "NS"}</span>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3 title={game.title}>{game.title}</h3>
                              <p>{historyGamePlayLabel(game)}</p>
                              <span className="history-source-badge">历史已同步</span>
                            </div>
                            <button
                              className="ghost-button history-library-action"
                              type="button"
                              onClick={() => completeHistoryGame(game)}
                            >
                              补充资料
                            </button>
                          </article>
                        ))}
                        {!query.trim() && filteredHistoryGames.length > 6 ? (
                          <button
                            className="history-library-more"
                            type="button"
                            aria-expanded={historyExpanded}
                            onClick={() => setHistoryExpanded((expanded) => !expanded)}
                          >
                            {historyExpanded
                              ? "收起历史游戏"
                              : `查看其余 ${filteredHistoryGames.length - 6} 款`}
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <p className="px-4 py-4 text-sm font-semibold text-base-content/65 sm:px-5">
                        {unlinkedHistoryGames.length
                          ? "当前搜索没有匹配的历史游戏。"
                          : "历史游戏都已关联收藏；以后同步到的新游戏会自动出现在这里。"}
                      </p>
                    )}
                  </section>
                ) : null}

                <div
                  className={
                    recordDisplayMode === "grid"
                      ? "record-results record-results-grid"
                      : "record-results record-results-list grid"
                  }
                >
                  {filteredRecords.map((record) =>
                    recordDisplayMode === "grid" ? (
                      <article
                        key={record.id}
                        className="record-card flex h-full flex-col overflow-hidden"
                      >
                        <div className="record-cover relative bg-primary">
                          {record.coverUrl ? (
                            <img
                              src={record.coverUrl}
                              alt={`${record.title}封面`}
                              className="record-cover-image"
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center px-8 text-center text-4xl font-black text-primary-content">
                              {coverLabel(record.title) ||
                                (record.platform === "PlayStation" ? "PS" : "NS")}
                            </div>
                          )}
                          <div className="image-badge absolute left-3 top-3">{record.region}</div>
                          <div className="image-badge alt absolute right-3 top-3">
                            {record.soldDate ? "已卖出" : record.format}
                          </div>
                        </div>
                        <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
                          <div>
                            <h3 className="line-clamp-2 min-h-12 text-lg font-semibold leading-6">
                              {record.title}
                            </h3>
                            <p className="mt-1 text-sm text-base-content/60">
                              {record.purchaseDate} · {record.format}
                              {record.seller ? ` · ${record.seller}` : ""}
                            </p>
                            {playSummaries[record.id] ? (
                              <p className="record-play-summary">
                                {purchasePlayLabel(playSummaries[record.id])}
                              </p>
                            ) : null}
                          </div>
                          <div className="mt-auto grid gap-3 border-t border-base-300 pt-3">
                            <div className="grid min-h-[4.6rem] grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-base-content/60">买入</p>
                                <span className="text-2xl font-bold text-primary">
                                  {formatMoney(record.price, record.currency)}
                                </span>
                                {record.currency !== "CNY" ? (
                                  <p className="mt-0.5 text-xs font-semibold leading-4 text-base-content/60">
                                    {formatCnyConversion(
                                      record.price,
                                      record.currency,
                                      exchangeRates,
                                    )}
                                  </p>
                                ) : null}
                              </div>
                              {record.soldDate ? (
                                <div className="min-w-0 text-right">
                                  <p className="text-xs font-semibold text-success">
                                    {record.soldDate} 卖出
                                  </p>
                                  <span className="text-lg font-bold text-success">
                                    {formatMoney(record.soldPrice, record.soldCurrency)}
                                  </span>
                                  {record.soldCurrency !== "CNY" ? (
                                    <p className="mt-0.5 text-xs font-semibold leading-4 text-base-content/60">
                                      {formatCnyConversion(
                                        record.soldPrice,
                                        record.soldCurrency,
                                        exchangeRates,
                                      )}
                                    </p>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            {accessStatus === "unlocked" ? (
                              <div
                                className={`grid gap-2 ${
                                  isPhysicalFormat(record.format) && !record.soldDate
                                    ? "grid-cols-3"
                                    : "grid-cols-2"
                                }`}
                              >
                                {isPhysicalFormat(record.format) && !record.soldDate ? (
                                  <button
                                    className="secondary-button min-w-0 px-2"
                                    type="button"
                                    onClick={() => startSaleRecord(record)}
                                  >
                                    记录卖出
                                  </button>
                                ) : null}
                                <button
                                  className="ghost-button min-w-0 px-2"
                                  type="button"
                                  onClick={() => editRecord(record)}
                                >
                                  编辑
                                </button>
                                <button
                                  className="danger-button min-w-0 px-2"
                                  type="button"
                                  onClick={() => deleteRecord(record.id)}
                                >
                                  删除
                                </button>
                              </div>
                            ) : null}
                          </div>
                          {record.notes ? (
                            <p className="rounded-xl bg-base-200 px-3 py-2 text-sm text-base-content/70">
                              {record.notes}
                            </p>
                          ) : null}
                        </div>
                      </article>
                    ) : (
                      <article key={record.id} className="record-list-row">
                        <div className="record-list-cover bg-primary">
                          {record.coverUrl ? (
                            <img
                              src={record.coverUrl}
                              alt={`${record.title}封面`}
                              loading="lazy"
                              decoding="async"
                            />
                          ) : (
                            <span>
                              {coverLabel(record.title) ||
                                (record.platform === "PlayStation" ? "PS" : "NS")}
                            </span>
                          )}
                        </div>
                        <div className="record-list-main">
                          <div className="min-w-0">
                            <h3 title={record.title}>{record.title}</h3>
                            <p>
                              {record.purchaseDate} · {record.region} · {record.format}
                              {record.seller ? ` · ${record.seller}` : ""}
                            </p>
                            {playSummaries[record.id] ? (
                              <p className="record-play-summary">
                                {purchasePlayLabel(playSummaries[record.id])}
                              </p>
                            ) : null}
                            {record.notes ? (
                              <p className="record-list-notes">{record.notes}</p>
                            ) : null}
                          </div>
                          <div className="record-list-price">
                            <span>买入</span>
                            <strong>{formatMoney(record.price, record.currency)}</strong>
                            {record.currency !== "CNY" ? (
                              <small>
                                {formatCnyConversion(record.price, record.currency, exchangeRates)}
                              </small>
                            ) : null}
                          </div>
                          <div className="record-list-status">
                            <span className={record.soldDate ? "sold" : ""}>
                              {record.soldDate ? "已卖出" : "持有中"}
                            </span>
                            {record.soldDate ? (
                              <strong>{formatMoney(record.soldPrice, record.soldCurrency)}</strong>
                            ) : null}
                          </div>
                        </div>
                        {accessStatus === "unlocked" ? (
                          <div className="record-list-actions">
                            {isPhysicalFormat(record.format) && !record.soldDate ? (
                              <button
                                className="secondary-button"
                                type="button"
                                onClick={() => startSaleRecord(record)}
                              >
                                记录卖出
                              </button>
                            ) : null}
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={() => editRecord(record)}
                            >
                              编辑
                            </button>
                            <button
                              className="danger-button"
                              type="button"
                              onClick={() => deleteRecord(record.id)}
                            >
                              删除
                            </button>
                          </div>
                        ) : null}
                      </article>
                    ),
                  )}
                </div>

                {!filteredRecords.length ? (
                  <div className="empty-state p-10 text-center">
                    {activePlatform === "Nintendo Switch" && unlinkedHistoryGames.length
                      ? "尚未填写收藏资料；可以从上方历史游戏开始完善。"
                      : "这个平台暂无匹配记录"}
                  </div>
                ) : null}

                {shareOpen && accessStatus === "unlocked" ? (
                  <div
                    className="share-dialog-backdrop"
                    role="presentation"
                    onMouseDown={closeSharePanel}
                  >
                    <section
                      ref={shareDialogRef}
                      className="share-dialog"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="share-dialog-title"
                      tabIndex={-1}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="share-dialog-header">
                        <div>
                          <h2 id="share-dialog-title">分享我的游戏收藏</h2>
                          <p>
                            {records.length > maxShareImageRecords
                              ? `共 ${records.length} 款，本图展示前 ${maxShareImageRecords} 款`
                              : `将全部 ${records.length} 款游戏生成一张图片`}
                          </p>
                        </div>
                        <button className="ghost-button" type="button" onClick={closeSharePanel}>
                          关闭
                        </button>
                      </div>
                      <div className="share-options">
                        {[
                          ["showPrice", "买入价格"],
                          ["showSale", "卖出信息"],
                          ["showDate", "购买日期"],
                          ["showNotes", "备注"],
                        ].map(([key, label]) => (
                          <label key={key} className="checkbox-field">
                            <input
                              type="checkbox"
                              checked={shareOptions[key as keyof ShareOptions]}
                              onChange={(event) => {
                                setShareOptions((current) => ({
                                  ...current,
                                  [key]: event.target.checked,
                                }));
                                if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
                                setShareImageUrl("");
                              }}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                      <div className="share-preview">
                        {shareImageUrl ? (
                          <img src={shareImageUrl} alt="游戏收藏分享图预览" />
                        ) : (
                          <div>
                            <strong>
                              {shareStatus === "generating" ? "正在生成" : "预览尚未生成"}
                            </strong>
                            {shareStatus === "error" ? (
                              <span>部分封面可能暂时无法读取，请重试</span>
                            ) : null}
                          </div>
                        )}
                      </div>
                      <div className="share-dialog-actions">
                        <button
                          className="ghost-button"
                          type="button"
                          disabled={shareStatus === "generating"}
                          onClick={generateShareImage}
                        >
                          {shareStatus === "generating" ? "生成中" : "生成预览"}
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={shareStatus === "generating"}
                          onClick={shareLibraryImage}
                        >
                          分享或下载图片
                        </button>
                      </div>
                    </section>
                  </div>
                ) : null}

                {recognizeOpen && accessStatus === "unlocked" ? (
                  <div
                    className="share-dialog-backdrop"
                    role="presentation"
                    onMouseDown={() => setRecognizeOpen(false)}
                  >
                    <section
                      ref={recognizeDialogRef}
                      className="share-dialog purchase-recognition-dialog"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="recognize-title"
                      tabIndex={-1}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="share-dialog-header">
                        <div>
                          <h2 id="recognize-title">识别购买图片</h2>
                          <p>上传订单或交易截图，识别后请确认字段再加入记录</p>
                        </div>
                        <button
                          className="ghost-button"
                          type="button"
                          onClick={() => setRecognizeOpen(false)}
                        >
                          关闭
                        </button>
                      </div>

                      <button
                        className="purchase-upload-zone"
                        type="button"
                        onClick={() => purchaseImageInputRef.current?.click()}
                      >
                        <strong>
                          {recognizeFiles.length
                            ? `已选择 ${recognizeFiles.length} 张图片`
                            : "选择购买截图"}
                        </strong>
                        <span>JPG、PNG 或 WebP，最多 6 张，单张不超过 12MB</span>
                      </button>
                      <input
                        ref={purchaseImageInputRef}
                        className="hidden"
                        type="file"
                        multiple
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(event) => {
                          setRecognizeFiles(Array.from(event.target.files || []).slice(0, 6));
                          setRecognizedGames([]);
                          setRecognizeError("");
                          event.target.value = "";
                        }}
                      />
                      {recognizeFiles.length ? (
                        <div className="purchase-file-list">
                          {recognizeFiles.map((file) => (
                            <span key={`${file.name}-${file.size}`}>{file.name}</span>
                          ))}
                        </div>
                      ) : null}
                      {!recognizedGames.length ? (
                        <button
                          className="primary-button"
                          type="button"
                          disabled={!recognizeFiles.length || recognizeStatus === "recognizing"}
                          onClick={recognizePurchaseImages}
                        >
                          {recognizeStatus === "recognizing" ? "AI 识别中" : "开始识别"}
                        </button>
                      ) : null}
                      {recognizeError ? (
                        <p className="alert alert-warning py-2 text-sm font-semibold">
                          {recognizeError}
                        </p>
                      ) : null}

                      {recognizedGames.length ? (
                        <div className="recognized-games">
                          {recognizedGames.map((game, index) => (
                            <article className="recognized-game" key={index}>
                              <div className="recognized-game-summary">
                                <div>
                                  <strong>{game.title}</strong>
                                  <span>
                                    {game.platform} · {game.region} · {game.format}
                                  </span>
                                </div>
                                <span>置信度 {Math.round(game.confidence * 100)}%</span>
                              </div>
                              <div className="recognized-game-meta">
                                <span>
                                  {game.currency} {game.price}
                                </span>
                                <span>{game.purchaseDate || "未识别购买日期"}</span>
                                <span>{game.seller || "未识别购买平台 / 店铺"}</span>
                              </div>
                              {game.warning ? (
                                <p className="recognized-warning">请核实：{game.warning}</p>
                              ) : null}
                              <button
                                className="primary-button recognized-game-action"
                                type="button"
                                onClick={() => openRecognizedGameInForm(game, index)}
                              >
                                在新增游戏中编辑并匹配官网
                              </button>
                            </article>
                          ))}
                          <div className="share-dialog-actions">
                            <button
                              className="ghost-button"
                              type="button"
                              onClick={recognizePurchaseImages}
                            >
                              重新识别
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  </div>
                ) : null}
              </section>
            ) : null}

            {authPanelOpen ? (
              <div
                className="share-dialog-backdrop"
                role="presentation"
                onMouseDown={() => setAuthPanelOpen(false)}
              >
                <form
                  ref={authDialogRef}
                  className="login-card grid w-full max-w-md gap-4 p-5 sm:p-6"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="auth-dialog-title"
                  tabIndex={-1}
                  onSubmit={submitPassword}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div>
                    <h2 id="auth-dialog-title" className="text-2xl font-bold">
                      {registrationOpen ? "注册管理员账号" : "登录 GameNote"}
                    </h2>
                    <p className="mt-1 text-sm text-base-content/65">
                      {registrationOpen ? "创建首个管理员账号" : "输入管理员账号继续"}
                    </p>
                  </div>
                  <label className="field">
                    <span>账号</span>
                    <input
                      autoComplete="username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="3-32 位字母或数字"
                    />
                  </label>
                  <label className="field">
                    <span>密码</span>
                    <input
                      autoComplete={registrationOpen ? "new-password" : "current-password"}
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="至少 8 位"
                    />
                  </label>
                  {passwordError ? (
                    <p className="alert alert-warning py-2 text-sm font-semibold" role="alert">
                      {passwordError}
                    </p>
                  ) : null}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setAuthPanelOpen(false)}
                    >
                      取消
                    </button>
                    <button className="primary-button" type="submit">
                      {registrationOpen ? "注册并登录" : "登录"}
                    </button>
                  </div>
                </form>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="app-surface p-8 text-center text-sm font-semibold text-base-content/70">
            {storageError || "正在加载记录"}
          </section>
        )}
      </div>

      <aside className="ledger-context-panel">
        <section className="right-panel-section">
          <h2>游戏库概览</h2>
          <div className="right-stats-grid">
            <Stat label="全部游戏" value={`${totalLibraryGames}`} />
            <Stat label="当前平台" value={`${currentPlatformLibraryGames}`} />
            <Stat label="已有收藏" value={`${statsRecords.length}`} />
            <Stat label="待补资料" value={`${unlinkedNintendoHistoryGames.length}`} />
            <Stat
              label={`已卖出 ${soldCount ? `(${soldCount})` : ""}`}
              value={formatCnyTotal(saleCnyStats.total, saleCnyStats.missingRates)}
            />
          </div>
          <div className="sidebar-total">
            <span>总支出 CNY</span>
            <strong>{formatCnyTotal(purchaseCnyStats.total, purchaseCnyStats.missingRates)}</strong>
            <small>
              {statsLibraryLabel} ·{" "}
              {exchangeRates?.date ? `汇率 ${exchangeRates.date}` : "汇率更新中"}
            </small>
          </div>
          {exchangeError ? <p className="sidebar-error">{exchangeError}</p> : null}
        </section>
        {accessStatus === "unlocked" && dashboardStats?.play ? (
          <section className="right-panel-section">
            <h2>游玩概览</h2>
            <div className="right-stats-grid">
              <Stat label="有记录游戏" value={`${dashboardStats.play.games}`} />
              <Stat
                label="数据形式"
                value={
                  dashboardStats.play.timeSemantics === "daily_aggregate"
                    ? "每日汇总"
                    : dashboardStats.play.timeSemantics === "mixed"
                      ? "多来源"
                      : "会话记录"
                }
              />
              <Stat label="已关联收藏" value={`${dashboardStats.purchases.linked}`} />
              <Stat label="待补收藏资料" value={`${unlinkedNintendoHistoryGames.length}`} />
            </div>
            <div className="sidebar-total">
              <span>已记录游玩时长</span>
              <strong>{formatPlayDuration(dashboardStats.play.totalSeconds)}</strong>
              <small>
                {dashboardStats.play.lastPlayedAt
                  ? `最近记录 ${formatPlayDate(dashboardStats.play.lastPlayedAt)}`
                  : "暂无游玩记录"}
              </small>
              {dashboardStats.play.timeSemantics === "daily_aggregate" ||
              dashboardStats.play.timeSemantics === "mixed" ? (
                <small>已关联收藏优先统计 Moon 日报，不叠加其他来源时长。</small>
              ) : null}
            </div>
          </section>
        ) : null}
        {accessStatus === "unlocked" ? (
          <section className="right-panel-section">
            <h2>快捷操作</h2>
            <div className="sidebar-tools">
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  resetForm();
                  setActiveView("form");
                }}
              >
                新增游戏
              </button>
              {settings.aiApiKeyConfigured ? (
                <button className="ghost-button" type="button" onClick={openPurchaseRecognition}>
                  识别购买图
                </button>
              ) : null}
              <button
                className="ghost-button"
                type="button"
                disabled={!records.length}
                onClick={() => setShareOpen(true)}
              >
                分享游戏库
              </button>
            </div>
          </section>
        ) : null}
      </aside>
    </section>
  );
}

function LibraryControlIcon({
  name,
}: {
  name: "search" | "grid" | "list" | "clock" | "price" | "title" | "chevron" | "check";
}) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
  };

  return (
    <svg aria-hidden="true" className="library-control-icon" viewBox="0 0 24 24" {...common}>
      {name === "search" ? (
        <>
          <circle cx="10.7" cy="10.7" r="6.2" />
          <path d="m15.4 15.4 4.1 4.1" />
        </>
      ) : null}
      {name === "grid" ? (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1.4" />
          <rect x="14" y="4" width="6" height="6" rx="1.4" />
          <rect x="4" y="14" width="6" height="6" rx="1.4" />
          <rect x="14" y="14" width="6" height="6" rx="1.4" />
        </>
      ) : null}
      {name === "list" ? (
        <>
          <path d="M8.5 6h11M8.5 12h11M8.5 18h11" />
          <circle cx="4.5" cy="6" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="12" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="18" r="0.75" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {name === "clock" ? (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.7V12l3 1.8" />
        </>
      ) : null}
      {name === "price" ? (
        <>
          <path d="M12 3.8v16.4M15.7 7.2c-.8-.9-2-1.4-3.7-1.4-2.1 0-3.7 1.1-3.7 2.8 0 4.5 7.6 1.7 7.6 6.1 0 2-1.8 3.4-4.2 3.4-1.7 0-3.2-.6-4.2-1.8" />
        </>
      ) : null}
      {name === "title" ? (
        <>
          <path d="M5 6h14M9 6v12M6.5 18h5" />
          <path d="M14.5 11h4.5M16.75 11v7M14.5 18H19" />
        </>
      ) : null}
      {name === "chevron" ? <path d="m8.5 10 3.5 3.5 3.5-3.5" /> : null}
      {name === "check" ? <path d="m5.5 12.5 4 4 9-9" /> : null}
    </svg>
  );
}

function formatPlayDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}
function formatPlayDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  return value
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value))
    : "—";
}

function purchasePlayLabel(summary: PurchasePlaySummary) {
  const time = formatPlayDuration(summary.totalSeconds);
  if (summary.timeSemantics === "daily_aggregate")
    return `已关联 · Moon 已记录 ${time} · ${formatPlayDate(summary.firstPlayedAt)} — ${formatPlayDate(summary.lastPlayedAt)}`;
  if (summary.timeSemantics === "snapshot_observation")
    return `已关联 · Nintendo 累计 ${time} · 观测于 ${formatPlayDate(summary.lastPlayedAt)}`;
  return `已关联 · ${time} · 最近记录 ${formatPlayDate(summary.lastPlayedAt)}`;
}

function historyGamePlayLabel(game: LibraryPlayGame) {
  const time = formatPlayDuration(game.totalSeconds);
  if (game.timeSemantics === "daily_aggregate")
    return `Moon 日报 ${time} · 最近 ${formatPlayDate(game.lastPlayedAt)}`;
  if (game.timeSemantics === "snapshot_observation")
    return `Nintendo 累计 ${time} · 最近观测 ${formatPlayDate(game.lastPlayedAt)}`;
  return `${time} · 最近游玩 ${formatPlayDate(game.lastPlayedAt)}`;
}
