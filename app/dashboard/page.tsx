"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { DashboardStats } from "@/lib/play-history/types";

type DashboardVisibility = {
  showNintendoSwitch: boolean;
  showPlayStation: boolean;
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [visibility, setVisibility] = useState<DashboardVisibility>({
    showNintendoSwitch: true,
    showPlayStation: true,
  });
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      const [statsResponse, settingsResponse] = await Promise.all([
        fetch("/api/dashboard-stats", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const [statsPayload, settingsPayload] = await Promise.all([
        statsResponse.json(),
        settingsResponse.json(),
      ]);
      if (!statsResponse.ok) throw new Error(statsPayload.error || "概览读取失败");
      if (!settingsResponse.ok) throw new Error(settingsPayload.error || "显示设置读取失败");
      if (cancelled) return;
      setVisibility({
        showNintendoSwitch: settingsPayload.showNintendoSwitch !== false,
        showPlayStation: settingsPayload.showPlayStation !== false,
      });
      setStats(statsPayload);
    }
    void loadDashboard().catch((failure) => {
      if (!cancelled) setError(failure instanceof Error ? failure.message : "概览读取失败");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="alert alert-warning">{error}</p>;
  if (!stats) return <p className="dashboard-loading">正在加载概览</p>;

  const pendingCollections = stats.play
    ? Math.max(0, stats.play.games - stats.purchases.linked)
    : 0;
  const visiblePurchaseTotal =
    (visibility.showNintendoSwitch ? stats.purchases.nintendo : 0) +
    (visibility.showPlayStation ? stats.purchases.playStation : 0);
  const primaryLibraryHref = visibility.showNintendoSwitch ? "/" : "/playstation";
  const primaryLibraryLabel = visibility.showNintendoSwitch ? "进入 NS 游戏" : "进入 PS 游戏";

  return (
    <section className="dashboard-overview">
      <article className="dashboard-panel">
        <header>
          <div>
            <h2>我的游戏库</h2>
            <p>购买、版本、介质和流转状态</p>
          </div>
          <Link href={primaryLibraryHref}>{primaryLibraryLabel}</Link>
        </header>
        <div className="dashboard-primary-value">
          <strong>{visiblePurchaseTotal}</strong>
          <span>款已整理收藏</span>
        </div>
        <dl className="dashboard-facts">
          {visibility.showNintendoSwitch ? (
            <DashboardFact label="Nintendo Switch" value={`${stats.purchases.nintendo} 款`} />
          ) : null}
          {visibility.showPlayStation ? (
            <DashboardFact label="PlayStation" value={`${stats.purchases.playStation} 款`} />
          ) : null}
          <DashboardFact label="已关联历史" value={`${stats.purchases.linked} 款`} />
        </dl>
      </article>

      {stats.play ? (
        <article className="dashboard-panel">
          <header>
            <div>
              <h2>NS 游玩档案</h2>
              <p>Store 累计、Moon 日报与手动会话</p>
            </div>
            <Link href="/play/history">查看历史游玩</Link>
          </header>
          <div className="dashboard-primary-value">
            <strong>{stats.play.games}</strong>
            <span>款有游玩记录</span>
          </div>
          <dl className="dashboard-facts">
            <DashboardFact label="已记录时长" value={formatDuration(stats.play.totalSeconds)} />
            <DashboardFact label="可定位会话" value={`${stats.play.sessions} 段`} />
            <DashboardFact
              label="最近记录"
              value={stats.play.lastPlayedAt ? formatDate(stats.play.lastPlayedAt) : "暂无"}
            />
          </dl>
        </article>
      ) : (
        <article className="dashboard-panel dashboard-locked">
          <h2>NS 游玩档案</h2>
          <p>登录管理员账号后查看同步历史、每日记录和累计时长。</p>
        </article>
      )}

      {stats.play && pendingCollections > 0 ? (
        <section className="dashboard-next-step">
          <div>
            <strong>{pendingCollections} 款历史游戏还未补收藏资料</strong>
            <p>游戏档案已经同步，无需重新输入名称；确认版本、介质和购买信息即可。</p>
          </div>
          <Link className="primary-button" href="/">
            继续整理 NS 游戏
          </Link>
        </section>
      ) : null}
    </section>
  );
}

function DashboardFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}
