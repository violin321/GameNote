"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type NintendoConnectorStatus = {
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
  dataSource?: {
    provider: string;
    coralVersion: string;
    completeness: string;
  };
};

type AuthorizeResult = {
  authorizationUrl: string;
  expiresAt: number;
};

type NintendoConsentChallenge = {
  required: boolean;
  schema: string | null;
  version: number | null;
  recipient: string | null;
  riskNotice: string;
  riskNoticeHash: string | null;
};

type SyncResult = {
  replayed?: boolean;
  insertedGames?: number;
  insertedSessions?: number;
};

type Action = "consent" | "authorize" | "callback" | "sync" | "disconnect" | null;

const connectorPath = "/api/nintendo-connector";
const statusPollInterval = 15_000;

export function NintendoConnectorPanel() {
  const [status, setStatus] = useState<NintendoConnectorStatus | null>(null);
  const [authorization, setAuthorization] = useState<AuthorizeResult | null>(null);
  const [consentChallenge, setConsentChallenge] = useState<NintendoConsentChallenge | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const consentChallengeFingerprint = useRef<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${connectorPath}/status`, {
        cache: "no-store",
        signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw new ConnectorRequestError(errorMessage(payload), response.status);
      const nextStatus = payload as NintendoConnectorStatus;
      setStatus(nextStatus);
      if (needsProviderConsent(nextStatus)) {
        const consentResponse = await fetch(`${connectorPath}/consent`, {
          cache: "no-store",
          signal,
        });
        const consentPayload = await readJson(consentResponse);
        if (!consentResponse.ok)
          throw new ConnectorRequestError(errorMessage(consentPayload), consentResponse.status);
        const challenge = parseConsentChallenge(consentPayload);
        if (!challenge)
          throw new ConnectorRequestError("invalid_consent_challenge", consentResponse.status);
        const fingerprint = `${challenge.recipient}\u0000${challenge.riskNoticeHash}`;
        if (
          consentChallengeFingerprint.current !== null &&
          consentChallengeFingerprint.current !== fingerprint
        )
          setConsentAccepted(false);
        consentChallengeFingerprint.current = fingerprint;
        setConsentChallenge(challenge);
      } else {
        consentChallengeFingerprint.current = null;
        setConsentChallenge(null);
        setConsentAccepted(false);
      }
      setError("");
      if (nextStatus.linked) setAuthorization(null);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(toUserMessage(failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadStatus();
    }, statusPollInterval);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void loadStatus();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [loadStatus]);

  async function grantConsent() {
    if (!consentAccepted || !consentChallenge?.required || !consentChallenge.riskNoticeHash) {
      setError("请先阅读风险说明并主动勾选同意。");
      return;
    }
    setAction("consent");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${connectorPath}/consent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          riskNoticeHash: consentChallenge.riskNoticeHash,
          acknowledged: true,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw new ConnectorRequestError(errorMessage(payload), response.status);
      setConsentAccepted(false);
      setMessage("第三方 Provider 风险同意已记录。现在可以生成 Nintendo 官方授权链接。");
      await loadStatus();
    } catch (failure) {
      const userMessage = toUserMessage(failure);
      setConsentAccepted(false);
      if (failure instanceof ConnectorRequestError && failure.status === 409) await loadStatus();
      setError(userMessage);
    } finally {
      setAction(null);
    }
  }

  async function authorize() {
    setAction("authorize");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${connectorPath}/authorize`, { method: "POST" });
      const payload = await readJson(response);
      if (!response.ok) throw new ConnectorRequestError(errorMessage(payload), response.status);
      const result = payload as AuthorizeResult;
      setAuthorization(result);
      setMessage("授权链接已生成。请在 Nintendo 页面完成登录后复制回调地址。");
    } catch (failure) {
      const userMessage = toUserMessage(failure);
      if (isProviderConsentConflict(failure)) await loadStatus();
      setError(userMessage);
    } finally {
      setAction(null);
    }
  }

  async function submitCallback() {
    const value = callbackUrl.trim();
    if (!isNintendoCallbackUrl(value)) {
      setError(
        "回调地址格式不正确，请粘贴以 npf…://auth 开头且包含 session_token_code 的完整地址。",
      );
      return;
    }
    setAction("callback");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${connectorPath}/callback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackUrl: value }),
      });
      if (!response.ok) {
        const payload = await readJson(response);
        throw new ConnectorRequestError(errorMessage(payload), response.status);
      }
      setCallbackUrl("");
      setAuthorization(null);
      setMessage("Nintendo 账号已连接，正在刷新连接状态。");
      await loadStatus();
    } catch (failure) {
      setError(toUserMessage(failure));
    } finally {
      setAction(null);
    }
  }

  async function syncNow() {
    setAction("sync");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${connectorPath}/sync`, { method: "POST" });
      const payload = await readJson(response);
      if (!response.ok) throw new ConnectorRequestError(errorMessage(payload), response.status);
      const result = payload as SyncResult;
      const imported = (result.insertedGames || 0) + (result.insertedSessions || 0);
      setMessage(
        result.replayed
          ? "同步完成，当前快照已导入过，无需重复写入。"
          : `同步完成${imported ? `，新增 ${result.insertedGames || 0} 款游戏、${result.insertedSessions || 0} 段会话` : ""}。`,
      );
      await loadStatus();
    } catch (failure) {
      setError(toUserMessage(failure));
    } finally {
      setAction(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("确定解除 Nintendo 账号绑定吗？已导入的游玩记录不会被删除。")) return;
    setAction("disconnect");
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${connectorPath}/disconnect`, { method: "POST" });
      if (!response.ok) {
        const payload = await readJson(response);
        throw new ConnectorRequestError(errorMessage(payload), response.status);
      }
      setAuthorization(null);
      setCallbackUrl("");
      setMessage("Nintendo 账号绑定已解除，已导入的游玩记录仍会保留。");
      await loadStatus();
    } catch (failure) {
      setError(toUserMessage(failure));
    } finally {
      setAction(null);
    }
  }

  const busy = action !== null;
  const consentRequired = Boolean(status && needsProviderConsent(status));
  const canAuthorize = Boolean(
    status?.provider.enabled &&
      (status.provider.mode !== "fancy" || status.provider.receipt.status === "valid"),
  );
  return (
    <div className="nintendo-connector settings-wide" aria-busy={loading || busy}>
      <div className="connector-heading">
        <div>
          <span className={`connector-status-dot ${status?.linked ? "is-linked" : ""}`} />
          <strong>
            {loading && !status
              ? "正在查询连接状态…"
              : status?.linked
                ? "Nintendo 账号已连接"
                : "Nintendo 账号未连接"}
          </strong>
        </div>
        <button
          className="ghost-button connector-refresh"
          type="button"
          disabled={loading || busy}
          onClick={() => {
            setLoading(true);
            void loadStatus();
          }}
        >
          {loading ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {consentRequired ? (
        <section className="connector-consent" aria-labelledby="nintendo-provider-consent-title">
          <div>
            <strong id="nintendo-provider-consent-title">需要单独确认第三方 Provider 风险</strong>
            <span className="connector-risk-badge">不会自动同意</span>
          </div>
          <p>
            为生成 Nintendo 接口所需的 f 参数，以下第三方会接收短期 Nintendo 身份令牌、Coral
            令牌以及相关 API 请求和响应数据。这些材料可能关联你的 Nintendo
            账号；第三方处理它们会带来隐私、账号与服务可用性风险。
          </p>
          <dl>
            <div>
              <dt>第三方接收者</dt>
              <dd>{consentChallenge?.recipient || status?.provider.recipient || "未知接收者"}</dd>
            </div>
            <div>
              <dt>当前凭据状态</dt>
              <dd>{receiptStatusLabel(status?.provider.receipt.status || "missing")}</dd>
            </div>
          </dl>
          {consentChallenge?.riskNotice ? (
            <div className="connector-risk-notice">
              <strong>完整风险说明</strong>
              <p>{consentChallenge.riskNotice}</p>
            </div>
          ) : (
            <p className="connector-inline-warning">正在读取当前风险说明，暂时不能确认。</p>
          )}
          <label className="connector-consent-check">
            <input
              type="checkbox"
              checked={consentAccepted}
              disabled={busy || !consentChallenge?.riskNoticeHash}
              onChange={(event) => setConsentAccepted(event.target.checked)}
            />
            <span>我已阅读并理解上述风险，明确同意将所述短期材料发送给显示的第三方接收者。</span>
          </label>
          <button
            className="danger-button connector-consent-submit"
            type="button"
            disabled={busy || !consentAccepted || !consentChallenge?.riskNoticeHash}
            onClick={() => void grantConsent()}
          >
            {action === "consent" ? "正在记录明确同意…" : "确认风险并记录同意"}
          </button>
        </section>
      ) : null}

      {status?.linked ? (
        <div className="connector-connected">
          <dl className="connector-meta">
            <div>
              <dt>Provider 模式</dt>
              <dd>{status.provider.mode || "未提供"}</dd>
            </div>
            <div>
              <dt>只读模式</dt>
              <dd>{status.readOnly ? "是，仅同步游玩记录" : "否"}</dd>
            </div>
            <div>
              <dt>上次同步</dt>
              <dd>{formatDateTime(status.sync.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>下次允许手动同步</dt>
              <dd>{formatDateTime(status.sync.nextSyncAt)}</dd>
            </div>
            <div>
              <dt>同步状态</dt>
              <dd>
                {status.sync.inFlight
                  ? "正在同步"
                  : status.sync.hasSnapshot
                    ? "快照可用"
                    : "等待首次同步"}
              </dd>
            </div>
            <div>
              <dt>数据提供方</dt>
              <dd>
                {status.dataSource
                  ? `${status.dataSource.provider} · Coral ${status.dataSource.coralVersion}`
                  : "Nintendo Coral"}
              </dd>
            </div>
          </dl>
          {status.sync.lastError ? (
            <p className="connector-inline-warning">
              最近一次同步：{friendlyErrorCode(status.sync.lastError)}
            </p>
          ) : null}
          <p className="connector-guidance">
            Nintendo PlayLog 是只读快照，并不代表完整的终身游玩历史；同步不会修改 Nintendo
            账号数据。
          </p>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || status.sync.inFlight || consentRequired}
              onClick={() => void syncNow()}
            >
              {action === "sync" || status.sync.inFlight ? "同步中…" : "立即同步"}
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              {action === "disconnect" ? "解除中…" : "解除绑定"}
            </button>
          </div>
        </div>
      ) : (
        <div className="connector-unlinked">
          <ol className="connector-steps">
            <li>如使用第三方 Provider，请先阅读风险、主动勾选并记录明确同意。</li>
            <li>点击下方按钮生成一次性 Nintendo 官方授权链接。</li>
            <li>在新页面登录并同意授权；跳转到无法打开的 npf… 地址是正常现象。</li>
            <li>复制浏览器地址栏中的完整回调地址，粘贴到下方完成绑定。</li>
          </ol>
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy || loading || !canAuthorize}
              onClick={() => void authorize()}
            >
              {action === "authorize"
                ? "正在生成授权链接…"
                : consentRequired
                  ? "请先确认第三方风险"
                  : "连接 Nintendo 账号"}
            </button>
          </div>
          {authorization ? (
            <div className="connector-authorization">
              <div className="connector-authorization-link">
                <div>
                  <strong>授权链接已就绪</strong>
                  <small>有效期至 {formatTimestamp(authorization.expiresAt)}</small>
                </div>
                <a
                  className="ghost-button"
                  href={authorization.authorizationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  打开 Nintendo 授权页
                </a>
              </div>
              <label className="field">
                <span>完整回调地址（仅发送给本机连接器，不会写入日志）</span>
                <input
                  type="password"
                  value={callbackUrl}
                  maxLength={4096}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="npf…://auth#session_token_code=…"
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!busy && callbackUrl.trim()) void submitCallback();
                    }
                  }}
                />
              </label>
              <button
                className="primary-button connector-submit"
                type="button"
                disabled={busy || !callbackUrl.trim()}
                onClick={() => void submitCallback()}
              >
                {action === "callback" ? "正在完成绑定…" : "提交回调并完成绑定"}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="connector-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="connector-feedback is-success" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}

class ConnectorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ConnectorRequestError";
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function errorMessage(payload: unknown) {
  return payload &&
    typeof payload === "object" &&
    typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "nintendo_connector_error";
}

function parseConsentChallenge(payload: unknown): NintendoConsentChallenge | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const challenge = payload as Record<string, unknown>;
  if (
    challenge.required !== true ||
    typeof challenge.schema !== "string" ||
    !Number.isSafeInteger(challenge.version) ||
    typeof challenge.recipient !== "string" ||
    challenge.recipient.length === 0 ||
    challenge.recipient.length > 2048 ||
    typeof challenge.riskNotice !== "string" ||
    challenge.riskNotice.length === 0 ||
    typeof challenge.riskNoticeHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/i.test(challenge.riskNoticeHash)
  )
    return null;
  return challenge as unknown as NintendoConsentChallenge;
}

function toUserMessage(failure: unknown) {
  if (!(failure instanceof ConnectorRequestError)) return "Nintendo 连接器暂时不可用，请稍后重试。";
  return friendlyErrorCode(failure.message);
}

function isProviderConsentConflict(failure: unknown) {
  return (
    failure instanceof ConnectorRequestError &&
    failure.status === 409 &&
    [
      "provider_consent_missing",
      "provider_consent_legacy",
      "provider_consent_stale",
      "provider_consent_revoked",
    ].includes(failure.message)
  );
}

function friendlyErrorCode(code: string) {
  const messages: Record<string, string> = {
    unauthorized: "管理员登录已失效，请重新登录后再试。",
    forbidden: "请求来源校验失败。请从当前 GameNote 页面重试，不要跨站提交。",
    invalid_request: "请求格式不正确，未执行 Nintendo 连接器操作。",
    request_too_large: "请求内容过大，未发送给 Nintendo 连接器。",
    unsupported_media_type: "请求类型不受支持，未执行 Nintendo 连接器操作。",
    sidecar_not_configured: "Nintendo 连接器尚未在服务器上配置。",
    sidecar_unavailable: "Nintendo 连接器服务暂时不可用，请稍后重试。",
    connector_rate_limited: "操作过于频繁，请稍后再试。",
    upstream_rate_limited: "Nintendo 服务限制了请求频率，请稍后再试。",
    invalid_callback: "回调地址无效或已过期，请重新生成授权链接。",
    callback_query_forbidden: "回调地址只能通过输入框提交。",
    invalid_authorize_url: "连接器返回了非官方授权地址，已阻止打开。",
    invalid_authorize_response: "连接器返回的授权信息无效。",
    invalid_consent_challenge: "连接器返回的风险说明无效，已阻止记录同意。",
    consent_required: "尚未完成第三方 Provider 风险确认，请阅读并主动同意后再试。",
    provider_consent_missing: "缺少第三方 Provider 风险同意凭据，请先阅读并明确同意。",
    provider_consent_legacy: "第三方 Provider 同意凭据版本过旧，请重新阅读并确认当前风险。",
    provider_consent_stale: "第三方接收者或风险说明已变化，请重新阅读并明确同意。",
    provider_consent_revoked: "第三方 Provider 同意已撤销，请重新阅读并明确同意。",
    provider_consent_invalid: "第三方 Provider 同意凭据无效，请重新确认风险。",
    provider_consent_notice_mismatch: "风险说明已更新，未记录同意；请刷新后重新阅读。",
    provider_consent_subject_invalid: "本地同意主体无效，未向第三方发送授权材料。",
    provider_disabled: "Nintendo Provider 尚未启用，暂时不能连接账号。",
    invalid_api_key: "服务器与 Nintendo 连接器之间的凭据无效，请联系管理员。",
    not_linked: "Nintendo 账号尚未连接。",
    sync_in_flight: "同步已经在进行中，请稍候。",
    unsupported_snapshot: "连接器快照版本暂不受支持。",
    invalid_snapshot_playlog: "Nintendo 游玩快照格式无效，未导入任何数据。",
    nintendo_connector_error: "Nintendo 连接器操作失败，请稍后重试。",
  };
  return messages[code] || "Nintendo 连接器操作失败，请稍后重试。";
}

function needsProviderConsent(status: NintendoConnectorStatus) {
  return (
    status.provider.mode === "fancy" &&
    status.provider.enabled &&
    status.provider.receipt.status !== "valid"
  );
}

function receiptStatusLabel(status: string) {
  return (
    {
      missing: "尚未同意",
      legacy: "凭据版本过旧",
      stale: "接收者或风险说明已变化",
      revoked: "同意已撤销",
      invalid: "凭据无效",
      valid: "已明确同意",
      not_required: "无需第三方同意",
    }[status] || "状态未知"
  );
}

function isNintendoCallbackUrl(value: string) {
  if (!value || value.length > 4096) return false;
  try {
    const parsed = new URL(value);
    if (!/^npf[a-z0-9]+:$/.test(parsed.protocol) || parsed.hostname !== "auth") return false;
    return new URLSearchParams(parsed.hash.replace(/^#/, "")).has("session_token_code");
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

function formatTimestamp(value: number) {
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return "短时间内";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
