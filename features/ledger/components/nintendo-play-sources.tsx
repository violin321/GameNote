"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ConfirmationDialog } from "./confirmation-dialog";

type SourceKind = "moon" | "store";
type ActionKind = "authorize" | "callback" | "sync" | "disconnect";

type MoonStatus = {
  configured?: boolean;
  linked?: boolean;
  pendingAuthorization?: boolean;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  nextSyncAt?: string | null;
  syncing?: boolean;
  deviceCount?: number;
  reportCount?: number;
  latestReportDate?: string | null;
  scheduler?: { enabled?: boolean; intervalSeconds?: number };
  importState?: {
    lastImportedAt?: string | null;
    latestDate?: string | null;
    reportCount?: number;
  };
};

type StoreStatus = {
  configured?: boolean;
  connected?: boolean;
  credentialStatus?: string;
  credentialInvalid?: boolean;
  pendingAuthorization?: boolean;
  titleCount?: number;
  lastSyncedAt?: string | null;
  scheduler?: { enabled?: boolean; intervalSeconds?: number };
  nextSyncAt?: string | null;
  syncing?: boolean;
  lastSchedulerAttemptAt?: string | null;
  lastSchedulerSuccessAt?: string | null;
  lastSchedulerError?: string | null;
  reauthorizationRequired?: boolean;
};

type AuthorizationState = {
  url: string;
  expiresAt: number | null;
};

const sourcePath: Record<SourceKind, string> = {
  moon: "/api/moon-connector",
  store: "/api/nintendo-store",
};

const emptyAuthorization: Record<SourceKind, AuthorizationState> = {
  moon: { url: "", expiresAt: null },
  store: { url: "", expiresAt: null },
};

export function NintendoPlaySources() {
  const [moon, setMoon] = useState<MoonStatus | null>(null);
  const [store, setStore] = useState<StoreStatus | null>(null);
  const [loading, setLoading] = useState<Record<SourceKind, boolean>>({
    moon: true,
    store: true,
  });
  const [loadError, setLoadError] = useState<Record<SourceKind, string>>({
    moon: "",
    store: "",
  });
  const [activeAction, setActiveAction] = useState<Record<SourceKind, ActionKind | null>>({
    moon: null,
    store: null,
  });
  const [authorization, setAuthorization] =
    useState<Record<SourceKind, AuthorizationState>>(emptyAuthorization);
  const [callbackUrl, setCallbackUrl] = useState<Record<SourceKind, string>>({
    moon: "",
    store: "",
  });
  const [notice, setNotice] = useState<Record<SourceKind, string>>({ moon: "", store: "" });
  const [pendingDisconnect, setPendingDisconnect] = useState<SourceKind | null>(null);
  const refreshSequence = useRef<Record<SourceKind, number>>({ moon: 0, store: 0 });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void Promise.all((["moon", "store"] as const).map((source) => refresh(source)));
    return () => {
      mounted.current = false;
    };
  }, []);

  async function refresh(source: SourceKind) {
    const requestId = ++refreshSequence.current[source];
    setLoading((current) => ({ ...current, [source]: true }));
    try {
      const payload = await requestStatus(`${sourcePath[source]}/status`);
      if (!mounted.current || requestId !== refreshSequence.current[source]) return;
      if (source === "moon") setMoon(payload as MoonStatus);
      else setStore(payload as StoreStatus);
      setLoadError((current) => ({ ...current, [source]: "" }));
    } catch (error) {
      if (mounted.current && requestId === refreshSequence.current[source])
        setLoadError((current) => ({ ...current, [source]: friendlyError(error) }));
    } finally {
      if (mounted.current && requestId === refreshSequence.current[source])
        setLoading((current) => ({ ...current, [source]: false }));
    }
  }

  async function beginAuthorization(source: SourceKind) {
    setActiveAction((current) => ({ ...current, [source]: "authorize" }));
    setNotice((current) => ({ ...current, [source]: "" }));
    setCallbackUrl((current) => ({ ...current, [source]: "" }));
    try {
      const payload = await requestObject(`${sourcePath[source]}/authorize`, { method: "POST" });
      const url = typeof payload.authorizationUrl === "string" ? payload.authorizationUrl : "";
      if (!isNintendoAuthorizationUrl(url)) throw new Error("invalid_authorization_response");
      setAuthorization((current) => ({
        ...current,
        [source]: {
          url,
          expiresAt: Number.isSafeInteger(payload.expiresAt) ? Number(payload.expiresAt) : null,
        },
      }));
      setNotice((current) => ({
        ...current,
        [source]: "授权链接已生成。完成 Nintendo 登录后，把浏览器最终跳转地址完整粘贴到下方。",
      }));
      await refresh(source);
    } catch (error) {
      setNotice((current) => ({ ...current, [source]: friendlyError(error) }));
    } finally {
      setCallbackUrl((current) => ({ ...current, [source]: "" }));
      setActiveAction((current) => ({ ...current, [source]: null }));
    }
  }

  async function submitCallback(source: SourceKind) {
    const value = callbackUrl[source].trim();
    if (!value) {
      setNotice((current) => ({ ...current, [source]: "请粘贴 Nintendo 登录后的完整跳转地址。" }));
      return;
    }
    setActiveAction((current) => ({ ...current, [source]: "callback" }));
    setNotice((current) => ({ ...current, [source]: "" }));
    try {
      await requestObject(`${sourcePath[source]}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackUrl: value }),
      });
      setCallbackUrl((current) => ({ ...current, [source]: "" }));
      setAuthorization((current) => ({ ...current, [source]: { ...emptyAuthorization[source] } }));
      setNotice((current) => ({
        ...current,
        [source]:
          source === "moon"
            ? "家长控制已连接，可以同步官方日报。"
            : "Nintendo Store 已连接，可以立即同步累计时长与近期日报。",
      }));
      await refresh(source);
    } catch (error) {
      setNotice((current) => ({ ...current, [source]: friendlyError(error) }));
    } finally {
      setCallbackUrl((current) => ({ ...current, [source]: "" }));
      setActiveAction((current) => ({ ...current, [source]: null }));
    }
  }

  async function sync(source: SourceKind) {
    setActiveAction((current) => ({ ...current, [source]: "sync" }));
    setNotice((current) => ({ ...current, [source]: "" }));
    try {
      const payload = await requestObject(`${sourcePath[source]}/sync`, { method: "POST" });
      const imported =
        source === "moon"
          ? numberValue(payload.importedReports)
          : numberValue(payload.titleCount ?? payload.count);
      setNotice((current) => ({
        ...current,
        [source]: imported === null ? "同步完成。" : `同步完成，本次处理 ${imported} 条数据。`,
      }));
      await refresh(source);
    } catch (error) {
      setNotice((current) => ({ ...current, [source]: friendlyError(error) }));
      await refresh(source);
    } finally {
      setActiveAction((current) => ({ ...current, [source]: null }));
    }
  }

  async function disconnect(source: SourceKind) {
    setPendingDisconnect(null);
    setActiveAction((current) => ({ ...current, [source]: "disconnect" }));
    setNotice((current) => ({ ...current, [source]: "" }));
    try {
      await requestObject(`${sourcePath[source]}/disconnect`, { method: "POST" });
      setAuthorization((current) => ({ ...current, [source]: { ...emptyAuthorization[source] } }));
      setCallbackUrl((current) => ({ ...current, [source]: "" }));
      setNotice((current) => ({
        ...current,
        [source]: "连接凭据已从当前部署移除；已导入的游玩记录仍会保留。",
      }));
      await refresh(source);
    } catch (error) {
      setNotice((current) => ({ ...current, [source]: friendlyError(error) }));
    } finally {
      setActiveAction((current) => ({ ...current, [source]: null }));
    }
  }

  function handleCallbackKeyDown(source: SourceKind, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!activeAction[source]) void submitCallback(source);
  }

  return (
    <>
      <section className="settings-section play-source-settings">
        <div>
          <h3>Nintendo 游玩数据</h3>
          <p>连接两个互补来源：家长控制提供官方日报，Store 提供累计时长与近期日报。</p>
        </div>
        <div className="play-source-list">
          <MoonSource
            status={moon}
            loading={loading.moon}
            loadError={loadError.moon}
            authorization={authorization.moon}
            callbackUrl={callbackUrl.moon}
            notice={notice.moon}
            activeAction={activeAction.moon}
            onAuthorize={() => void beginAuthorization("moon")}
            onCallback={() => void submitCallback("moon")}
            onCallbackChange={(value) => setCallbackUrl((current) => ({ ...current, moon: value }))}
            onCallbackKeyDown={(event) => handleCallbackKeyDown("moon", event)}
            onSync={() => void sync("moon")}
            onDisconnect={() => setPendingDisconnect("moon")}
            onRetry={() => void refresh("moon")}
          />
          <StoreSource
            status={store}
            loading={loading.store}
            loadError={loadError.store}
            authorization={authorization.store}
            callbackUrl={callbackUrl.store}
            notice={notice.store}
            activeAction={activeAction.store}
            onAuthorize={() => void beginAuthorization("store")}
            onCallback={() => void submitCallback("store")}
            onCallbackChange={(value) =>
              setCallbackUrl((current) => ({ ...current, store: value }))
            }
            onCallbackKeyDown={(event) => handleCallbackKeyDown("store", event)}
            onSync={() => void sync("store")}
            onDisconnect={() => setPendingDisconnect("store")}
            onRetry={() => void refresh("store")}
          />
          <p className="play-source-privacy">
            授权回调只发送给当前 GameNote
            实例。会话和加密密钥保存在部署端私有目录，不会进入数据导出或源码仓库。
          </p>
        </div>
      </section>
      <ConfirmationDialog
        open={pendingDisconnect !== null}
        title="断开 Nintendo 数据源？"
        description="将删除当前部署保存的连接凭据并停止后续同步；已导入的游玩记录和应用数据库中的审计记录不会被删除。"
        onCancel={() => setPendingDisconnect(null)}
        onConfirm={() => {
          if (pendingDisconnect) void disconnect(pendingDisconnect);
        }}
      />
    </>
  );
}

type SourceProps = {
  loading: boolean;
  loadError: string;
  authorization: AuthorizationState;
  callbackUrl: string;
  notice: string;
  activeAction: ActionKind | null;
  onAuthorize: () => void;
  onCallback: () => void;
  onCallbackChange: (value: string) => void;
  onCallbackKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSync: () => void;
  onDisconnect: () => void;
  onRetry: () => void;
};

function MoonSource({ status, ...props }: SourceProps & { status: MoonStatus | null }) {
  const connected = Boolean(status?.linked);
  const pending = Boolean(status?.pendingAuthorization);
  const configured = Boolean(status?.configured);
  const statusText = props.loading
    ? "读取中"
    : props.loadError
      ? "读取失败"
      : !configured
        ? "未配置"
        : connected
          ? "已连接"
          : pending
            ? "等待回调"
            : "未连接";
  const tone = connected ? "success" : props.loadError || status?.lastError ? "error" : "neutral";
  return (
    <SourceLayout
      title="Nintendo Switch 家长控制"
      description="官方日历日报，可按设备保存每天每款游戏的游玩时长；它不是精确开始/结束时间线。"
      statusText={statusText}
      tone={tone}
      configured={configured}
      connected={connected}
      pending={pending}
      syncing={Boolean(status?.syncing)}
      metrics={[
        ["最新日报", status?.importState?.latestDate || status?.latestReportDate || "暂无"],
        [
          "已保存日报",
          `${numberValue(status?.importState?.reportCount ?? status?.reportCount) ?? 0} 天`,
        ],
        ["最近同步", formatDateTime(status?.lastSuccessAt)],
        ["自动同步", scheduleLabel(status?.scheduler, status?.nextSyncAt)],
      ]}
      sourceError={status?.lastError || ""}
      setupHint="需要先按部署文档启动 Moon sidecar，并配置 Unix socket、API key 和加密密钥。"
      {...props}
    />
  );
}

function StoreSource({ status, ...props }: SourceProps & { status: StoreStatus | null }) {
  const invalid = Boolean(status?.credentialInvalid || status?.reauthorizationRequired);
  const connected = Boolean(status?.connected) && !invalid;
  const pending = Boolean(status?.pendingAuthorization);
  const configured = status?.configured === true;
  const statusText = props.loading
    ? "读取中"
    : props.loadError
      ? "读取失败"
      : invalid
        ? "需要重新授权"
        : connected
          ? "已连接"
          : pending
            ? "等待回调"
            : "未连接";
  const tone = connected ? "success" : invalid || props.loadError ? "error" : "neutral";
  return (
    <SourceLayout
      title="Nintendo Store"
      description="保存 Nintendo 账户展示的累计游玩时长，并将近期按日数据作为日报记录，不伪造成精确会话。"
      statusText={statusText}
      tone={tone}
      configured={configured}
      connected={connected}
      pending={pending}
      syncing={Boolean(status?.syncing)}
      metrics={[
        ["累计游戏", `${numberValue(status?.titleCount) ?? 0} 款`],
        ["最近同步", formatDateTime(status?.lastSyncedAt)],
        ["自动同步", scheduleLabel(status?.scheduler, status?.nextSyncAt)],
      ]}
      sourceError={status?.lastSchedulerError || (invalid ? "store_reauthorization_required" : "")}
      setupHint="授权后 session 会以部署实例自己的密钥加密保存；默认低频同步，避免不必要地请求 Nintendo。"
      {...props}
    />
  );
}

function SourceLayout({
  title,
  description,
  statusText,
  tone,
  configured,
  connected,
  pending,
  syncing,
  metrics,
  sourceError,
  setupHint,
  loading,
  loadError,
  authorization,
  callbackUrl,
  notice,
  activeAction,
  onAuthorize,
  onCallback,
  onCallbackChange,
  onCallbackKeyDown,
  onSync,
  onDisconnect,
  onRetry,
}: SourceProps & {
  title: string;
  description: string;
  statusText: string;
  tone: "success" | "error" | "neutral";
  configured: boolean;
  connected: boolean;
  pending: boolean;
  syncing: boolean;
  metrics: Array<[string, string]>;
  sourceError: string;
  setupHint: string;
}) {
  const busy = activeAction !== null || loading;
  return (
    <article className="play-source-item" aria-busy={busy || loading}>
      <header className="play-source-heading">
        <div>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>
        <span className="play-source-status" data-tone={tone}>
          {statusText}
        </span>
      </header>

      {loadError ? (
        <div className="play-source-error" role="alert">
          <span>{loadError}</span>
          <button className="ghost-button" type="button" disabled={busy} onClick={onRetry}>
            重新读取
          </button>
        </div>
      ) : (
        <>
          <dl className="play-source-metrics">
            {metrics.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="play-source-hint">{setupHint}</p>
          {sourceError ? (
            <p className="play-source-error" role="alert">
              {friendlyError(new Error(sourceError))}
            </p>
          ) : null}
          {authorization.url || pending ? (
            <div className="play-source-callback">
              {authorization.url ? (
                <div className="play-source-authorization">
                  <a
                    className="secondary-button"
                    href={authorization.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开 Nintendo 授权
                  </a>
                  <span>{authorizationExpiry(authorization.expiresAt)}</span>
                </div>
              ) : null}
              <label className="field">
                <span>授权后的完整跳转地址</span>
                <input
                  value={callbackUrl}
                  disabled={busy}
                  maxLength={4096}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  placeholder="npf…://auth#session_token_code=…&state=…"
                  onChange={(event) => onCallbackChange(event.target.value)}
                  onKeyDown={onCallbackKeyDown}
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={busy || !callbackUrl.trim()}
                onClick={onCallback}
              >
                {activeAction === "callback" ? "连接中" : "完成连接"}
              </button>
            </div>
          ) : null}
          <div className="settings-actions play-source-actions">
            <button
              className={connected ? "ghost-button" : "primary-button"}
              type="button"
              disabled={busy || !configured}
              onClick={onAuthorize}
            >
              {activeAction === "authorize" ? "生成中" : connected ? "重新授权" : "开始授权"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || !connected || syncing}
              onClick={onSync}
            >
              {activeAction === "sync" || syncing ? "同步中" : "立即同步"}
            </button>
            {connected || pending ? (
              <button
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={onDisconnect}
              >
                {activeAction === "disconnect" ? "断开中" : "断开连接"}
              </button>
            ) : null}
          </div>
          {notice ? (
            <p className="play-source-notice" role="status" aria-live="polite">
              {notice}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}

async function requestObject(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value))
        payload = value as Record<string, unknown>;
    } catch {
      if (response.ok) throw new Error("invalid_server_response");
    }
  }
  if (!response.ok) {
    const code =
      typeof payload.error === "string" ? payload.error : `request_failed_${response.status}`;
    throw new Error(code);
  }
  return payload;
}

async function requestStatus(path: string) {
  const payload = await requestObject(path);
  const scheduler = payload.scheduler;
  if (
    typeof payload.configured !== "boolean" ||
    !scheduler ||
    typeof scheduler !== "object" ||
    Array.isArray(scheduler) ||
    typeof (scheduler as Record<string, unknown>).enabled !== "boolean"
  )
    throw new Error("invalid_server_response");
  return payload;
}

function friendlyError(error: unknown) {
  const code = error instanceof Error ? error.message : String(error || "");
  const messages: Record<string, string> = {
    unauthorized: "登录状态已失效，请重新登录后再试。",
    forbidden: "当前账户没有管理数据源的权限。",
    not_configured: "Nintendo Store 私有目录尚未配置，请先完成部署端设置。",
    sidecar_not_configured: "Moon sidecar 尚未配置，请先完成部署端设置。",
    sidecar_unavailable: "Moon sidecar 暂时不可用，请检查本机服务和 Unix socket。",
    moon_sidecar_unavailable: "Moon sidecar 暂时不可用，请检查本机服务和 Unix socket。",
    moon_authorization_expired: "家长控制授权已过期，请重新生成授权链接。",
    moon_authorization_denied: "Nintendo 未批准家长控制授权，请重新尝试。",
    moon_callback_invalid: "家长控制回调地址无效，请完整复制最终跳转地址。",
    moon_reauthorization_required: "家长控制凭据已失效，请重新授权。",
    moon_unlinked: "家长控制尚未连接，请先完成授权。",
    store_authorization_expired: "Store 授权已过期，请重新生成授权链接。",
    store_authorization_denied: "Nintendo 未批准 Store 授权，请重新尝试。",
    store_callback_invalid: "Store 回调地址无效，请完整复制最终跳转地址。",
    store_reauthorization_required: "Nintendo Store 凭据已失效，请重新授权。",
    store_credential_invalid: "Nintendo Store 凭据已失效，请重新授权。",
    invalid_authorization_response: "服务器返回了无效的授权链接。",
    invalid_server_response: "服务器响应格式不正确，请检查部署日志。",
  };
  if (messages[code]) return messages[code];
  if (code.startsWith("request_failed_")) return `请求失败（HTTP ${code.slice(15)}），请稍后重试。`;
  if (/^[a-z0-9_:-]+$/i.test(code)) return `操作失败：${code}`;
  return "操作失败，请稍后重试。";
}

function isNintendoAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "accounts.nintendo.com" &&
      url.pathname === "/connect/1.0.0/authorize"
    );
  } catch {
    return false;
  }
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatDateTime(value: unknown) {
  if (typeof value !== "string" || !value) return "暂无";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function scheduleLabel(
  scheduler: { enabled?: boolean; intervalSeconds?: number } | undefined,
  nextSyncAt: unknown,
) {
  if (!scheduler?.enabled) return "未启用";
  const seconds = numberValue(scheduler.intervalSeconds);
  const interval = seconds ? intervalLabel(seconds) : "低频";
  const next = formatDateTime(nextSyncAt);
  return next === "暂无" ? interval : `${interval} · 下次 ${next}`;
}

function intervalLabel(seconds: number) {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return `每 ${seconds / 86_400} 天`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `每 ${seconds / 3_600} 小时`;
  return `每 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

function authorizationExpiry(value: number | null) {
  if (!value || value <= Date.now()) return "请尽快完成授权";
  const minutes = Math.max(1, Math.ceil((value - Date.now()) / 60_000));
  return `链接约 ${minutes} 分钟后失效`;
}
