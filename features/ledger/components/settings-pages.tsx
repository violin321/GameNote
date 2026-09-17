import type { ChangeEvent, Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import type { SettingsState } from "../types";
import { ModelCombobox } from "./model-combobox";
import { NintendoConnectorPanel } from "./nintendo-connector-panel";
import { MoonConnectorPanel } from "@/features/moon/moon-connector-panel";
import { PlayImportPanel } from "@/features/play-history/play-import-panel";
import { NintendoStorePanel } from "./nintendo-store-panel";

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
                  showPsPlusCatalog: event.target.checked ? current.showPsPlusCatalog : false,
                }))
              }
            />
            <span>展示 PlayStation 游戏库</span>
          </label>
          <strong className="settings-wide">工具</strong>
          {settings.showPlayStation ? (
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
          ) : null}
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
          <h3>收藏 JSON 导出</h3>
          <p>
            仅包含购买记录，不含历史游玩、日报、Store 快照及授权。完整 NS2
            库请由管理员在服务器上按备份手册操作。
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
      <section className="settings-section" id="moon-connector">
        <div>
          <h3>家长控制 · 游玩记录</h3>
          <p>使用 Moon 日报同步每天玩过的游戏与时长。</p>
        </div>
        <MoonConnectorPanel />
      </section>
      <section className="settings-section" id="nintendo-store">
        <div>
          <h3>Nintendo Store</h3>
          <p>同步 Nintendo Store 提供的游戏累计游玩时长。</p>
        </div>
        <NintendoStorePanel />
      </section>
      <section className="settings-section">
        <div>
          <h3>其他 Nintendo 数据源</h3>
          <p>可选的 NSO 累计快照，家长控制同步无需连接此项。</p>
        </div>
        <details className="settings-wide">
          <summary>管理 NSO 连接器（可选）</summary>
          <NintendoConnectorPanel />
        </details>
      </section>
      <section className="settings-section">
        <div>
          <h3>手动导入游玩数据</h3>
          <p>也可在这里预览并导入 session JSON；导入不会覆盖购买账本。</p>
        </div>
        <PlayImportPanel />
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
};

export function MembershipPage({
  settings,
  setSettings,
  settingsStatus,
  psPlusStatus,
  onSubmit,
  onSyncPsPlus,
}: MembershipPageProps) {
  return (
    <form className="settings-page membership-page" onSubmit={onSubmit}>
      <section className="settings-section membership-section">
        <div>
          <h3>Nintendo Switch Online</h3>
          <p>仅记录会员状态和到期时间，不触发任何自动功能。</p>
        </div>
        <div className="settings-fields">
          <label className="checkbox-field settings-wide">
            <input
              type="checkbox"
              checked={settings.nsOnlineEnabled}
              onChange={(event) =>
                setSettings((current) => ({ ...current, nsOnlineEnabled: event.target.checked }))
              }
            />
            <span>已开通 Nintendo Switch Online</span>
          </label>
          <label className="field">
            <span>会员到期时间</span>
            <input
              type="date"
              disabled={!settings.nsOnlineEnabled}
              value={settings.nsOnlineExpiresAt}
              onChange={(event) =>
                setSettings((current) => ({ ...current, nsOnlineExpiresAt: event.target.value }))
              }
            />
          </label>
        </div>
      </section>
      {settings.showPlayStation ? (
        <section className="settings-section membership-section">
          <div>
            <h3>PlayStation Plus</h3>
            <p>记录会员有效期，并控制每月会免是否自动加入游戏记录。</p>
          </div>
          <div className="settings-fields">
            <label className="checkbox-field settings-wide">
              <input
                type="checkbox"
                checked={settings.psPlusEnabled}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, psPlusEnabled: event.target.checked }))
                }
              />
              <span>已开通 PlayStation Plus</span>
            </label>
            <label className="field">
              <span>会员到期时间</span>
              <input
                type="date"
                disabled={!settings.psPlusEnabled}
                value={settings.psPlusExpiresAt}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, psPlusExpiresAt: event.target.value }))
                }
              />
            </label>
            <label className="checkbox-field settings-wide">
              <input
                type="checkbox"
                disabled={!settings.psPlusEnabled}
                checked={settings.psPlusAutoAddMonthly}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    psPlusAutoAddMonthly: event.target.checked,
                  }))
                }
              />
              <span>自动识别并加入每月会免游戏</span>
            </label>
            <button
              className="ghost-button"
              type="button"
              disabled={!settings.psPlusEnabled || !settings.psPlusAutoAddMonthly}
              onClick={onSyncPsPlus}
            >
              立即检查本月会免
            </button>
            {psPlusStatus ? (
              <p className="settings-wide settings-message" role="status" aria-live="polite">
                {psPlusStatus}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
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
