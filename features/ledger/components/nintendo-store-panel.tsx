"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type StoreStatus = {
  connected: boolean;
  pendingAuthorization: boolean;
  titleCount: number;
  lastSyncedAt: string | null;
  scheduler: {
    enabled: boolean;
    intervalSeconds: number;
  };
  nextSyncAt: string | null;
  syncing: boolean;
  lastSchedulerAttemptAt: string | null;
  lastSchedulerSuccessAt: string | null;
  lastSchedulerError: string | null;
};

type StoreAuthorization = {
  authorizationUrl: string;
  expiresAt: number;
};

type StoreSyncResult = {
  count: number;
  skipped: number;
  titleCount: number;
  dailyCount?: number;
  skippedDaily?: number;
  snapshotId?: string;
};

type Action = "authorize" | "callback" | "sync" | "disconnect";

const storePath = "/api/nintendo-store";
const callbackProtocol = "npf5c38e31cd085304b:";
const statusPollInterval = 15_000;

export function NintendoStorePanel() {
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [authorization, setAuthorization] = useState<StoreAuthorization | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const statusController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (foreground = false) => {
    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    if (foreground) setLoading(true);
    try {
      const response = await fetch(`${storePath}/status`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw new StoreRequestError(errorCode(payload), response.status);
      const nextStatus = parseStatus(payload);
      if (!nextStatus) throw new StoreRequestError("store_invalid_status", 502);
      if (controller.signal.aborted) return;
      setStatus(nextStatus);
      setError("");
      if (nextStatus.connected && !requiresStoreReauthorization(nextStatus)) setAuthorization(null);
    } catch (failure) {
      if (!isAbortError(failure)) setError(friendlyError(failure));
    } finally {
      if (statusController.current === controller) {
        statusController.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, statusPollInterval);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      statusController.current?.abort();
      actionController.current?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  async function perform(nextAction: Action) {
    if (actionController.current) return;
    if (
      nextAction === "disconnect" &&
      !window.confirm("解除 Nintendo Store 连接？已同步的累计时长和收藏关联会保留。")
    )
      return;

    const trimmedCallback = callbackUrl.trim();
    if (nextAction === "callback" && !isStoreCallbackUrl(trimmedCallback)) {
      setError("请粘贴 Nintendo 授权页面返回的完整链接，以 npf5c38e31cd085304b://auth 开头。");
      return;
    }

    const controller = new AbortController();
    actionController.current = controller;
    setAction(nextAction);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${storePath}/${nextAction}`, {
        method: "POST",
        signal: controller.signal,
        ...(nextAction === "callback"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ callbackUrl: trimmedCallback }),
            }
          : {}),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new StoreRequestError(errorCode(payload), response.status);
      if (controller.signal.aborted) return;

      if (nextAction === "authorize") {
        const nextAuthorization = parseAuthorization(payload);
        if (!nextAuthorization) throw new StoreRequestError("store_invalid_authorization", 502);
        setAuthorization(nextAuthorization);
        setMessage("授权链接已生成。请登录 Nintendo 账号，然后复制完整返回链接。");
      } else if (nextAction === "callback") {
        setCallbackUrl("");
        setAuthorization(null);
        setMessage("Nintendo Store 已连接。点击“同步累计时长”导入账号数据。");
      } else if (nextAction === "sync") {
        const result = parseSyncResult(payload);
        setMessage(
          result
            ? `同步完成，共更新 ${result.count} 款游戏${result.dailyCount ? `，保存 ${result.dailyCount} 条 Store 日报` : ""}${result.skipped ? `，跳过 ${result.skipped} 条无效累计记录` : ""}${result.skippedDaily ? `，跳过 ${result.skippedDaily} 条无效日报` : ""}；本次累计快照已留存。`
            : "Nintendo Store 累计时长已同步。",
        );
      } else {
        setCallbackUrl("");
        setAuthorization(null);
        setMessage("已解除 Store 连接；已同步的时长与收藏关联仍会保留。");
      }
      await refresh();
    } catch (failure) {
      if (!isAbortError(failure)) {
        if (
          failure instanceof StoreRequestError &&
          failure.message === "store_reauthorization_required"
        )
          await refresh();
        setError(friendlyError(failure));
      }
    } finally {
      if (actionController.current === controller) {
        actionController.current = null;
        if (!controller.signal.aborted) setAction(null);
      }
    }
  }

  const busy = action !== null;
  const authorizationPending = Boolean(authorization || status?.pendingAuthorization);
  const reauthorizationRequired = requiresStoreReauthorization(status);
  const scheduleError = status?.lastSchedulerError
    ? friendlyError(new StoreRequestError(status.lastSchedulerError, 503))
    : "";

  return (
    <div className="nintendo-connector settings-wide moon-connector" aria-busy={loading || busy}>
      <div className="connector-heading">
        <div>
          <span
            className={`connector-status-dot ${status?.connected && !reauthorizationRequired ? "is-linked" : ""}`}
            aria-hidden="true"
          />
          <strong>
            {loading && !status
              ? "正在读取 Store 状态…"
              : reauthorizationRequired
                ? "Nintendo Store 授权已失效"
                : status?.connected
                  ? "Nintendo Store 已连接"
                  : "Nintendo Store 未连接"}
          </strong>
        </div>
        <button
          className="ghost-button connector-refresh"
          type="button"
          disabled={loading || busy}
          onClick={() => void refresh(true)}
        >
          {loading ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      <p className="connector-guidance">
        Store 提供账号累计游玩时长，用于历史游玩、收藏关联和总览；不会与 Moon 日报相加。Store
        的滚动日报会单独保存用于追溯，最近游玩和逐日展示仍以 Moon 为准。
      </p>

      {status?.connected ? (
        <div className="connector-connected">
          {reauthorizationRequired ? (
            <p className="connector-inline-warning" role="alert">
              Nintendo 已拒绝现有凭据。已同步的累计、日报和审计快照不会删除；重新授权后会恢复同步。
            </p>
          ) : status.lastSchedulerError ? (
            <p className="connector-inline-warning" role="status">
              最近一次同步未完成：{scheduleError}
            </p>
          ) : null}
          <dl className="connector-meta">
            <div>
              <dt>已同步游戏</dt>
              <dd>{status.lastSyncedAt ? `${status.titleCount} 款` : "等待首次同步"}</dd>
            </div>
            <div>
              <dt>上次同步</dt>
              <dd>{formatDateTime(status.lastSyncedAt)}</dd>
            </div>
            <div>
              <dt>自动同步</dt>
              <dd>
                {status.scheduler.enabled
                  ? `${formatInterval(status.scheduler.intervalSeconds)}${status.syncing ? " · 正在运行" : ""}`
                  : "未开启"}
              </dd>
            </div>
            <div>
              <dt>下次自动同步</dt>
              <dd>
                {status.scheduler.enabled ? formatDateTime(status.nextSyncAt) : "启用后每日同步"}
              </dd>
            </div>
          </dl>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || loading || !status || status.syncing}
              onClick={() => void perform(reauthorizationRequired ? "authorize" : "sync")}
            >
              {reauthorizationRequired
                ? action === "authorize"
                  ? "正在准备重新授权…"
                  : authorizationPending
                    ? "继续重新授权"
                    : "重新授权 Nintendo Store"
                : action === "sync" || status.syncing
                  ? "正在同步累计时长…"
                  : "同步累计时长"}
            </button>
            <Link className="ghost-button" href="/play/history">
              查看历史游玩
            </Link>
            <button
              className="ghost-button"
              type="button"
              disabled={busy}
              onClick={() => void perform("disconnect")}
            >
              {action === "disconnect" ? "正在解除连接…" : "解除连接"}
            </button>
          </div>
        </div>
      ) : (
        <div className="connector-unlinked">
          <p className="connector-guidance">
            使用 Nintendo 账号授权 Store 游玩记录。登录完成后，浏览器无法打开 npf…
            地址属于正常现象，请复制地址栏中的完整链接。
          </p>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || loading || !status}
              onClick={() => void perform("authorize")}
            >
              {action === "authorize"
                ? "正在准备授权…"
                : authorizationPending
                  ? "继续 Store 授权"
                  : "连接 Nintendo Store"}
            </button>
          </div>
        </div>
      )}

      {authorizationPending && (!status?.connected || reauthorizationRequired) ? (
        <div className="connector-authorization">
          {authorization ? (
            <div className="connector-authorization-link">
              <div>
                <strong>授权链接已就绪</strong>
                <small>有效期至 {formatTimestamp(authorization.expiresAt)}</small>
              </div>
              <a
                className="secondary-button"
                href={authorization.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Nintendo 授权页面
              </a>
            </div>
          ) : (
            <p className="connector-inline-warning">
              检测到未完成的授权。可以粘贴刚才的返回链接，或点击“继续 Store 授权”重新打开页面。
            </p>
          )}
          <label className="field">
            <span>完整返回链接（仅发送到本机，不会显示或写入日志）</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!busy && callbackUrl.trim()) void perform("callback");
                }
              }}
              placeholder="npf5c38e31cd085304b://auth#session_token_code=…"
            />
          </label>
          <button
            className="primary-button connector-submit"
            type="button"
            disabled={busy || !callbackUrl.trim()}
            onClick={() => void perform("callback")}
          >
            {action === "callback" ? "正在验证授权…" : "完成连接"}
          </button>
        </div>
      ) : null}

      {message ? (
        <p className="connector-feedback is-success" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="connector-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

class StoreRequestError extends Error {
  constructor(
    code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "StoreRequestError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {};
  }
}

function errorCode(payload: unknown) {
  return payload &&
    typeof payload === "object" &&
    typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "store_unavailable";
}

function parseStatus(payload: unknown): StoreStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.connected !== "boolean" ||
    typeof value.pendingAuthorization !== "boolean" ||
    !Number.isSafeInteger(value.titleCount) ||
    Number(value.titleCount) < 0 ||
    !(value.lastSyncedAt === null || typeof value.lastSyncedAt === "string") ||
    !value.scheduler ||
    typeof value.scheduler !== "object" ||
    Array.isArray(value.scheduler) ||
    typeof (value.scheduler as Record<string, unknown>).enabled !== "boolean" ||
    !Number.isSafeInteger((value.scheduler as Record<string, unknown>).intervalSeconds) ||
    Number((value.scheduler as Record<string, unknown>).intervalSeconds) < 1 ||
    !(value.nextSyncAt === null || typeof value.nextSyncAt === "string") ||
    typeof value.syncing !== "boolean" ||
    !(value.lastSchedulerAttemptAt === null || typeof value.lastSchedulerAttemptAt === "string") ||
    !(value.lastSchedulerSuccessAt === null || typeof value.lastSchedulerSuccessAt === "string") ||
    !(value.lastSchedulerError === null || typeof value.lastSchedulerError === "string")
  )
    return null;
  return value as StoreStatus;
}

function parseAuthorization(payload: unknown): StoreAuthorization | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.authorizationUrl !== "string" ||
    !Number.isSafeInteger(value.expiresAt) ||
    !isOfficialAuthorizationUrl(value.authorizationUrl)
  )
    return null;
  return value as StoreAuthorization;
}

function parseSyncResult(payload: unknown): StoreSyncResult | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0 ||
    !Number.isSafeInteger(value.skipped) ||
    Number(value.skipped) < 0 ||
    !Number.isSafeInteger(value.titleCount) ||
    Number(value.titleCount) < 0 ||
    !optionalNonNegativeInteger(value.dailyCount) ||
    !optionalNonNegativeInteger(value.skippedDaily) ||
    !(value.snapshotId === undefined || typeof value.snapshotId === "string")
  )
    return null;
  return value as StoreSyncResult;
}

function isOfficialAuthorizationUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "accounts.nintendo.com" &&
      url.pathname === "/connect/1.0.0/authorize" &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function isStoreCallbackUrl(value: string) {
  if (!value || value.length > 4096 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== callbackProtocol || url.hostname !== "auth" || url.pathname) return false;
    const params = new URLSearchParams(url.hash ? url.hash.slice(1) : url.search.slice(1));
    return params.has("session_token_code") && params.has("state");
  } catch {
    return false;
  }
}

function formatDateTime(value: string | null) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatInterval(seconds: number) {
  if (seconds === 86_400) return "每天";
  if (seconds % 86_400 === 0) return `每 ${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `每 ${seconds / 3_600} 小时`;
  return `每 ${Math.max(1, Math.round(seconds / 60))} 分钟`;
}

function optionalNonNegativeInteger(value: unknown) {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function requiresStoreReauthorization(status: StoreStatus | null) {
  return status?.lastSchedulerError === "store_reauthorization_required";
}

function formatTimestamp(value: number) {
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return "短时间内";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isAbortError(value: unknown) {
  return value instanceof DOMException && value.name === "AbortError";
}

function friendlyError(failure: unknown) {
  if (!(failure instanceof StoreRequestError)) return "Nintendo Store 暂时不可用，请稍后重试。";
  const messages: Record<string, string> = {
    unauthorized: "管理员登录已失效，请重新登录 GameNote。",
    forbidden: "请求来源校验失败，请从当前 GameNote 页面重试。",
    invalid_request: "请求格式不正确，未执行 Store 操作。",
    request_too_large: "返回链接过长，未发送到 Store 连接器。",
    unsupported_media_type: "请求类型不受支持，请刷新页面后重试。",
    callback_query_forbidden: "返回链接只能通过下方输入框提交。",
    invalid_callback: "返回链接无效，请复制完整的 Nintendo Store 返回链接。",
    store_rate_limited: "操作过于频繁，请稍后重试。",
    store_authorization_expired: "授权链接已过期，请重新生成并登录。",
    store_callback_invalid: "返回链接无效，请复制完整的 Nintendo Store 返回链接。",
    store_state_mismatch: "返回链接与本次授权不匹配，请使用刚生成的授权链接。",
    store_authorization_denied: "Nintendo 授权未完成，请重新打开授权页面。",
    store_authorization_failed: "Nintendo 暂时无法完成授权，请重新生成链接后重试。",
    store_credential_invalid: "本地 Store 凭据不可用，请解除连接后重新授权。",
    store_reauthorization_required: "Nintendo Store 授权已失效，请重新授权后再同步。",
    store_not_connected: "请先连接 Nintendo Store。",
    store_sync_busy: "Store 累计时长正在同步，请稍候刷新。",
    store_sync_backoff: "上次同步未成功，系统会按低频退避计划重试。",
    store_scheduler_not_configured: "Store 自动同步状态文件尚未配置，请检查启动设置。",
    store_sync_lease_lost: "同步任务的运行租约已失效，本次没有写入数据。",
    store_network_error: "暂时无法访问 Nintendo，请检查网络后重试。",
    store_timeout: "读取 Nintendo Store 超时，请稍后重试。",
    store_sync_failed: "Nintendo Store 同步失败，请稍后重试。",
    store_invalid_upstream_data: "Nintendo 返回的数据格式暂不兼容，本次没有导入。",
    store_import_failed: "Store 数据已获取，但未能导入本地数据库。",
    store_invalid_status: "Store 状态格式异常，请刷新页面后重试。",
    store_invalid_authorization: "授权地址校验失败，已阻止打开。",
    store_status_unavailable: "暂时无法读取 Store 状态，请稍后刷新。",
    store_unavailable: "Nintendo Store 暂时不可用，请稍后重试。",
  };
  return messages[failure.message] || "Nintendo Store 操作未完成，请刷新状态后重试。";
}
