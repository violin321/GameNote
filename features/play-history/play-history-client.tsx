"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GameRecord } from "@/features/ledger/types";
import { Stat } from "@/features/ledger/components/app-toolbar";
import type { PlayGameSummary, RecentPlaySession } from "@/lib/play-history/types";
import { PlayImportPanel } from "./play-import-panel";
import { PurchaseLinkEditor } from "./purchase-link-editor";

type Mode = "recent" | "history" | "unlinked";
type SortKey = "recent" | "total" | "days" | "first" | "title";

export function PlayHistoryClient({ mode, purchases }: { mode: Mode; purchases: GameRecord[] }) {
  const [games, setGames] = useState<PlayGameSummary[]>([]);
  const [sessions, setSessions] = useState<RecentPlaySession[]>([]);
  const [days, setDays] = useState<7 | 30 | 90>(7);
  const [sort, setSort] = useState<SortKey>(mode === "history" ? "total" : "recent");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const endpoint =
        mode === "recent"
          ? `/api/play-recent?days=${days}`
          : mode === "unlinked"
            ? `/api/play-unlinked?q=${encodeURIComponent(query)}`
            : `/api/play-history?sort=${sort}&direction=${sort === "title" ? "asc" : "desc"}&q=${encodeURIComponent(query)}`;
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        games?: PlayGameSummary[];
        sessions?: RecentPlaySession[];
      };
      if (!response.ok) throw new Error(payload.error || "无法读取游玩记录");
      setGames(Array.isArray(payload.games) ? payload.games : []);
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
    } catch (failure) {
      setGames([]);
      setSessions([]);
      setError(failure instanceof Error ? failure.message : "无法读取游玩记录");
    } finally {
      setLoading(false);
    }
  }, [days, mode, query, sort]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), query ? 180 : 0);
    return () => window.clearTimeout(timeout);
  }, [load, query]);

  const gameStats = useMemo(
    () => ({
      seconds: games.reduce((sum, game) => sum + game.totalSeconds, 0),
      days: games.reduce((sum, game) => sum + game.playDays, 0),
    }),
    [games],
  );
  const recentStats = useMemo(
    () => ({
      seconds: sessions.reduce((sum, session) => sum + session.durationSeconds, 0),
      games: new Set(sessions.map((session) => session.gameId)).size,
    }),
    [sessions],
  );
  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions]);

  return (
    <section className="play-workspace" aria-busy={loading}>
      <div className="play-stats" aria-label="游玩统计">
        {mode === "recent" ? (
          <>
            <Stat label={`最近 ${days} 天`} value={`${sessions.length} 条记录`} />
            <Stat label="涉及游戏" value={`${recentStats.games} 款`} />
            <Stat label="游玩时长" value={formatDuration(recentStats.seconds)} />
          </>
        ) : (
          <>
            <Stat
              label={mode === "unlinked" ? "待关联" : "游戏数量"}
              value={`${games.length} 款`}
            />
            <Stat label="累计时长" value={formatDuration(gameStats.seconds)} />
            <Stat label="游玩天数" value={`${gameStats.days} 天`} />
          </>
        )}
      </div>

      <div className="filter-panel play-filters">
        {mode === "recent" ? (
          <label className="field">
            <span>时间范围</span>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value) as 7 | 30 | 90)}
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </label>
        ) : (
          <label className="field">
            <span>搜索</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="游戏标题"
            />
          </label>
        )}
        {mode === "history" ? (
          <label className="field">
            <span>排序</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="total">累计时长</option>
              <option value="recent">最后游玩</option>
              <option value="days">游玩天数</option>
              <option value="first">首次游玩</option>
              <option value="title">游戏标题</option>
            </select>
          </label>
        ) : null}
        <button
          className="ghost-button play-refresh-button"
          type="button"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "正在刷新" : "刷新"}
        </button>
      </div>

      {mode === "history" ? <PlayImportPanel onImported={load} /> : null}

      {error ? (
        <div className="app-surface play-error-state" role="alert">
          <strong>游玩记录暂时无法显示</strong>
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {!error && loading && !games.length && !sessions.length ? (
        <div className="app-surface play-empty-state" role="status">
          正在读取游玩记录…
        </div>
      ) : null}

      {!error && mode === "recent" && !loading ? (
        groupedSessions.length ? (
          <div className="play-timeline">
            {groupedSessions.map(([date, entries]) => (
              <section
                className="app-surface play-timeline-day"
                key={date}
                aria-labelledby={`play-day-${date}`}
              >
                <div className="play-section-heading">
                  <div>
                    <h2 id={`play-day-${date}`}>{formatDay(date)}</h2>
                    <p>
                      {entries.length} 条记录 ·{" "}
                      {formatDuration(
                        entries.reduce((sum, entry) => sum + entry.durationSeconds, 0),
                      )}
                    </p>
                  </div>
                </div>
                <div className="play-session-list">
                  {entries.map((session) => (
                    <article className="play-session-row" key={session.id}>
                      <GameCover title={session.title} url={session.coverUrl || ""} />
                      <div>
                        <strong>{session.title}</strong>
                        <span>
                          {formatTime(session.startedAt)}–{formatTime(session.endedAt)}
                        </span>
                      </div>
                      <b>{formatDuration(session.durationSeconds)}</b>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            text={`最近 ${days} 天没有游玩记录。`}
            hint="可在历史游玩页面导入 JSON 数据。"
          />
        )
      ) : null}

      {!error && mode !== "recent" && !loading ? (
        games.length ? (
          <div className="play-game-list">
            {games.map((game) => (
              <article className="app-surface play-game-card" key={game.id}>
                <div className="play-game-heading">
                  <GameCover title={game.title} url={game.coverUrl || ""} />
                  <div>
                    <h2>{game.title}</h2>
                    <p>
                      {game.platform || "游戏平台"} · {game.sessionCount} 条记录
                    </p>
                  </div>
                </div>
                <dl className="play-game-metrics">
                  <div>
                    <dt>累计时长</dt>
                    <dd>{formatDuration(game.totalSeconds)}</dd>
                  </div>
                  <div>
                    <dt>游玩天数</dt>
                    <dd>{game.playDays} 天</dd>
                  </div>
                  <div>
                    <dt>首次游玩</dt>
                    <dd>{formatDate(game.firstPlayedAt)}</dd>
                  </div>
                  <div>
                    <dt>最后游玩</dt>
                    <dd>{formatDate(game.lastPlayedAt)}</dd>
                  </div>
                </dl>
                <PurchaseLinkEditor game={game} purchases={purchases} onSaved={load} />
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            text={mode === "unlinked" ? "没有待关联的游玩游戏。" : "还没有游玩历史。"}
            hint={
              mode === "unlinked"
                ? "已关联的游戏会保留在历史游玩中。"
                : "选择 JSON 文件预览并导入第一批记录。"
            }
          />
        )
      ) : null}
    </section>
  );
}

function EmptyState({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="app-surface play-empty-state">
      <strong>{text}</strong>
      <p>{hint}</p>
    </div>
  );
}

function GameCover({ title, url }: { title: string; url: string }) {
  return url ? (
    <img className="play-game-cover" src={url} alt="" />
  ) : (
    <span className="play-game-cover-fallback">{title.slice(0, 1)}</span>
  );
}

function groupSessions(sessions: RecentPlaySession[]) {
  const grouped = new Map<string, RecentPlaySession[]>();
  for (const session of sessions) {
    const date = session.playedDate || localDate(session.startedAt);
    grouped.set(date, [...(grouped.get(date) || []), session]);
  }
  return [...grouped.entries()].sort(([left], [right]) => right.localeCompare(left));
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours && minutes) return `${hours} 小时 ${minutes} 分`;
  if (hours) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

function formatDate(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date(`${value}T12:00:00`));
}

function localDate(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
