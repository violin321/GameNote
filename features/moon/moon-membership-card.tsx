import Link from "next/link";
import { DatabaseSync } from "node:sqlite";
import { playDatabaseFilePath } from "@/lib/play-history/database-config";

type MoonMembershipStatus = {
  connected: boolean;
  reportCount: number;
  latestDate: string | null;
};

export function readMoonMembershipStatus(): MoonMembershipStatus {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(playDatabaseFilePath(), { readOnly: true });
    const hasLegacyReports = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='moon_daily_reports' LIMIT 1",
        )
        .get(),
    );
    const hasAutoReports = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='moon_auto_daily' LIMIT 1",
        )
        .get(),
    );

    const sources = [
      hasLegacyReports ? "SELECT official_date FROM moon_daily_reports" : "",
      hasAutoReports ? "SELECT official_date FROM moon_auto_daily" : "",
    ].filter(Boolean);
    const row = sources.length
      ? (db
          .prepare(
            `SELECT COUNT(*) AS count, MAX(official_date) AS latest FROM (${sources.join(" UNION ")})`,
          )
          .get() as { count?: number; latest?: string | null } | undefined)
      : undefined;

    return {
      connected: hasLegacyReports || hasAutoReports,
      reportCount: Number(row?.count || 0),
      latestDate: row?.latest || null,
    };
  } catch {
    return { connected: false, reportCount: 0, latestDate: null };
  } finally {
    db?.close();
  }
}

export function MoonMembershipCard() {
  const status = readMoonMembershipStatus();
  const ready = status.reportCount > 0;

  return (
    <section className="moon-membership-card" aria-labelledby="moon-membership-title">
      <span className="moon-membership-card__mark" aria-hidden="true">
        MN
      </span>
      <div className="moon-membership-card__content">
        <div className="moon-membership-card__heading">
          <div>
            <h2 id="moon-membership-title">Moon 每日游玩报告</h2>
            <span>Nintendo 家长控制</span>
          </div>
          <span className={`moon-membership-card__status ${ready ? "is-ready" : "is-pending"}`}>
            {ready ? "已有数据" : "尚未同步"}
          </span>
        </div>
        <p>
          {ready
            ? `已保存 ${status.reportCount} 份日报${status.latestDate ? `，最近日期 ${status.latestDate}` : ""}。`
            : status.connected
              ? "Moon 数据结构已准备，但目前还没有成功导入的日报。"
              : "Moon 尚未完成生产数据接入；会员订阅记录不会受影响。"}
        </p>
        <div className="moon-membership-card__actions">
          <Link className="moon-membership-card__link" href="/play/history">
            查看游玩历史
          </Link>
          <span>按日聚合，不等同于精确游玩会话</span>
        </div>
      </div>
    </section>
  );
}
