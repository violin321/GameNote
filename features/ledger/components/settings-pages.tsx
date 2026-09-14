"use client";

import { useState } from "react";
import type { ChangeEvent, Dispatch, FormEvent, ReactNode, RefObject, SetStateAction } from "react";
import { currencies } from "../constants";
import type {
  Currency,
  MembershipPeriod,
  MembershipService,
  SettingsState,
  VersionInfo,
} from "../types";
import { ModelCombobox } from "./model-combobox";
import { PsPlusHistory } from "./ps-plus-history";
import { ConfirmationDialog } from "./confirmation-dialog";

type SettingsUpdater = Dispatch<SetStateAction<SettingsState>>;

type SettingsPageProps = {
  settings: SettingsState;
  setSettings: SettingsUpdater;
  settingsStatus: string;
  setSettingsStatus: (message: string) => void;
  aiModels: string[];
  aiActionStatus: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onThemeColorChange: (color: string) => void;
  onAiAction: (action: "models" | "test") => void;
  onChangePassword: () => void;
  onImportClick: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  versionInfo: VersionInfo;
  versionChecking: boolean;
  onCheckVersion: () => void;
};

export function SettingsPage({
  settings,
  setSettings,
  settingsStatus,
  setSettingsStatus,
  aiModels,
  aiActionStatus,
  onSubmit,
  onThemeColorChange,
  onAiAction,
  onChangePassword,
  onImportClick,
  onImport,
  onExport,
  fileInputRef,
  versionInfo,
  versionChecking,
  onCheckVersion,
}: SettingsPageProps) {
  function selectAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || file.size > 500_000) {
      setSettingsStatus("头像需小于 500KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setSettings((current) => ({ ...current, avatarUrl: String(reader.result || "") }));
    reader.readAsDataURL(file);
  }

  return (
    <form className="settings-page" onSubmit={onSubmit}>
      <header>
        <p className="ledger-kicker">Settings</p>
        <h2>设置</h2>
        <span>管理内容展示、外观、AI 识别、数据备份和账户安全</span>
      </header>
      <section className="settings-section">
        <div>
          <h3>外观</h3>
          <p>自定义网站标题、右上角头像和主题色。</p>
        </div>
        <div className="settings-fields">
          <label className="field">
            <span>网站标题</span>
            <input
              value={settings.siteTitle}
              maxLength={40}
              onChange={(event) =>
                setSettings((current) => ({ ...current, siteTitle: event.target.value }))
              }
            />
          </label>
          <label className="field">
            <span>主题色</span>
            <input
              type="color"
              value={settings.themeColor}
              onChange={(event) => {
                setSettings((current) => ({ ...current, themeColor: event.target.value }));
                onThemeColorChange(event.target.value);
              }}
            />
          </label>
          <label className="avatar-upload">
            <span>头像图片（小于 500KB）</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={selectAvatar} />
            {settings.avatarUrl ? <img src={settings.avatarUrl} alt="头像预览" /> : null}
          </label>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h3>内容展示</h3>
          <p>选择侧边栏展示的游戏库和工具；至少保留一个游戏库。</p>
        </div>
        <div className="settings-fields">
          <strong className="settings-wide">游戏库</strong>
          <label className="checkbox-field settings-wide">
            <input
              type="checkbox"
              checked={settings.showNintendoSwitch}
              disabled={settings.showNintendoSwitch && !settings.showPlayStation}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  showNintendoSwitch: event.target.checked,
                }))
              }
            />
            <span>展示 Nintendo Switch 游戏库</span>
          </label>
          <label className="checkbox-field settings-wide">
            <input
              type="checkbox"
              checked={settings.showPlayStation}
              disabled={settings.showPlayStation && !settings.showNintendoSwitch}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  showPlayStation: event.target.checked,
                }))
              }
            />
            <span>展示 PlayStation 游戏库</span>
          </label>
          <strong className="settings-wide">工具</strong>
          <label className="checkbox-field settings-wide">
            <input
              type="checkbox"
              checked={settings.showPsPlusCatalog}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  showPsPlusCatalog: event.target.checked,
                }))
              }
            />
            <span>展示 PS Plus 游戏库</span>
          </label>
          <label className="checkbox-field settings-wide">
            <input
              type="checkbox"
              checked={settings.showMemberships}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  showMemberships: event.target.checked,
                }))
              }
            />
            <span>展示会员记录</span>
          </label>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h3>AI 识别</h3>
          <p>配置兼容 OpenAI Responses API 的服务。</p>
        </div>
        <div className="settings-fields">
          <label className="field">
            <span>API 地址</span>
            <input
              value={settings.aiBaseUrl}
              onChange={(event) =>
                setSettings((current) => ({ ...current, aiBaseUrl: event.target.value }))
              }
            />
          </label>
          <div className="field">
            <label htmlFor="ai-vision-model">视觉模型</label>
            <ModelCombobox
              models={aiModels}
              value={settings.aiModel}
              onChange={(aiModel) => setSettings((current) => ({ ...current, aiModel }))}
            />
          </div>
          <label className="field settings-wide">
            <span>API Key {settings.aiApiKeyConfigured ? "（已配置，留空保持）" : ""}</span>
            <input
              type="password"
              value={settings.aiApiKey}
              onChange={(event) =>
                setSettings((current) => ({ ...current, aiApiKey: event.target.value }))
              }
            />
          </label>
          <div className="settings-actions settings-wide">
            <button className="ghost-button" type="button" onClick={() => onAiAction("models")}>
              获取模型
            </button>
            <button className="ghost-button" type="button" onClick={() => onAiAction("test")}>
              测试接口
            </button>
            {aiActionStatus ? (
              <span className="settings-message" role="status" aria-live="polite">
                {aiActionStatus}
              </span>
            ) : null}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h3>数据备份</h3>
          <p>
            JSON 只备份购买记录与应用设置，不包含游玩历史。完整备份请复制 SQLite；AI API Key
            和账户密码不会导出。
          </p>
        </div>
        <div className="settings-fields">
          <div className="settings-actions settings-wide">
            <button className="ghost-button" type="button" onClick={onImportClick}>
              导入 JSON
            </button>
            <button className="ghost-button" type="button" onClick={onExport}>
              导出 JSON
            </button>
          </div>
          <input
            ref={fileInputRef}
            accept=".json,application/json"
            className="hidden"
            type="file"
            onChange={onImport}
          />
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h3>版本与更新</h3>
          <p>自动检查 GitHub 上发布的最新正式版本。</p>
        </div>
        <div className="version-panel">
          <div className="version-summary">
            <span>当前版本</span>
            <strong>v{versionInfo.currentVersion}</strong>
          </div>
          {versionInfo.updateAvailable ? (
            <p className="version-update-available">
              发现新版本 v{versionInfo.latestVersion}，请更新 Docker 镜像。
            </p>
          ) : versionInfo.error ? (
            <p>{versionInfo.error}，稍后可以重新检查。</p>
          ) : versionInfo.latestVersion ? (
            <p>
              已是最新版本
              {versionInfo.stale ? "（使用上次检查结果）" : ""}
            </p>
          ) : (
            <p>正在获取最新版本信息。</p>
          )}
          <div className="settings-actions">
            <button
              className="ghost-button"
              type="button"
              disabled={versionChecking}
              onClick={onCheckVersion}
            >
              {versionChecking ? "检查中" : "检查更新"}
            </button>
            <a
              className="secondary-button"
              href="https://github.com/dingding229/GameNote/tags"
              target="_blank"
              rel="noreferrer"
            >
              查看版本记录
            </a>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h3>账户安全</h3>
          <p>修改管理员登录密码。</p>
        </div>
        <div className="settings-fields">
          <label className="field">
            <span>当前密码</span>
            <input
              type="password"
              value={settings.currentPassword}
              onChange={(event) =>
                setSettings((current) => ({ ...current, currentPassword: event.target.value }))
              }
            />
          </label>
          <label className="field">
            <span>新密码</span>
            <input
              type="password"
              value={settings.newPassword}
              onChange={(event) =>
                setSettings((current) => ({ ...current, newPassword: event.target.value }))
              }
            />
          </label>
          <button
            className="ghost-button"
            type="button"
            disabled={!settings.currentPassword || !settings.newPassword}
            onClick={onChangePassword}
          >
            修改密码
          </button>
        </div>
      </section>
      <footer>
        <span role="status" aria-live="polite">
          {settingsStatus}
        </span>
        <button className="primary-button" type="submit">
          保存设置
        </button>
      </footer>
    </form>
  );
}

type MembershipPageProps = {
  settings: SettingsState;
  setSettings: SettingsUpdater;
  settingsStatus: string;
  psPlusStatus: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSyncPsPlus: () => void;
  onHistoryCompleted: () => Promise<void>;
};

export function MembershipPage({
  settings,
  setSettings,
  settingsStatus,
  psPlusStatus,
  onSubmit,
  onSyncPsPlus,
  onHistoryCompleted,
}: MembershipPageProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [pendingPeriod, setPendingPeriod] = useState<MembershipPeriod | null>(null);

  function addPeriod(service: MembershipService) {
    setSettings((current) => ({
      ...current,
      membershipPeriods: [
        {
          id: crypto.randomUUID(),
          service,
          startDate: today,
          endDate: today,
          price: 0,
          currency: "CNY",
        },
        ...current.membershipPeriods,
      ],
    }));
  }

  function updatePeriod<Key extends keyof MembershipPeriod>(
    id: string,
    key: Key,
    value: MembershipPeriod[Key],
  ) {
    setSettings((current) => ({
      ...current,
      membershipPeriods: current.membershipPeriods.map((period) =>
        period.id === id ? { ...period, [key]: value } : period,
      ),
    }));
  }

  function removePeriod(id: string) {
    setSettings((current) => ({
      ...current,
      membershipPeriods: current.membershipPeriods.filter((period) => period.id !== id),
    }));
  }

  function confirmPeriodRemoval() {
    if (!pendingPeriod) return;
    removePeriod(pendingPeriod.id);
    setPendingPeriod(null);
  }

  const hasActivePsPlus = settings.membershipPeriods.some(
    (period) =>
      period.service === "PlayStation Plus" &&
      (!period.startDate || period.startDate <= today) &&
      period.endDate >= today,
  );

  return (
    <form className="settings-page membership-page" onSubmit={onSubmit}>
      <header>
        <p className="ledger-kicker">Memberships</p>
        <h2>会员记录</h2>
        <span>按时间段保存会员历史、有效期和购买价格</span>
      </header>
      {(["Nintendo Switch Online", "PlayStation Plus"] as const).map((service) => (
        <MembershipPeriodSection
          key={service}
          service={service}
          periods={settings.membershipPeriods.filter((period) => period.service === service)}
          today={today}
          onAdd={() => addPeriod(service)}
          onChange={updatePeriod}
          onRemove={(id) =>
            setPendingPeriod(settings.membershipPeriods.find((period) => period.id === id) || null)
          }
        >
          {service === "PlayStation Plus" ? (
            <>
              <label className="checkbox-field settings-wide">
                <input
                  type="checkbox"
                  disabled={!hasActivePsPlus}
                  checked={settings.psPlusAutoAddMonthly}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      psPlusAutoAddMonthly: event.target.checked,
                    }))
                  }
                />
                <span>会员有效期间自动识别并加入每月会免游戏</span>
              </label>
              <button
                className="ghost-button"
                type="button"
                disabled={!hasActivePsPlus || !settings.psPlusAutoAddMonthly}
                onClick={onSyncPsPlus}
              >
                立即检查本月会免
              </button>
              {psPlusStatus ? (
                <p className="settings-wide settings-message" role="status" aria-live="polite">
                  {psPlusStatus}
                </p>
              ) : null}
              <PsPlusHistory
                periods={settings.membershipPeriods.filter(
                  (period) => period.service === "PlayStation Plus",
                )}
                onCompleted={onHistoryCompleted}
              />
            </>
          ) : null}
        </MembershipPeriodSection>
      ))}
      <ConfirmationDialog
        open={Boolean(pendingPeriod)}
        title="删除会员记录？"
        description={
          pendingPeriod
            ? `将删除 ${pendingPeriod.service} ${pendingPeriod.startDate || "未知日期"} 至 ${pendingPeriod.endDate} 的记录，此操作保存后无法撤销。`
            : ""
        }
        onCancel={() => setPendingPeriod(null)}
        onConfirm={confirmPeriodRemoval}
      />
      <footer>
        <span role="status" aria-live="polite">
          {settingsStatus}
        </span>
        <button className="primary-button" type="submit">
          保存会员记录
        </button>
      </footer>
    </form>
  );
}

function MembershipPeriodSection({
  service,
  periods,
  today,
  onAdd,
  onChange,
  onRemove,
  children,
}: {
  service: MembershipService;
  periods: MembershipPeriod[];
  today: string;
  onAdd: () => void;
  onChange: <Key extends keyof MembershipPeriod>(
    id: string,
    key: Key,
    value: MembershipPeriod[Key],
  ) => void;
  onRemove: (id: string) => void;
  children?: ReactNode;
}) {
  return (
    <section className="settings-section membership-section">
      <div className="membership-section-heading">
        <h3>{service}</h3>
        <button className="secondary-button" type="button" onClick={onAdd}>
          新增会员记录
        </button>
      </div>
      <div className="membership-periods">
        {periods.length ? (
          periods.map((period) => {
            const status =
              period.endDate < today ? "已过期" : period.startDate > today ? "未开始" : "生效中";
            return (
              <article className="membership-period" key={period.id}>
                <div className="membership-period-title">
                  <strong>
                    {period.startDate || "开始时间未知"} — {period.endDate}
                  </strong>
                  <span data-status={status}>{status}</span>
                </div>
                <div className="membership-period-fields">
                  <label className="field">
                    <span>开始日期</span>
                    <input
                      type="date"
                      value={period.startDate}
                      max={period.endDate || undefined}
                      onChange={(event) => onChange(period.id, "startDate", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>结束日期</span>
                    <input
                      type="date"
                      required
                      min={period.startDate || undefined}
                      value={period.endDate}
                      onChange={(event) => onChange(period.id, "endDate", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>购买价格</span>
                    <MembershipPriceInput
                      price={period.price}
                      onChange={(price) => onChange(period.id, "price", price)}
                    />
                  </label>
                  <label className="field">
                    <span>币种</span>
                    <select
                      value={period.currency}
                      onChange={(event) =>
                        onChange(period.id, "currency", event.target.value as Currency)
                      }
                    >
                      {currencies.map((currency) => (
                        <option key={currency}>{currency}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <button className="danger-button" type="button" onClick={() => onRemove(period.id)}>
                  删除这条记录
                </button>
              </article>
            );
          })
        ) : (
          <p className="membership-empty">暂无会员记录</p>
        )}
        {children ? <div className="membership-period-actions">{children}</div> : null}
      </div>
    </section>
  );
}

function MembershipPriceInput({
  price,
  onChange,
}: {
  price: number;
  onChange: (price: number) => void;
}) {
  const [draft, setDraft] = useState(String(price));

  function updatePrice(value: string) {
    setDraft(value);
    if (value === "") return;
    const nextPrice = Number(value);
    if (Number.isFinite(nextPrice)) onChange(nextPrice);
  }

  function finishEditing() {
    if (draft !== "") return;
    setDraft("0");
    onChange(0);
  }

  return (
    <input
      type="number"
      min="0"
      max="100000000"
      step="0.01"
      value={draft}
      onChange={(event) => updatePrice(event.target.value)}
      onBlur={finishEditing}
    />
  );
}
