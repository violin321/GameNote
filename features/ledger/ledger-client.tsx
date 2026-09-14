"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayHistoryClient } from "@/features/play-history/play-history-client";
import { normalizeChineseSearchText } from "@/lib/game/title-normalization";
import { ledgerLimits } from "@/lib/ledger/limits";
import { defaultThemeColor, themeColorContent } from "@/lib/ui/theme-color";
import { appVersion } from "@/lib/version";
import { isFrozenPsPlusRecord } from "@/lib/game/ps-plus-record";
import { AppToolbar, Stat } from "./components/app-toolbar";
import { ConfirmationDialog } from "./components/confirmation-dialog";
import {
  catalogPageSize,
  catalogDisplayModeStorageKey,
  currencies,
  emptyForm,
  exchangeCacheKey,
  gamePlatforms,
  regions,
  recordDisplayModeStorageKey,
} from "./constants";
import { MembershipPage, SettingsPage } from "./components/settings-pages";
import { MobileAccountMenu } from "./components/mobile-account-menu";
import { PsPlusCatalogPage } from "./components/ps-plus-catalog-page";
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
  Currency,
  ExchangeRatePayload,
  FormState,
  GameFormat,
  GamePlatform,
  GameRecord,
  NintendoCoverResult,
  PsPlusCatalog,
  RecognizedGame,
  RecordDisplayMode,
  Region,
  SaveStatus,
  SettingsState,
  ShareOptions,
  ToolbarGroup,
  VersionInfo,
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
  isSafeOfficialUrl,
  lookupPriceLabel,
  maxShareImageRecords,
  normalizeFormatForPlatform,
  normalizeLookupCurrency,
  officialUrlLabel,
  officialUrlPlaceholder,
  platformFromPath,
  platformLabel,
  saveStatusLabel,
  setPlatformUrl,
  setViewUrl,
  sumRecordsInCny,
  textMatchesQuery,
  todayString,
} from "./utils";

export default function LedgerClient({
  initialPlatform,
  initialView = "records",
}: {
  initialPlatform: GamePlatform;
  initialView?: ActiveView;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveRequestRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const ledgerUpdatedAtRef = useRef("");
  const coverLookupRequestRef = useRef(0);
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saleEnabled, setSaleEnabled] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>(initialView);
  const [recordDisplayMode, setRecordDisplayMode] = useState<RecordDisplayMode>("grid");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareOptions, setShareOptions] = useState<ShareOptions>({
    showPrice: false,
    showSale: false,
    showDate: false,
    showNotes: false,
  });
  const [shareRecordIds, setShareRecordIds] = useState<string[]>([]);
  const [sharePlatformFilter, setSharePlatformFilter] = useState<"all" | GamePlatform>("all");
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
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [storageError, setStorageError] = useState("");
  const [accessStatus, setAccessStatus] = useState<AccessStatus>("checking");
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [currentUsername, setCurrentUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [forcedNewPassword, setForcedNewPassword] = useState("");
  const [forcedConfirmPassword, setForcedConfirmPassword] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "price" | "title">("date");
  const [regionFilter, setRegionFilter] = useState<Region | "all">("all");
  const [formatFilter, setFormatFilter] = useState<GameFormat | "all">("all");
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
    showPlayStation: true,
    showPsPlusCatalog: true,
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
    membershipPeriods: [],
  });
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [versionInfo, setVersionInfo] = useState<VersionInfo>({
    currentVersion: appVersion,
    latestVersion: "",
    updateAvailable: false,
    checkedAt: "",
  });
  const [versionChecking, setVersionChecking] = useState(false);
  const [aiActionStatus, setAiActionStatus] = useState("");
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [psPlusStatus, setPsPlusStatus] = useState("");
  const [catalog, setCatalog] = useState<PsPlusCatalog | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "error">("idle");
  const [catalogError, setCatalogError] = useState("");
  const [catalogVisibleCount, setCatalogVisibleCount] = useState(catalogPageSize);
  const [catalogDisplayMode, setCatalogDisplayMode] = useState<RecordDisplayMode>("grid");
  const [pendingDeleteRecord, setPendingDeleteRecord] = useState<GameRecord | null>(null);
  const [pendingPasswordRecovery, setPendingPasswordRecovery] = useState(false);
  const shareDialogRef = useDialogAccessibility(shareOpen, closeSharePanel);
  const recognizeDialogRef = useDialogAccessibility(recognizeOpen, () => setRecognizeOpen(false));
  const authDialogRef = useDialogAccessibility<HTMLFormElement>(
    authPanelOpen && !pendingPasswordRecovery,
    requestCloseAuthPanel,
  );

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
        setSaleEnabled(false);
        setActiveView(initialView);
        setStorageReady(true);
      } catch (error) {
        setRecords([]);
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
        passwordChangeRequired?: boolean;
        username?: string | null;
      };
      const requiresPasswordChange = Boolean(payload.passwordChangeRequired);
      setRegistrationOpen(Boolean(payload.registrationOpen));
      setPasswordChangeRequired(requiresPasswordChange);
      setCurrentUsername(payload.username || "");
      if (requiresPasswordChange) setAuthPanelOpen(true);
      await loadLedger(Boolean(payload.authenticated) && !requiresPasswordChange);
    } catch {
      await loadLedger(false);
    }
  }, [loadLedger]);

  const checkVersion = useCallback(async (force = false) => {
    setVersionChecking(true);
    try {
      const response = await fetch(`/api/version${force ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<VersionInfo>;
      if (!response.ok || typeof payload.currentVersion !== "string")
        throw new Error(payload.error || "无法检查更新");
      setVersionInfo({
        currentVersion: payload.currentVersion,
        latestVersion: typeof payload.latestVersion === "string" ? payload.latestVersion : "",
        updateAvailable: payload.updateAvailable === true,
        checkedAt: typeof payload.checkedAt === "string" ? payload.checkedAt : "",
        stale: payload.stale === true,
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
    } catch (error) {
      setVersionInfo((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "无法检查更新",
      }));
    } finally {
      setVersionChecking(false);
    }
  }, []);

  const applyPlatformPage = useCallback(
    (platform: GamePlatform, urlMode: "push" | "replace" | false) => {
      if (urlMode) {
        setPlatformUrl(platform, urlMode);
      }

      setActivePlatform(platform);
      setQuery("");
      setRegionFilter("all");
      setFormatFilter("all");
      setCoverResults([]);
      setCoverError("");

      if (editingId || activeView === "form") {
        setEditingId(null);
        setForm(createEmptyForm(platform));
        setSaleEnabled(false);
        setActiveView("records");
      }
    },
    [activeView, editingId],
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const storedThemeColor = window.localStorage.getItem("gamenote-theme-color");
      if (storedThemeColor && /^#[0-9a-f]{6}$/i.test(storedThemeColor)) {
        document.documentElement.style.setProperty("--color-primary", storedThemeColor);
      }
      checkAccess();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [checkAccess]);

  useEffect(() => {
    void checkVersion();
  }, [checkVersion]);

  useEffect(() => {
    const storedRecordMode = window.localStorage.getItem(recordDisplayModeStorageKey);
    if (storedRecordMode === "grid" || storedRecordMode === "list") {
      setRecordDisplayMode(storedRecordMode);
    }
    const storedCatalogMode = window.localStorage.getItem(catalogDisplayModeStorageKey);
    if (storedCatalogMode === "grid" || storedCatalogMode === "list") {
      setCatalogDisplayMode(storedCatalogMode);
    }
  }, []);

  function changeRecordDisplayMode(mode: RecordDisplayMode) {
    setRecordDisplayMode(mode);
    window.localStorage.setItem(recordDisplayModeStorageKey, mode);
  }

  function changeCatalogDisplayMode(mode: RecordDisplayMode) {
    setCatalogDisplayMode(mode);
    window.localStorage.setItem(catalogDisplayModeStorageKey, mode);
  }

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
      (activeView === "ps-plus-catalog" && !settings.showPsPlusCatalog) ||
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
      if (payload.psPlusEnabled && payload.psPlusAutoAddMonthly)
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
          updated?: number;
          removedDuplicates?: number;
          message?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "同步失败");
        if (
          (payload.added || 0) > 0 ||
          (payload.updated || 0) > 0 ||
          (payload.removedDuplicates || 0) > 0
        ) {
          await loadLedger(true);
          setPsPlusStatus(
            [
              payload.added ? `已自动入库 ${payload.added} 款会免游戏` : "",
              payload.updated ? `已补全 ${payload.updated} 款已有会免信息` : "",
              payload.removedDuplicates ? `已清理 ${payload.removedDuplicates} 条重复记录` : "",
            ]
              .filter(Boolean)
              .join("，"),
          );
        } else if (!silent) setPsPlusStatus(payload.message || "当月会免已同步");
      } catch (error) {
        if (!silent) setPsPlusStatus(error instanceof Error ? error.message : "同步失败");
      }
    },
    [loadLedger],
  );

  useEffect(() => {
    if (accessStatus === "unlocked" && settings.psPlusEnabled && settings.psPlusAutoAddMonthly)
      syncPsPlusGames(true);
  }, [accessStatus, settings.psPlusAutoAddMonthly, settings.psPlusEnabled, syncPsPlusGames]);

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
              : window.location.pathname.startsWith("/play/recent")
                ? "play-recent"
                : window.location.pathname.startsWith("/play/history")
                  ? "play-history"
                  : window.location.pathname.startsWith("/play/unlinked")
                    ? "play-unlinked"
                    : "records",
        );
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyPlatformPage]);

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

  function openAuthPanel() {
    setForcedNewPassword("");
    setForcedConfirmPassword("");
    setPasswordError("");
    setPasswordNotice("");
    setAuthPanelOpen(true);
  }

  function requestCloseAuthPanel() {
    if (!passwordChangeRequired) closeAuthPanel();
  }

  function closeAuthPanel() {
    setAuthPanelOpen(false);
    setForcedNewPassword("");
    setForcedConfirmPassword("");
    setPasswordError("");
    setPasswordNotice("");
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (passwordChangeRequired) {
      if (forcedNewPassword.length < 8 || forcedNewPassword.length > 128) {
        setPasswordError("新密码需为 8-128 位");
        return;
      }
      if (forcedNewPassword !== forcedConfirmPassword) {
        setPasswordError("两次输入的新密码不一致");
        return;
      }
    } else if (!username.trim() || !password) {
      setPasswordError("请输入账号和密码");
      return;
    }

    setPasswordError("");
    setPasswordNotice("");

    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: passwordChangeRequired
            ? "complete-recovery"
            : registrationOpen
              ? "register"
              : "login",
          username,
          password,
          newPassword: forcedNewPassword,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setPasswordError(payload.error || "登录失败");
        return;
      }

      if (passwordChangeRequired) {
        setPasswordChangeRequired(false);
        setForcedNewPassword("");
        setForcedConfirmPassword("");
        setPassword("");
        setCurrentUsername("");
        setPasswordNotice("密码已修改，请使用新密码登录");
        await loadLedger(false);
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        passwordChangeRequired?: boolean;
      };
      setPassword("");
      setCurrentUsername(username.trim());
      setRegistrationOpen(false);
      if (payload.passwordChangeRequired) {
        setPasswordChangeRequired(true);
        setForcedNewPassword("");
        setForcedConfirmPassword("");
        await loadLedger(false);
        return;
      }
      closeAuthPanel();
      await loadLedger(true);
    } catch {
      setPasswordError("无法验证密码，请稍后重试");
    }
  }

  function requestPasswordRecovery() {
    if (!username.trim()) {
      setPasswordError("请先填写管理员账号");
      return;
    }
    setPasswordError("");
    setPendingPasswordRecovery(true);
  }

  async function confirmPasswordRecovery() {
    setPendingPasswordRecovery(false);
    setPasswordError("");
    setPasswordNotice("正在生成临时密码文件");
    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "recover", username }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "生成临时密码失败");
      setPassword("");
      setPasswordNotice("临时密码已写入数据目录下的 password 文件");
      await loadLedger(false);
    } catch (error) {
      setPasswordNotice("");
      setPasswordError(error instanceof Error ? error.message : "生成临时密码失败");
    }
  }

  async function lockLedger() {
    await fetch("/api/access", { method: "DELETE" }).catch(() => undefined);
    saveRequestRef.current += 1;
    setRecordsDirty(false);
    setStorageError("");
    setSaveStatus("idle");
    setCurrentUsername("");
    setEditingId(null);
    setActiveView("records");
    setPassword("");
    await loadLedger(false);
  }

  const platformRecords = useMemo(
    () => records.filter((record) => record.platform === activePlatform),
    [activePlatform, records],
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

  const shareVisibleRecords = useMemo(
    () =>
      sharePlatformFilter === "all"
        ? records
        : records.filter((record) => record.platform === sharePlatformFilter),
    [records, sharePlatformFilter],
  );

  const filteredRecords = useMemo(() => {
    const normalizedQuery = normalizeChineseSearchText(query);
    const matchingRecords = platformRecords.filter(
      (record) =>
        (regionFilter === "all" || record.region === regionFilter) &&
        (formatFilter === "all" || record.format === formatFilter),
    );
    const source = normalizedQuery
      ? matchingRecords.filter((record) =>
          textMatchesQuery(
            [
              record.title,
              record.region,
              record.format,
              record.seller,
              record.notes,
              record.soldDate ? "已卖出" : "持有中",
              isFrozenPsPlusRecord(record, settings.psPlusEnabled) ? "PS Plus 会员冻结" : "",
            ].join(" "),
            normalizedQuery,
          ),
        )
      : matchingRecords;

    return [...source].sort((a, b) => {
      const inactiveOrder =
        Number(Boolean(a.soldDate) || isFrozenPsPlusRecord(a, settings.psPlusEnabled)) -
        Number(Boolean(b.soldDate) || isFrozenPsPlusRecord(b, settings.psPlusEnabled));
      if (inactiveOrder !== 0) return inactiveOrder;

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
  }, [
    exchangeRates,
    formatFilter,
    platformRecords,
    query,
    regionFilter,
    settings.psPlusEnabled,
    sortBy,
  ]);

  const switchCount = records.filter((record) => record.platform === "Nintendo Switch").length;
  const playStationCount = records.length - switchCount;
  const physicalCount = statsRecords.filter((record) => isPhysicalFormat(record.format)).length;
  const digitalCount = statsRecords.length - physicalCount;
  const soldCount = statsRecords.filter((record) => record.soldDate).length;
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
    setForm(createEmptyForm(activePlatform));
    setSaleEnabled(false);
    setCoverResults([]);
    setCoverError("");
    setCoverStatus("idle");
  }

  function switchPlatformPage(platform: GamePlatform) {
    applyPlatformPage(platform, "push");
    setActiveView("records");
  }

  function switchView(view: ActiveView) {
    if (view === "records") {
      setActiveView("records");
      setPlatformUrl(activePlatform, "push");
      return;
    }
    if (
      view === "ps-plus-catalog" ||
      view === "memberships" ||
      view === "play-recent" ||
      view === "play-history" ||
      view === "play-unlinked"
    ) {
      setActiveView(view);
      setViewUrl(view);
      return;
    }
    if (view === "form") {
      setResumeRecognitionAfterSave(false);
      resetForm();
    }
    setActiveView(view);
  }

  function openPurchaseRecognition() {
    setRecognizeOpen(true);
    if (activeView !== "records") setActiveView("records");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized: FormState = {
      ...form,
      title: form.title.trim(),
      seller: isPhysicalFormat(form.format) ? form.seller.trim() : "",
      coverUrl: form.coverUrl.trim(),
      officialUrl: form.officialUrl.trim(),
      notes: form.notes.trim(),
      price: Number(form.price) || 0,
      format: normalizeFormatForPlatform(form.format, form.platform),
      soldDate: isPhysicalFormat(form.format) && saleEnabled ? form.soldDate : "",
      soldPrice:
        isPhysicalFormat(form.format) && saleEnabled && form.soldDate
          ? Number(form.soldPrice) || 0
          : 0,
      soldCurrency: form.soldCurrency,
    };

    if (!normalized.title) {
      return;
    }

    if (editingId) {
      setRecords((current) =>
        current.map((record) =>
          record.id === editingId ? { ...record, ...normalized, id: editingId } : record,
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
    setEditingId(record.id);
    setPlatformUrl(record.platform, "replace");
    setActivePlatform(record.platform);
    setSaleEnabled(Boolean(record.soldDate));
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

  function updateFormat(format: GameFormat) {
    if (!isPhysicalFormat(format)) setSaleEnabled(false);
    setForm((current) => ({
      ...current,
      format,
      seller: isPhysicalFormat(format) ? current.seller : "",
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
    if (!isPhysicalFormat(normalizeFormatForPlatform(form.format, platform))) {
      setSaleEnabled(false);
    }
    setForm((current) => ({
      ...current,
      platform,
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
    setSaleEnabled(checked);
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

  function requestDeleteRecord(record: GameRecord) {
    setPendingDeleteRecord(record);
  }

  function confirmDeleteRecord() {
    if (!pendingDeleteRecord) return;
    const recordId = pendingDeleteRecord.id;
    setRecords((current) => current.filter((record) => record.id !== recordId));
    setRecordsDirty(true);
    setSaveStatus("saving");
    setPendingDeleteRecord(null);
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
      const selectedRecords = records.filter((record) => shareRecordIds.includes(record.id));
      const blob = await createLibraryShareImage(selectedRecords, shareOptions);
      if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
      setShareImageUrl(URL.createObjectURL(blob));
      setShareStatus("idle");
    } catch {
      setShareStatus("error");
    }
  }

  async function shareLibraryImage() {
    try {
      const selectedRecords = records.filter((record) => shareRecordIds.includes(record.id));
      const blob = await createLibraryShareImage(selectedRecords, shareOptions);
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
    setSaleEnabled(false);
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
      const parsedSettings =
        parsed && typeof parsed === "object" && "settings" in parsed
          ? (parsed as { settings?: unknown }).settings
          : null;

      if (
        !Array.isArray(parsedRecords) &&
        (!parsedSettings || typeof parsedSettings !== "object")
      ) {
        throw new Error("JSON 中没有可恢复的记录或设置");
      }
      if (Array.isArray(parsedRecords) && parsedRecords.length > ledgerLimits.maxRecords)
        throw new Error(`记录数量不能超过 ${ledgerLimits.maxRecords} 条`);

      const importedRecords = (Array.isArray(parsedRecords) ? parsedRecords : [])
        .map(normalizeImportedRecord)
        .filter((record): record is GameRecord => Boolean(record));

      if (Array.isArray(parsedRecords) && parsedRecords.length && !importedRecords.length) {
        throw new Error("JSON 中没有有效的游戏记录");
      }

      if (Array.isArray(parsedRecords)) {
        setRecords(importedRecords);
        setRecordsDirty(true);
        setSaveStatus("saving");
      }
      if (parsedSettings && typeof parsedSettings === "object") {
        const response = await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...settings, ...parsedSettings, aiApiKey: "" }),
        });
        const restoredSettings = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(restoredSettings.error || "设置恢复失败");
        setSettings((current) => ({ ...current, ...restoredSettings, aiApiKey: "" }));
        updateThemeColor(restoredSettings.themeColor);
        document.title = restoredSettings.siteTitle;
      }
      resetForm();
      setSettingsStatus(
        [
          Array.isArray(parsedRecords) ? `已导入 ${importedRecords.length} 条记录` : "",
          parsedSettings ? "已恢复设置" : "",
        ]
          .filter(Boolean)
          .join("，"),
      );
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
      <main className="login-screen flex min-h-screen items-center justify-center px-4 py-8 text-base-content">
        <p className="text-sm font-semibold text-base-content/70">正在加载游戏记录</p>
      </main>
    );
  }

  const libraryToolbarItems: ToolbarGroup["items"] = [
    ...(settings.showNintendoSwitch
      ? [
          {
            id: "nintendo-switch",
            label: "Nintendo Switch",
            icon: "NS",
            badge: switchCount,
            active: activeView === "records" && activePlatform === "Nintendo Switch",
            onSelect: () => switchPlatformPage("Nintendo Switch"),
          },
        ]
      : []),
    ...(settings.showPlayStation
      ? [
          {
            id: "playstation",
            label: "PlayStation",
            icon: "PS",
            badge: playStationCount,
            active: activeView === "records" && activePlatform === "PlayStation",
            onSelect: () => switchPlatformPage("PlayStation"),
          },
        ]
      : []),
  ];
  const toolToolbarItems: ToolbarGroup["items"] = [
    ...(settings.showPsPlusCatalog
      ? [
          {
            id: "ps-plus-catalog",
            label: "PS Plus 游戏库",
            icon: "P+",
            active: activeView === "ps-plus-catalog",
            onSelect: () => switchView("ps-plus-catalog"),
          },
        ]
      : []),
    ...(accessStatus === "unlocked" && settings.showMemberships
      ? [
          {
            id: "memberships",
            label: "会员记录",
            icon: "会",
            active: activeView === "memberships",
            onSelect: () => switchView("memberships"),
          },
        ]
      : []),
  ];
  const playToolbarItems: ToolbarGroup["items"] =
    accessStatus === "unlocked"
      ? [
          {
            id: "play-recent",
            label: "最近游玩",
            icon: "近",
            active: activeView === "play-recent",
            onSelect: () => switchView("play-recent"),
          },
          {
            id: "play-history",
            label: "历史游玩",
            icon: "史",
            active: activeView === "play-history",
            onSelect: () => switchView("play-history"),
          },
          {
            id: "play-unlinked",
            label: "关联收藏",
            icon: "联",
            active: activeView === "play-unlinked",
            onSelect: () => switchView("play-unlinked"),
          },
        ]
      : [];
  const toolbarGroups: ToolbarGroup[] = [
    {
      id: "library",
      label: "游戏库",
      items: libraryToolbarItems,
    },
    ...(playToolbarItems.length
      ? [{ id: "play", label: "游玩记录", items: playToolbarItems }]
      : []),
    ...(toolToolbarItems.length ? [{ id: "tools", label: "工具", items: toolToolbarItems }] : []),
    ...(accessStatus === "unlocked"
      ? [
          {
            id: "manage",
            label: "管理工具",
            items: [
              {
                id: "settings",
                label: "设置",
                icon: "设",
                active: activeView === "settings",
                onSelect: () => switchView("settings"),
              },
            ],
          },
        ]
      : []),
  ];
  const mobileToolbarGroups = toolbarGroups.filter((group) => group.id !== "manage");
  const playHeader =
    activeView === "play-recent"
      ? {
          title: "最近游玩",
          description: "按日期查看近期每一段游玩记录",
        }
      : activeView === "play-history"
        ? {
            title: "历史游玩",
            description: "汇总累计时长，并把游玩数据关联到现有收藏",
          }
        : activeView === "play-unlinked"
          ? {
              title: "关联收藏",
              description: "确认自动建议，或手动选择对应的游戏收藏",
            }
          : null;

  return (
    <main className="ledger-page min-h-screen text-base-content">
      <div className="ledger-shell">
        <aside className="ledger-sidebar ledger-sidebar-left">
          <div className="ledger-brand">
            <span>GN</span>
            <div>
              <strong>{settings.siteTitle}</strong>
              <small>游戏收藏记录</small>
            </div>
          </div>
          <AppToolbar groups={toolbarGroups} />
          <div className="sidebar-account">
            {accessStatus === "unlocked" ? (
              <>
                <strong>{currentUsername}</strong>
                <small>管理员</small>
                <button type="button" onClick={lockLedger}>
                  退出登录
                </button>
              </>
            ) : (
              <>
                <strong>访客</strong>
                <small>只读浏览</small>
                <button type="button" onClick={openAuthPanel}>
                  {registrationOpen ? "注册管理员" : "管理员登录"}
                </button>
              </>
            )}
          </div>
        </aside>

        <div className="ledger-main-column">
          <header className="ledger-header">
            <div className="header-primary-row">
              <div className="min-w-0">
                <p className="ledger-kicker">
                  {playHeader
                    ? "Play history"
                    : activeView === "ps-plus-catalog"
                      ? "PlayStation Plus"
                      : activeView === "memberships"
                        ? "Memberships"
                        : platformLabel(activePlatform)}
                </p>
                <h1 className="mt-1 text-2xl font-bold tracking-normal">
                  {playHeader
                    ? playHeader.title
                    : activeView === "ps-plus-catalog"
                      ? "PS Plus 游戏库"
                      : activeView === "memberships"
                        ? "会员记录"
                        : activePlatform === "PlayStation"
                          ? "PlayStation 游戏"
                          : "NS 游戏"}
                </h1>
                <p className="mt-1 text-sm text-base-content/60">
                  {playHeader ? (
                    playHeader.description
                  ) : activeView === "ps-plus-catalog" ? (
                    "浏览港区升级与高级完整会员游戏目录"
                  ) : activeView === "memberships" ? (
                    "记录 NS 与 PS 会员状态和到期时间"
                  ) : (
                    <>
                      共 {platformRecords.length} 款，按
                      {sortBy === "date" ? "购买日期" : sortBy === "price" ? "价格" : "名称"}排列
                    </>
                  )}
                </p>
              </div>
              <div className="header-account-actions">
                {saveStatusLabel(saveStatus) ? (
                  <span
                    className={`text-sm font-semibold ${
                      saveStatus === "error" ? "text-error" : "text-base-content/70"
                    }`}
                  >
                    {saveStatusLabel(saveStatus)}
                  </span>
                ) : null}
                {accessStatus === "locked" ? (
                  <span className="readonly-badge">只读浏览</span>
                ) : null}
                <div className="desktop-header-avatar" aria-hidden="true">
                  {settings.avatarUrl ? (
                    <img className="header-avatar" src={settings.avatarUrl} alt="" />
                  ) : (
                    <span className="header-avatar-fallback">
                      {currentUsername?.[0]?.toUpperCase() || "G"}
                    </span>
                  )}
                </div>
                <MobileAccountMenu
                  avatarUrl={settings.avatarUrl}
                  authenticated={accessStatus === "unlocked"}
                  registrationOpen={registrationOpen}
                  username={currentUsername}
                  onLogin={openAuthPanel}
                  onLogout={lockLedger}
                  onSettings={() => switchView("settings")}
                />
              </div>
            </div>
            {storageError ? (
              <p className="alert alert-warning mt-3 py-2 text-sm font-semibold">{storageError}</p>
            ) : null}
            <div className="mobile-navigation">
              <AppToolbar groups={mobileToolbarGroups} compact />
            </div>
          </header>

          {storageReady ? (
            <section className="min-w-0">
              {activeView === "form" && accessStatus === "unlocked" ? (
                <form onSubmit={handleSubmit} className="app-surface overflow-hidden">
                  <div className="surface-toolbar flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div>
                      <p className="text-xs font-bold uppercase text-primary">
                        {editingId ? "Edit game" : "New game"}
                      </p>
                      <h2 className="mt-1 text-xl font-bold">
                        {editingId ? "编辑游戏" : "新增游戏"}
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {editingId ? (
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
                          <select
                            value={form.platform}
                            onChange={(event) => updatePlatform(event.target.value as GamePlatform)}
                          >
                            {gamePlatforms.map((platform) => (
                              <option key={platform} value={platform}>
                                {platformLabel(platform)}
                              </option>
                            ))}
                          </select>
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
                            <select
                              value={form.currency}
                              onChange={(event) =>
                                updateForm("currency", event.target.value as Currency)
                              }
                            >
                              {currencies.map((currency) => (
                                <option key={currency} value={currency}>
                                  {currencyLabel(currency)}
                                </option>
                              ))}
                            </select>
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
                            required
                            type="date"
                            value={form.purchaseDate}
                            onChange={(event) => updateForm("purchaseDate", event.target.value)}
                          />
                        </label>

                        <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2">
                          <label className="field">
                            <span>版本</span>
                            <select
                              value={form.region}
                              onChange={(event) =>
                                updateForm("region", event.target.value as Region)
                              }
                            >
                              {regions.map((region) => (
                                <option key={region}>{region}</option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            <span>状态</span>
                            <select
                              value={form.format}
                              onChange={(event) => updateFormat(event.target.value as GameFormat)}
                            >
                              {formatOptionsForPlatform(form.platform).map((format) => (
                                <option key={format}>{format}</option>
                              ))}
                            </select>
                          </label>
                        </div>

                        {isPhysicalFormat(form.format) ? (
                          <div className="sale-panel p-3 lg:col-span-2">
                            <label className="checkbox-field">
                              <input
                                type="checkbox"
                                checked={saleEnabled}
                                onChange={(event) => toggleSold(event.target.checked)}
                              />
                              <span>这份实体游戏已卖出</span>
                            </label>

                            {saleEnabled ? (
                              <>
                                <div className="mt-3 grid gap-3 sm:grid-cols-2 md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_minmax(12rem,0.8fr)]">
                                  <label className="field">
                                    <span>卖出日期</span>
                                    <input
                                      required
                                      type="date"
                                      value={form.soldDate}
                                      onChange={(event) =>
                                        updateForm("soldDate", event.target.value)
                                      }
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
                                    <select
                                      value={form.soldCurrency}
                                      onChange={(event) =>
                                        updateForm("soldCurrency", event.target.value as Currency)
                                      }
                                    >
                                      {currencies.map((currency) => (
                                        <option key={currency} value={currency}>
                                          {currencyLabel(currency)}
                                        </option>
                                      ))}
                                    </select>
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

                        {isPhysicalFormat(form.format) ? (
                          <label className="field">
                            <span>购买渠道</span>
                            <input
                              value={form.seller}
                              onChange={(event) => updateForm("seller", event.target.value)}
                              placeholder="淘宝 / 闲鱼 / 线下店"
                            />
                          </label>
                        ) : null}

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
                        <button
                          className="ghost-button w-full sm:w-auto"
                          type="button"
                          onClick={() => setActiveView("records")}
                        >
                          返回记录
                        </button>
                        <button className="primary-button w-full sm:w-auto" type="submit">
                          {editingId ? "保存修改" : "加入记录"}
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
                  versionInfo={versionInfo}
                  versionChecking={versionChecking}
                  onCheckVersion={() => void checkVersion(true)}
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
                  onHistoryCompleted={() => loadLedger(true)}
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
                  onDisplayModeChange={changeCatalogDisplayMode}
                  onLoad={loadPsPlusCatalog}
                  onLoadMore={(increment) => setCatalogVisibleCount((count) => count + increment)}
                />
              ) : null}

              {activeView === "play-recent" ||
              activeView === "play-history" ||
              activeView === "play-unlinked" ? (
                <PlayHistoryClient
                  mode={
                    activeView === "play-recent"
                      ? "recent"
                      : activeView === "play-history"
                        ? "history"
                        : "unlinked"
                  }
                  purchases={records}
                />
              ) : null}

              {activeView === "records" ? (
                <section className="flex min-w-0 flex-col gap-4">
                  <div className="filter-panel main-filter-panel">
                    <label className="field">
                      <span>搜索</span>
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="游戏、版本、状态、渠道、备注"
                      />
                    </label>
                    <label className="field">
                      <span>地区版本</span>
                      <select
                        value={regionFilter}
                        onChange={(event) => setRegionFilter(event.target.value as Region | "all")}
                      >
                        <option value="all">全部地区</option>
                        {regions.map((region) => (
                          <option key={region} value={region}>
                            {region}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>游戏形态</span>
                      <select
                        value={formatFilter}
                        onChange={(event) =>
                          setFormatFilter(event.target.value as GameFormat | "all")
                        }
                      >
                        <option value="all">全部形态</option>
                        {formatOptionsForPlatform(activePlatform).map((format) => (
                          <option key={format} value={format}>
                            {format}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="field">
                      <span>展示方式</span>
                      <div className="display-mode-switch" role="group" aria-label="记录展示方式">
                        <button
                          className={recordDisplayMode === "grid" ? "active" : ""}
                          type="button"
                          aria-pressed={recordDisplayMode === "grid"}
                          onClick={() => changeRecordDisplayMode("grid")}
                        >
                          网格
                        </button>
                        <button
                          className={recordDisplayMode === "list" ? "active" : ""}
                          type="button"
                          aria-pressed={recordDisplayMode === "list"}
                          onClick={() => changeRecordDisplayMode("list")}
                        >
                          列表
                        </button>
                      </div>
                    </div>
                    <label className="field">
                      <span>排序</span>
                      <select
                        value={sortBy}
                        onChange={(event) =>
                          setSortBy(event.target.value as "date" | "price" | "title")
                        }
                      >
                        <option value="date">购买日期</option>
                        <option value="price">价格</option>
                        <option value="title">游戏名字</option>
                      </select>
                    </label>
                  </div>

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
                          className={`record-card flex h-full flex-col overflow-hidden${record.soldDate || isFrozenPsPlusRecord(record, settings.psPlusEnabled) ? " sold-record" : ""}`}
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
                              {record.soldDate
                                ? "已卖出"
                                : isFrozenPsPlusRecord(record, settings.psPlusEnabled)
                                  ? "会员冻结"
                                  : record.format}
                            </div>
                          </div>
                          <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
                            <div>
                              <h3 className="line-clamp-2 min-h-12 text-lg font-semibold leading-6">
                                {isSafeOfficialUrl(record.officialUrl) ? (
                                  <a href={record.officialUrl} target="_blank" rel="noreferrer">
                                    {record.title}
                                  </a>
                                ) : (
                                  record.title
                                )}
                              </h3>
                              <p className="mt-1 text-sm text-base-content/60">
                                {record.purchaseDate} · {record.format}
                                {record.seller ? ` · ${record.seller}` : ""}
                              </p>
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
                                    onClick={() => requestDeleteRecord(record)}
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
                        <article
                          key={record.id}
                          className={`record-list-row${record.soldDate || isFrozenPsPlusRecord(record, settings.psPlusEnabled) ? " sold-record" : ""}`}
                        >
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
                              <h3 title={record.title}>
                                {isSafeOfficialUrl(record.officialUrl) ? (
                                  <a href={record.officialUrl} target="_blank" rel="noreferrer">
                                    {record.title}
                                  </a>
                                ) : (
                                  record.title
                                )}
                              </h3>
                              <p>
                                {record.purchaseDate} · {record.region} · {record.format}
                                {record.seller ? ` · ${record.seller}` : ""}
                              </p>
                              {record.notes ? (
                                <p className="record-list-notes">{record.notes}</p>
                              ) : null}
                            </div>
                            <div className="record-list-price">
                              <span>买入</span>
                              <strong>{formatMoney(record.price, record.currency)}</strong>
                              {record.currency !== "CNY" ? (
                                <small>
                                  {formatCnyConversion(
                                    record.price,
                                    record.currency,
                                    exchangeRates,
                                  )}
                                </small>
                              ) : null}
                            </div>
                            <div className="record-list-status">
                              <span
                                className={
                                  record.soldDate
                                    ? "sold"
                                    : isFrozenPsPlusRecord(record, settings.psPlusEnabled)
                                      ? "frozen"
                                      : ""
                                }
                              >
                                {record.soldDate
                                  ? "已卖出"
                                  : isFrozenPsPlusRecord(record, settings.psPlusEnabled)
                                    ? "会员冻结"
                                    : "持有中"}
                              </span>
                              {record.soldDate ? (
                                <strong>
                                  {formatMoney(record.soldPrice, record.soldCurrency)}
                                </strong>
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
                                onClick={() => requestDeleteRecord(record)}
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
                    <div className="empty-state p-10 text-center">这个平台暂无匹配记录</div>
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
                              {shareRecordIds.length > maxShareImageRecords
                                ? `已选择 ${shareRecordIds.length} 款，本图展示前 ${maxShareImageRecords} 款`
                                : `已选择 ${shareRecordIds.length} / ${records.length} 款游戏`}
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
                        <div className="share-record-picker">
                          <div className="share-record-picker-header">
                            <strong>选择要分享的游戏</strong>
                            <div>
                              <select
                                className="share-platform-filter"
                                value={sharePlatformFilter}
                                aria-label="按平台筛选游戏"
                                onChange={(event) =>
                                  setSharePlatformFilter(event.target.value as "all" | GamePlatform)
                                }
                              >
                                <option value="all">全部平台</option>
                                <option value="Nintendo Switch">NS</option>
                                <option value="PlayStation">PS</option>
                              </select>
                              <button
                                className="ghost-button"
                                type="button"
                                onClick={() =>
                                  setShareRecordIds((current) => [
                                    ...new Set([
                                      ...current,
                                      ...shareVisibleRecords.map((record) => record.id),
                                    ]),
                                  ])
                                }
                              >
                                全选当前
                              </button>
                              <button
                                className="ghost-button"
                                type="button"
                                onClick={() => setShareRecordIds([])}
                              >
                                清空
                              </button>
                            </div>
                          </div>
                          <div className="share-record-list">
                            {shareVisibleRecords.map((record) => (
                              <label key={record.id} className="share-record-item">
                                <input
                                  type="checkbox"
                                  checked={shareRecordIds.includes(record.id)}
                                  onChange={(event) =>
                                    (() => {
                                      setShareRecordIds((current) =>
                                        event.target.checked
                                          ? [...current, record.id]
                                          : current.filter((id) => id !== record.id),
                                      );
                                      if (shareImageUrl) URL.revokeObjectURL(shareImageUrl);
                                      setShareImageUrl("");
                                    })()
                                  }
                                />
                                <span>{record.title}</span>
                                <small>{record.platform === "PlayStation" ? "PS" : "NS"}</small>
                              </label>
                            ))}
                          </div>
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
                            disabled={shareStatus === "generating" || !shareRecordIds.length}
                            onClick={generateShareImage}
                          >
                            {shareStatus === "generating" ? "生成中" : "生成预览"}
                          </button>
                          <button
                            className="primary-button"
                            type="button"
                            disabled={shareStatus === "generating" || !shareRecordIds.length}
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

              <ConfirmationDialog
                open={Boolean(pendingDeleteRecord)}
                title="删除游戏记录？"
                description={
                  pendingDeleteRecord
                    ? `将永久删除“${pendingDeleteRecord.title}”及其价格、日期和备注，此操作无法撤销。`
                    : ""
                }
                onCancel={() => setPendingDeleteRecord(null)}
                onConfirm={confirmDeleteRecord}
              />

              {authPanelOpen && !pendingPasswordRecovery ? (
                <div
                  className="share-dialog-backdrop"
                  role="presentation"
                  onMouseDown={requestCloseAuthPanel}
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
                      <p className="ledger-kicker">
                        {registrationOpen
                          ? "首次使用"
                          : passwordChangeRequired
                            ? "安全验证"
                            : "管理员登录"}
                      </p>
                      <h2 id="auth-dialog-title" className="mt-1 text-2xl font-bold">
                        {registrationOpen
                          ? "注册管理员账号"
                          : passwordChangeRequired
                            ? "请设置新密码"
                            : "登录 GameNote"}
                      </h2>
                    </div>
                    {passwordChangeRequired ? (
                      <>
                        <p className="alert alert-warning py-2 text-sm font-semibold">
                          当前使用的是临时密码。设置新密码后才能继续管理收藏。
                        </p>
                        <label className="field">
                          <span>新密码</span>
                          <input
                            autoComplete="new-password"
                            type="password"
                            value={forcedNewPassword}
                            onChange={(event) => setForcedNewPassword(event.target.value)}
                            placeholder="8-128 位"
                          />
                        </label>
                        <label className="field">
                          <span>确认新密码</span>
                          <input
                            autoComplete="new-password"
                            type="password"
                            value={forcedConfirmPassword}
                            onChange={(event) => setForcedConfirmPassword(event.target.value)}
                            placeholder="再次输入新密码"
                          />
                        </label>
                      </>
                    ) : (
                      <>
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
                      </>
                    )}
                    {passwordNotice ? (
                      <p className="alert alert-success py-2 text-sm font-semibold" role="status">
                        {passwordNotice}
                      </p>
                    ) : null}
                    {passwordError ? (
                      <p className="alert alert-warning py-2 text-sm font-semibold" role="alert">
                        {passwordError}
                      </p>
                    ) : null}
                    <div className={`grid gap-2${passwordChangeRequired ? "" : " grid-cols-2"}`}>
                      {!passwordChangeRequired ? (
                        <button className="ghost-button" type="button" onClick={closeAuthPanel}>
                          取消
                        </button>
                      ) : null}
                      <button className="primary-button" type="submit">
                        {registrationOpen
                          ? "注册并登录"
                          : passwordChangeRequired
                            ? "保存新密码"
                            : "登录"}
                      </button>
                    </div>
                    {!registrationOpen && !passwordChangeRequired ? (
                      <button
                        className="auth-reset-link"
                        type="button"
                        onClick={requestPasswordRecovery}
                      >
                        重置密码
                      </button>
                    ) : null}
                  </form>
                </div>
              ) : null}

              <ConfirmationDialog
                open={pendingPasswordRecovery}
                title="生成临时密码？"
                description="当前密码和所有登录会话将立即失效。临时密码会写入数据目录下的 password 文件。"
                confirmLabel="确认生成"
                onCancel={() => setPendingPasswordRecovery(false)}
                onConfirm={confirmPasswordRecovery}
              />
            </section>
          ) : (
            <section className="app-surface p-8 text-center text-sm font-semibold text-base-content/70">
              {storageError || "正在加载记录"}
            </section>
          )}
        </div>

        <aside className="ledger-sidebar ledger-sidebar-right">
          <section className="right-panel-section">
            <h2>收藏概览</h2>
            <div className="right-stats-grid">
              <Stat label="全部游戏" value={`${statsRecords.length}`} />
              <Stat label="当前平台" value={`${platformRecords.length}`} />
              <Stat label="实体 / 数字" value={`${physicalCount} / ${digitalCount}`} />
              <Stat
                label={`已卖出 ${soldCount ? `(${soldCount})` : ""}`}
                value={formatCnyTotal(saleCnyStats.total, saleCnyStats.missingRates)}
              />
            </div>
            <div className="sidebar-total">
              <span>总支出 CNY</span>
              <strong>
                {formatCnyTotal(purchaseCnyStats.total, purchaseCnyStats.missingRates)}
              </strong>
              <small>
                {statsLibraryLabel} ·{" "}
                {exchangeRates?.date ? `汇率 ${exchangeRates.date}` : "汇率更新中"}
              </small>
            </div>
            {exchangeError ? <p className="sidebar-error">{exchangeError}</p> : null}
          </section>
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
                  onClick={() => {
                    setShareRecordIds(records.map((record) => record.id));
                    setSharePlatformFilter("all");
                    setShareOpen(true);
                  }}
                >
                  分享游戏库
                </button>
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
