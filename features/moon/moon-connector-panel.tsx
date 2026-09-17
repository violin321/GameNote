"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { MoonImportResult, MoonStatus } from "@/lib/moon/types";

type Status = MoonStatus & {
  importState?: { reportCount: number; latestDate: string | null; lastImportedAt: string | null };
};
type Authorization = { authorizationUrl: string; expiresAt: number };
type Action = "authorize" | "callback" | "sync" | "disconnect";

export function MoonConnectorPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/moon-connector/status", { cache: "no-store", signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "moon_unavailable");
    const nextStatus = payload as Status;
    setStatus(nextStatus);
    if (nextStatus.linked) setAuthorization(null);
    return nextStatus;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      refresh(controller.signal)
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(friendlyError(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  async function refreshStatus(announceAvailability = false) {
    if (action || loading) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const nextStatus = await refresh();
      if (!announceAvailability) return;
      if (nextStatus.configured) {
        setMessage(
          nextStatus.linked
            ? "家长控制采集服务已恢复，原有账号连接仍然有效。"
            : "家长控制采集服务已恢复，现在可以连接账号。",
        );
      } else {
        setError("家长控制采集服务仍未启动。请先启动本机采集服务，再重新检查。");
      }
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  }

  async function perform(nextAction: Action) {
    if (action) return;
    if (
      nextAction === "disconnect" &&
      !window.confirm("解除家长控制连接？已导入的日报和收藏关联会保留。")
    )
      return;
    if (
      nextAction === "callback" &&
      !callbackUrl.trim().startsWith("npf54789befb391a838://auth#")
    ) {
      setError("请粘贴家长控制授权页面返回的完整链接，以 npf54789befb391a838://auth# 开头。");
      return;
    }
    setAction(nextAction);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/moon-connector/${nextAction}`, {
        method: "POST",
        ...(nextAction === "callback"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ callbackUrl: callbackUrl.trim() }),
            }
          : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "moon_unavailable");
      if (nextAction === "authorize") {
        setAuthorization(payload as Authorization);
        setMessage("请打开 Nintendo 授权页面，登录已在家长控制 App 中绑定主机的账号。");
      } else if (nextAction === "callback") {
        setCallbackUrl("");
        setAuthorization(null);
        setMessage("家长控制账号已连接。点击“立即同步日报”获取游玩记录。");
      } else if (nextAction === "sync") {
        const result = payload as MoonImportResult;
        setMessage(
          result.replayed
            ? "同步完成，日报已是最新版本。"
            : `同步完成，更新 ${result.importedReports || 0} 份日报${result.latestDate ? `，最新日期 ${result.latestDate}` : ""}。`,
        );
      } else {
        setCallbackUrl("");
        setAuthorization(null);
        setMessage("已解除连接，已导入的日报和收藏关联已保留。");
      }
      await refresh();
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setAction(null);
    }
  }

  const busy = action !== null;
  const serviceUnavailable = status?.configured === false;
  return (
    <div className="nintendo-connector settings-wide moon-connector" aria-busy={loading || busy}>
      <div className="connector-heading">
        <strong>
          {loading && !status
            ? "正在读取家长控制状态…"
            : status?.linked
              ? "家长控制已连接"
              : "家长控制未连接"}
        </strong>
        <button
          className="ghost-button"
          type="button"
          disabled={busy || loading}
          onClick={() => void refreshStatus()}
        >
          刷新状态
        </button>
      </div>
      <p className="connector-guidance">
        同步每款游戏的每日时长，用于最近游玩、历史游玩和收藏关联。当天记录可能继续更新。
      </p>
      {status?.configured === false ? (
        <p className="connector-inline-warning" id="moon-service-unavailable" role="status">
          家长控制采集服务尚未启动，暂时无法授权。启动服务后，点击下方“重新检查服务”继续。
        </p>
      ) : null}
      {status?.linked ? (
        <>
          <dl className="connector-meta">
            <div>
              <dt>已关联主机</dt>
              <dd>{status.deviceCount} 台</dd>
            </div>
            <div>
              <dt>最近抓取</dt>
              <dd>{dateTime(status.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>已导入日报</dt>
              <dd>{status.importState ? `${status.importState.reportCount} 份` : "等待导入"}</dd>
            </div>
            <div>
              <dt>最近日报日期</dt>
              <dd>{status.importState?.latestDate || "尚未导入"}</dd>
            </div>
            <div>
              <dt>自动同步</dt>
              <dd>
                {status.scheduler.enabled
                  ? `每 ${status.scheduler.intervalSeconds / 3600} 小时`
                  : "未启用"}
              </dd>
            </div>
            <div>
              <dt>{status.scheduler.enabled ? "下次自动同步" : "同步方式"}</dt>
              <dd>{status.scheduler.enabled ? dateTime(status.nextSyncAt) : "手动同步"}</dd>
            </div>
          </dl>
          {status.deviceCount === 0 && status.lastSuccessAt ? (
            <p className="connector-inline-warning">
              该账号暂未返回主机。请先在 Nintendo Switch 家长控制 App 中绑定主机，再同步日报。
            </p>
          ) : null}
          {status.lastError ? (
            <p className="connector-inline-warning">
              最近同步未完成：{friendlyError(new Error(status.lastError))}
            </p>
          ) : null}
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || status.syncing}
              onClick={() => void perform("sync")}
            >
              {action === "sync" || status.syncing ? "正在同步日报…" : "立即同步日报"}
            </button>
            <Link className="ghost-button" href="/play/recent">
              查看最近游玩
            </Link>
            <button
              className="ghost-button"
              type="button"
              disabled={busy}
              onClick={() => void perform("disconnect")}
            >
              解除连接
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="connector-guidance">
            先在官方 Nintendo Switch 家长控制 App
            中绑定主机，再使用同一账号授权。家长控制需要单独登录。
          </p>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || loading}
              aria-describedby={serviceUnavailable ? "moon-service-unavailable" : undefined}
              onClick={() => {
                if (serviceUnavailable) {
                  void refreshStatus(true);
                  return;
                }
                void perform("authorize");
              }}
            >
              {serviceUnavailable
                ? loading
                  ? "正在检查采集服务…"
                  : "重新检查采集服务"
                : action === "authorize"
                  ? "正在准备授权…"
                  : authorization || status?.pendingAuthorization
                    ? "继续家长控制授权"
                    : "连接家长控制账号"}
            </button>
          </div>
        </>
      )}
      {authorization || (!status?.linked && status?.pendingAuthorization) ? (
        <div className="connector-authorization">
          {authorization ? (
            <div className="connector-authorization-link">
              <a
                className="secondary-button"
                href={authorization.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开 Nintendo 授权页面
              </a>
              <span>有效期至 {dateTime(new Date(authorization.expiresAt).toISOString())}</span>
            </div>
          ) : null}
          <p className="connector-guidance">
            登录后，复制“选择此账号”按钮的链接地址并粘贴到下方。若浏览器提示无法打开 App，请复制以
            npf54789befb391a838://auth 开头的完整返回链接。
          </p>
          <label className="field">
            <span>授权返回链接</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="粘贴完整授权返回链接"
            />
          </label>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || !callbackUrl.trim()}
              onClick={() => void perform("callback")}
            >
              {action === "callback" ? "正在验证授权…" : "完成连接"}
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="settings-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="play-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function dateTime(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
        new Date(value),
      )
    : "尚无记录";
}
function friendlyError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    moon_authorization_expired: "授权链接已过期，请重新生成并登录。",
    moon_callback_invalid: "授权返回链接无效，请复制完整的家长控制返回链接后重试。",
    moon_state_mismatch: "返回链接与本次授权不匹配，请使用刚生成的家长控制授权链接。",
    moon_authorization_denied: "Nintendo 授权未完成，请重新打开授权页面。",
    moon_reauthorization_required: "Nintendo 授权已失效，请解除连接后重新授权。",
    moon_rate_limited: "Nintendo 请求较频繁，请稍后重试。",
    moon_upstream_unavailable: "Nintendo 暂时无法提供日报，请稍后重试。",
    moon_upstream_rejected: "Nintendo 暂未接受本次请求，请稍后重试。",
    moon_network_error: "暂时无法访问 Nintendo，请检查网络后重试。",
    moon_timeout: "读取日报超时，请稍后重试。",
    moon_invalid_upstream_data: "Nintendo 返回的日报格式暂不兼容，未导入本次数据。",
    moon_unlinked: "请先连接家长控制账号。",
    moon_busy: "正在处理家长控制操作，请稍候刷新。",
    moon_sync_backoff: "上次同步未成功，系统将在几分钟后重试。",
    moon_import_failed: "日报已抓取但未能导入，请检查本地数据库状态后重试。",
    invalid_snapshot: "日报校验未通过，本次数据未导入。",
    connector_rate_limited: "操作过于频繁，请稍后重试。",
    scheduler_not_configured: "自动同步状态文件尚未配置，请检查本地启动设置。",
    scheduler_conflict: "检测到重复的自动采集配置，请仅保留一个调度服务。",
    unauthorized: "登录已失效，请重新登录 GameNote。",
    sidecar_not_configured: "家长控制采集服务尚未配置。",
    moon_not_configured: "家长控制采集服务尚未配置。",
    sidecar_unavailable: "暂时无法连接家长控制采集服务，请稍后刷新。",
    not_linked: "请先连接家长控制账号。",
    moon_not_linked: "请先连接家长控制账号。",
    pending_expired: "授权链接已过期，请重新生成并登录。",
    state_mismatch: "返回链接与本次授权不匹配，请使用刚生成的家长控制授权链接。",
    invalid_callback: "授权返回链接无效，请复制完整链接后重试。",
    sync_in_progress: "正在同步日报，请稍候刷新。",
    sync_busy: "正在同步日报，请稍候刷新。",
    upstream_401: "Nintendo 授权已失效，请解除连接后重新授权。",
    upstream_429: "Nintendo 请求较频繁，请稍后再试。",
    upstream_503: "Nintendo 暂时无法提供日报，请稍后再试。",
  };
  return messages[code] || "操作未完成，请刷新状态后重试；若授权已过期，请重新连接家长控制账号。";
}
