"use client";

import Link from "next/link";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { currencies, regions } from "@/features/ledger/constants";
import type { Currency, GameFormat, GamePlatform, Region } from "@/features/ledger/types";
import { currencyLabel, formatOptionsForPlatform, isPhysicalFormat } from "@/features/ledger/utils";
import { AppleSelect } from "@/features/ui/apple-select";
import { isPlayStationPlatform } from "@/lib/game/platform";
import type { PlayGameDetail, PlayGameSummary, RecentPlayActivity } from "@/lib/play-history/types";

type Mode = "recent" | "history" | "unlinked";
type SortKey = "recent" | "total" | "days" | "first" | "title";
type PurchaseCandidate = {
  id: string;
  title: string;
  platform: string;
  format: string;
  purchaseDate: string;
  region: string;
  seller: string;
  coverUrl: string;
  soldDate: string;
  soldPrice: number;
  soldCurrency: string;
};

const viewLinks: Array<{ mode: Mode; href: string; label: string }> = [
  { mode: "history", href: "/play/history", label: "全部游戏" },
  { mode: "recent", href: "/play/history?view=recent", label: "最近动态" },
  { mode: "unlinked", href: "/play/history?view=unlinked", label: "待补收藏" },
];

export function PlayHistoryClient({ mode }: { mode: Mode }) {
  const [games, setGames] = useState<PlayGameSummary[]>([]);
  const [activities, setActivities] = useState<RecentPlayActivity[]>([]);
  const [days, setDays] = useState<7 | 30 | 90>(7);
  const [sort, setSort] = useState<SortKey>("recent");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<PlayGameDetail | null>(null);
  const [collectionTargetId, setCollectionTargetId] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const [purchases, setPurchases] = useState<PurchaseCandidate[]>([]);
  const [showPlayStation, setShowPlayStation] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTarget, setManualTarget] = useState<PlayGameDetail | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError("");
      const endpoint =
        mode === "recent"
          ? `/api/play-recent?days=${days}`
          : mode === "unlinked"
            ? `/api/play-unlinked?q=${encodeURIComponent(deferredQuery)}`
            : `/api/play-history?sort=${sort}&direction=desc&q=${encodeURIComponent(deferredQuery)}`;
      const response = await fetch(endpoint, { cache: "no-store", signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "无法读取游玩记录");
      setGames(payload.games || []);
      setActivities(payload.activities || []);
    },
    [days, deferredQuery, mode, sort],
  );

  const loadPurchases = useCallback(async (signal?: AbortSignal) => {
    const [recordsResponse, settingsResponse] = await Promise.all([
      fetch("/api/records", { cache: "no-store", signal }),
      fetch("/api/settings", { cache: "no-store", signal }),
    ]);
    const [recordsPayload, settingsPayload] = await Promise.all([
      recordsResponse.json().catch(() => ({})),
      settingsResponse.json().catch(() => ({})),
    ]);
    if (!recordsResponse.ok) throw new Error(recordsPayload.error || "无法读取收藏记录");
    if (!settingsResponse.ok) throw new Error(settingsPayload.error || "无法读取显示设置");
    setShowPlayStation(settingsPayload.showPlayStation !== false);
    setPurchases(recordsPayload.records || []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    load(controller.signal)
      .catch((failure) => {
        if (failure instanceof DOMException && failure.name === "AbortError") return;
        setError(failure instanceof Error ? failure.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    loadPurchases(controller.signal).catch((failure) => {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "无法读取收藏记录");
    });
    return () => controller.abort();
  }, [loadPurchases]);

  const groupedSessions = useMemo(() => {
    const groups = new Map<string, RecentPlayActivity[]>();
    for (const activity of activities) {
      const key =
        activity.timeSemantics === "daily_aggregate"
          ? activity.date || activity.occurredAt
          : localDate(activity.occurredAt);
      groups.set(key, [...(groups.get(key) || []), activity]);
    }
    return Array.from(groups.entries());
  }, [activities]);

  const visiblePurchases = useMemo(
    () =>
      showPlayStation
        ? purchases
        : purchases.filter((purchase) => !isPlayStationPlatform(purchase.platform)),
    [purchases, showPlayStation],
  );
  const purchaseById = useMemo(
    () => new Map(visiblePurchases.map((purchase) => [purchase.id, purchase])),
    [visiblePurchases],
  );
  const selectedPurchase = detail?.link?.purchaseRecordId
    ? purchaseById.get(detail.link.purchaseRecordId) || null
    : null;

  async function openDetail(id: string, createCollection = false) {
    const request = ++detailRequest.current;
    setManualOpen(false);
    setError("");
    try {
      const response = await fetch(`/api/play-history/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (request !== detailRequest.current) return;
      if (!response.ok) return setError(payload.error || "详情读取失败");
      setDetail(payload.game);
      setCollectionTargetId(createCollection ? payload.game.id : null);
    } catch {
      if (request === detailRequest.current) setError("详情读取失败，请重试");
    }
  }

  function openManual(target: PlayGameDetail | null = null) {
    detailRequest.current++;
    setManualTarget(target);
    setManualOpen(true);
  }

  async function decide(
    game: PlayGameSummary,
    action: "confirm" | "reject",
    purchaseRecordId: string | null = game.link?.purchaseRecordId || null,
  ) {
    const response = await fetch("/api/play-links/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playGameId: game.id, purchaseRecordId, action }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload.error || "关联操作失败");
      throw new Error("关联操作失败");
    }
    await Promise.all([load(), loadPurchases()]);
    if (detail?.id === game.id) await openDetail(game.id);
  }

  async function manualSaved(gameId: string) {
    setManualOpen(false);
    setManualTarget(null);
    await Promise.all([load(), loadPurchases()]);
    await openDetail(gameId);
  }

  async function collectionSaved(gameId: string) {
    setError("");
    setCollectionTargetId(null);
    await Promise.all([load(), loadPurchases()]);
    await openDetail(gameId);
  }

  return (
    <section className="play-page integrated-play-page" aria-busy={loading}>
      <div className="play-history-toolbar">
        <nav className="play-view-tabs" aria-label="历史游玩视图">
          {viewLinks.map((item) => (
            <Link
              className={item.mode === mode ? "active" : ""}
              aria-current={item.mode === mode ? "page" : undefined}
              href={item.href}
              key={item.mode}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="play-history-actions">
          <Link className="ghost-button" href="/settings#moon-connector">
            同步历史
          </Link>
          <button className="primary-button" type="button" onClick={() => openManual()}>
            手动补录
          </button>
        </div>
      </div>

      <div className="play-source-note">
        <p>
          {mode === "recent"
            ? "最近动态只展示可定位到日期的日报和会话；累计快照不会伪装成当天游玩。"
            : mode === "unlinked"
              ? "从历史直接补收藏资料会自动关联；无需先去游戏库重复录入标题和平台。"
              : "历史是游戏档案的基底；Store 累计、Moon 日报和手动会话按各自口径保存。"}
        </p>
        <span>
          {mode === "recent"
            ? `${activities.length} 条动态`
            : `${games.length} 款游戏${mode === "unlinked" ? "待处理" : ""}`}
        </span>
      </div>

      <div className="play-history-workspace">
        <div className="play-history-main">
          {mode === "recent" ? (
            <RecentTimeline
              activities={activities}
              days={days}
              groupedSessions={groupedSessions}
              loading={loading}
              onDaysChange={setDays}
              onOpenDetail={openDetail}
            />
          ) : (
            <HistoryGameList
              games={games}
              loading={loading}
              mode={mode}
              purchaseById={purchaseById}
              purchases={visiblePurchases}
              query={query}
              sort={sort}
              onConfirm={(game, purchaseRecordId) => decide(game, "confirm", purchaseRecordId)}
              onOpenDetail={openDetail}
              onCreateCollection={(id) => openDetail(id, true)}
              onQueryChange={setQuery}
              onReject={(game) => decide(game, "reject", null)}
              onSortChange={setSort}
            />
          )}
          {error ? <p className="play-error">{error}</p> : null}
        </div>

        <aside
          className={`play-history-context ${manualOpen || detail ? "is-active" : "is-empty"}`}
          aria-label="当前游戏详情"
        >
          {manualOpen ? (
            <ManualPlayForm
              key={manualTarget?.id || "new"}
              target={manualTarget}
              purchases={visiblePurchases}
              showPlayStation={showPlayStation}
              onCancel={() => setManualOpen(false)}
              onSaved={manualSaved}
            />
          ) : detail ? (
            <DetailPanel
              key={`${detail.id}:${collectionTargetId === detail.id ? "create" : "read"}`}
              detail={detail}
              initialCreatingCollection={collectionTargetId === detail.id}
              purchase={selectedPurchase}
              purchases={visiblePurchases}
              onAddManual={() => openManual(detail)}
              onClose={() => {
                detailRequest.current++;
                setCollectionTargetId(null);
                setDetail(null);
              }}
              onCollectionSaved={() => collectionSaved(detail.id)}
              onConfirm={(purchaseRecordId) => decide(detail, "confirm", purchaseRecordId)}
            />
          ) : (
            <section className="play-context-empty">
              <h2>游玩档案</h2>
              <p>选择一款历史游戏，可同时查看累计、每日记录、会话和收藏状态。</p>
              <p>若尚未收藏，可直接用历史资料补充购买信息并自动关联。</p>
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}

function RecentTimeline({
  activities,
  days,
  groupedSessions,
  loading,
  onDaysChange,
  onOpenDetail,
}: {
  activities: RecentPlayActivity[];
  days: 7 | 30 | 90;
  groupedSessions: Array<[string, RecentPlayActivity[]]>;
  loading: boolean;
  onDaysChange: (days: 7 | 30 | 90) => void;
  onOpenDetail: (id: string) => Promise<void>;
}) {
  return (
    <>
      <div className="play-window-tabs" role="group" aria-label="时间窗口">
        {([7, 30, 90] as const).map((window) => (
          <button
            className={days === window ? "active" : ""}
            key={window}
            type="button"
            onClick={() => onDaysChange(window)}
            aria-pressed={days === window}
          >
            {window} 天
          </button>
        ))}
      </div>
      <section className="play-timeline">
        {groupedSessions.map(([date, items]) => {
          const mixed = new Set(items.map((item) => item.timeSemantics)).size > 1;
          return (
            <section className="play-day" key={date}>
              <header>
                <h2>{formatDay(date)}</h2>
                <span>
                  {mixed
                    ? `${items.length} 项不同口径记录`
                    : formatDuration(items.reduce((sum, item) => sum + item.seconds, 0))}
                </span>
              </header>
              <div>
                {items.map((activity) => (
                  <button
                    className="session-row"
                    type="button"
                    key={activity.id}
                    onClick={() => onOpenDetail(activity.gameId)}
                  >
                    <GameCover title={activity.title} url={activity.coverUrl} />
                    <span>
                      <strong>{activity.title}</strong>
                      <small>
                        {activity.timeSemantics === "daily_aggregate"
                          ? `家长控制 · 当日汇总${activity.reportStatus === "CALCULATING" ? " · 更新中" : ""}`
                          : `${activity.source === "manual" ? "手动记录 · " : "会话 · "}${formatTime(activity.occurredAt)} — ${formatTime(activity.endedAt || activity.occurredAt)}`}
                      </small>
                    </span>
                    <b>{formatDuration(activity.seconds)}</b>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!activities.length ? (
          <Empty
            text={loading ? "正在读取游玩记录…" : `最近 ${days} 天暂无可定位日期的游玩记录`}
            action={!loading ? "检查家长控制同步" : undefined}
            href="/settings#moon-connector"
          />
        ) : null}
      </section>
    </>
  );
}

function HistoryGameList({
  games,
  loading,
  mode,
  purchaseById,
  purchases,
  query,
  sort,
  onConfirm,
  onCreateCollection,
  onOpenDetail,
  onQueryChange,
  onReject,
  onSortChange,
}: {
  games: PlayGameSummary[];
  loading: boolean;
  mode: Exclude<Mode, "recent">;
  purchaseById: Map<string, PurchaseCandidate>;
  purchases: PurchaseCandidate[];
  query: string;
  sort: SortKey;
  onConfirm: (game: PlayGameSummary, purchaseRecordId: string) => Promise<void>;
  onCreateCollection: (id: string) => Promise<void>;
  onOpenDetail: (id: string) => Promise<void>;
  onQueryChange: (value: string) => void;
  onReject: (game: PlayGameSummary) => Promise<void>;
  onSortChange: (sort: SortKey) => void;
}) {
  return (
    <>
      <section className="play-controls integrated-controls">
        <label>
          搜索
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="游戏标题或 Title ID"
          />
        </label>
        {mode === "history" ? (
          <label>
            排序
            <AppleSelect
              ariaLabel="历史游玩排序"
              value={sort}
              options={[
                { value: "recent", label: "最近游玩" },
                { value: "total", label: "已记录时长" },
                { value: "days", label: "游玩天数" },
                { value: "first", label: "首次记录" },
                { value: "title", label: "标题" },
              ]}
              onChange={onSortChange}
            />
          </label>
        ) : null}
      </section>
      <section className="play-list">
        {games.map((game) => {
          const purchase = game.link?.purchaseRecordId
            ? purchaseById.get(game.link.purchaseRecordId) || null
            : null;
          return (
            <article className="play-card play-library-row" key={game.id}>
              <button
                className="play-card-main"
                type="button"
                onClick={() => onOpenDetail(game.id)}
                aria-label={`查看 ${game.title} 游玩档案`}
              >
                <div className="play-card-heading">
                  <GameCover title={game.title} url={purchase?.coverUrl || game.coverUrl} />
                  <div>
                    <h2>{game.title}</h2>
                    <p>{sourceLabel(game)}</p>
                  </div>
                </div>
                <dl>
                  <Metric label={durationLabel(game)} value={formatDuration(game.totalSeconds)} />
                  <Metric
                    label="游玩天数"
                    value={
                      game.timeSemantics === "snapshot_observation" &&
                      game.source !== "nintendo_store"
                        ? "未提供"
                        : `${game.playDays} 天`
                    }
                  />
                  <Metric label={lastDateLabel(game)} value={formatDate(game.lastPlayedAt)} />
                </dl>
              </button>
              <footer className="play-card-footer-link">
                <span>{timeSemanticsDescription(game)}</span>
                {purchase ? <PurchaseSummary purchase={purchase} compact /> : null}
                {mode === "unlinked" ? (
                  purchases.length ? (
                    <div className="play-history-link">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => onCreateCollection(game.id)}
                      >
                        补充收藏资料
                      </button>
                      <PurchaseLinkEditor
                        game={game}
                        purchases={purchases}
                        onConfirm={(purchaseRecordId) => onConfirm(game, purchaseRecordId)}
                        onReject={() => onReject(game)}
                      />
                    </div>
                  ) : (
                    <HistoryLinkControl
                      game={game}
                      purchases={purchases}
                      onCreate={() => onCreateCollection(game.id)}
                      onConfirm={(purchaseRecordId) => onConfirm(game, purchaseRecordId)}
                    />
                  )
                ) : (
                  <HistoryLinkControl
                    game={game}
                    purchases={purchases}
                    onCreate={() => onCreateCollection(game.id)}
                    onConfirm={(purchaseRecordId) => onConfirm(game, purchaseRecordId)}
                  />
                )}
              </footer>
            </article>
          );
        })}
        {!games.length ? (
          <Empty
            text={
              loading
                ? "正在读取游玩记录…"
                : query.trim()
                  ? "没有匹配的游戏，请尝试其他关键词"
                  : mode === "unlinked"
                    ? "暂无待补收藏项，现有历史都已处理"
                    : "还没有历史记录，先同步 Nintendo 数据；同步不到时再手动补录"
            }
            action={mode === "unlinked" ? "查看全部历史" : "同步 Nintendo 历史"}
            href={mode === "unlinked" ? "/play/history" : "/settings#moon-connector"}
          />
        ) : null}
      </section>
    </>
  );
}

function DetailPanel({
  detail,
  initialCreatingCollection,
  purchase,
  purchases,
  onAddManual,
  onClose,
  onCollectionSaved,
  onConfirm,
}: {
  detail: PlayGameDetail;
  initialCreatingCollection: boolean;
  purchase: PurchaseCandidate | null;
  purchases: PurchaseCandidate[];
  onAddManual: () => void;
  onClose: () => void;
  onCollectionSaved: () => Promise<void>;
  onConfirm: (purchaseRecordId: string) => Promise<void>;
}) {
  const [creatingCollection, setCreatingCollection] = useState(initialCreatingCollection);

  return (
    <section className="play-detail-panel">
      <header>
        <div>
          <h2>{detail.title}</h2>
          <p>{sourceLabel(detail)}</p>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="play-detail-stats">
        <Metric label={durationLabel(detail)} value={formatDuration(detail.totalSeconds)} />
        <Metric label={lastDateLabel(detail)} value={formatDate(detail.lastPlayedAt)} />
        <Metric label="会话" value={`${detail.sessionCount} 段`} />
      </div>

      <p className="play-detail-explanation">{timeSemanticsDescription(detail)}</p>
      <button className="primary-button play-detail-primary" type="button" onClick={onAddManual}>
        添加本次游玩
      </button>

      <section className="play-detail-section">
        <div className="play-detail-section-heading">
          <h3>收藏账本</h3>
          {purchase ? <Link href="/">在游戏库管理</Link> : <span>从历史补资料</span>}
        </div>
        {purchase ? (
          <PurchaseSummary purchase={purchase} />
        ) : creatingCollection ? (
          <PlayCollectionForm
            game={detail}
            onCancel={() => setCreatingCollection(false)}
            onSaved={async () => {
              await onCollectionSaved();
              setCreatingCollection(false);
            }}
          />
        ) : (
          <HistoryLinkControl
            game={detail}
            purchases={purchases}
            onCreate={() => setCreatingCollection(true)}
            onConfirm={onConfirm}
          />
        )}
      </section>

      {detail.dailyReports.length ? (
        <section className="play-detail-section play-detail-daily">
          <div className="play-detail-section-heading">
            <h3>每日游玩</h3>
            <span>Moon 日报</span>
          </div>
          <p>仅统计已保存的日期；与 Store 累计值分开显示。</p>
          <ol>
            {detail.dailyReports.map((report) => (
              <li key={report.id}>
                <span>
                  {formatDate(report.date)}
                  {report.reportStatus === "CALCULATING" ? " · 更新中" : ""}
                </span>
                <strong>{formatDuration(report.seconds)}</strong>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {detail.sessions.length ? (
        <section className="play-detail-section">
          <div className="play-detail-section-heading">
            <h3>会话记录</h3>
            <span>{detail.sessions.length} 段</span>
          </div>
          <ol>
            {detail.sessions.map((session) => (
              <li key={session.id}>
                <span>
                  {formatDateTime(session.startedAt)}
                  <small>{sessionSourceLabel(session.source)}</small>
                </span>
                <strong>{formatDuration(session.durationSeconds)}</strong>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {!detail.dailyReports.length && !detail.sessions.length ? (
        <p className="play-detail-empty">暂无可定位日期的记录，可手动添加一次游玩。</p>
      ) : null}
    </section>
  );
}

function PlayCollectionForm({
  game,
  onCancel,
  onSaved,
}: {
  game: PlayGameDetail;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const platform: GamePlatform = game.platform.toLowerCase().includes("playstation")
    ? "PlayStation"
    : "Nintendo Switch";
  const [format, setFormat] = useState<GameFormat | "">("");
  const [region, setRegion] = useState<Region | "">("");
  const [seller, setSeller] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<Currency>("CNY");
  const [notes, setNotes] = useState("");
  const [sold, setSold] = useState(false);
  const [soldDate, setSoldDate] = useState("");
  const [soldPrice, setSoldPrice] = useState("");
  const [soldCurrency, setSoldCurrency] = useState<Currency>("CNY");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const physical = format ? isPhysicalFormat(format) : false;

  function updateFormat(value: GameFormat) {
    setFormat(value);
    if (!isPhysicalFormat(value)) {
      setSold(false);
      setSoldDate("");
      setSoldPrice("");
    }
  }

  function optionalMoney(value: string, field: string) {
    if (!value.trim()) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000)
      throw new Error(`${field}需为 0 至 1 亿元之间的数字`);
    return amount;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError("");
    if (!format || !region) {
      setError("请先选择版本和介质");
      return;
    }
    let parsedPrice: number | null;
    let parsedSoldPrice: number | null;
    try {
      parsedPrice = optionalMoney(price, "购买价格");
      parsedSoldPrice = sold ? optionalMoney(soldPrice, "卖出价格") : null;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "价格格式无效");
      return;
    }
    if (physical && sold && !soldDate) {
      setError("请填写卖出日期，或取消“已卖出”状态");
      return;
    }

    setSaving(true);
    let created = false;
    try {
      const response = await fetch(`/api/play-history/${encodeURIComponent(game.id)}/collection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          region,
          purchaseDate,
          seller: seller.trim(),
          price: parsedPrice,
          currency,
          notes: notes.trim(),
          soldDate: physical && sold ? soldDate : "",
          soldPrice: physical && sold ? parsedSoldPrice : null,
          soldCurrency: physical && sold ? soldCurrency : currency,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "收藏资料保存失败");
      created = true;
      await onSaved();
    } catch (failure) {
      setError(
        created
          ? "收藏资料已保存，但页面刷新失败。请刷新页面查看最新状态。"
          : failure instanceof Error
            ? failure.message
            : "收藏资料保存失败",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="play-collection-form" aria-busy={saving} onSubmit={submit}>
      <div className="play-collection-form__heading">
        <div>
          <strong>从历史添加到收藏</strong>
          <span>只需补充购买与持有信息</span>
        </div>
        <button className="ghost-button" type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
      </div>

      <div className="play-collection-origin">
        <GameCover title={game.title} url={game.coverUrl} />
        <span>
          <strong>{game.title}</strong>
          <small>{game.platform}</small>
          <small>标题、平台、封面和官方页面沿用历史档案</small>
        </span>
      </div>

      <fieldset disabled={saving}>
        <legend>收藏资料</legend>
        <div className="play-collection-grid">
          <label className="field">
            <span>介质</span>
            <AppleSelect<GameFormat | "">
              ariaLabel="介质"
              autoFocus
              required
              value={format}
              placeholder="请选择介质"
              options={formatOptionsForPlatform(platform).map((option) => ({
                value: option,
                label: option,
              }))}
              onChange={(nextFormat) => {
                if (nextFormat) updateFormat(nextFormat);
              }}
            />
          </label>
          <label className="field">
            <span>地区 / 版本</span>
            <AppleSelect<Region | "">
              ariaLabel="地区或版本"
              required
              value={region}
              placeholder="请选择版本"
              options={regions.map((option) => ({ value: option, label: option }))}
              onChange={(nextRegion) => {
                if (nextRegion) setRegion(nextRegion);
              }}
            />
          </label>
          <label className="field is-wide">
            <span>购买渠道（可选）</span>
            <input
              maxLength={120}
              value={seller}
              onChange={(event) => setSeller(event.target.value)}
              placeholder={physical ? "淘宝 / 闲鱼 / 线下店" : "Nintendo eShop / PlayStation Store"}
            />
          </label>
          <label className="field">
            <span>购买日期（可选）</span>
            <input
              type="date"
              value={purchaseDate}
              onChange={(event) => setPurchaseDate(event.target.value)}
            />
          </label>
          <label className="field">
            <span>购买价格（可选）</span>
            <input
              inputMode="decimal"
              max="100000000"
              min="0"
              step="0.01"
              type="number"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              placeholder="未填写"
            />
          </label>
          <label className="field is-wide">
            <span>币种</span>
            <AppleSelect
              ariaLabel="购买币种"
              value={currency}
              options={currencies.map((option) => ({
                value: option,
                label: currencyLabel(option),
              }))}
              onChange={setCurrency}
            />
          </label>
        </div>
      </fieldset>

      {physical ? (
        <fieldset className="play-collection-sale" disabled={saving}>
          <legend>实体状态</legend>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={sold}
              onChange={(event) => setSold(event.target.checked)}
            />
            <span>这份实体游戏已卖出</span>
          </label>
          {sold ? (
            <div className="play-collection-grid">
              <label className="field is-wide">
                <span>卖出日期</span>
                <input
                  required
                  type="date"
                  value={soldDate}
                  onChange={(event) => setSoldDate(event.target.value)}
                />
              </label>
              <label className="field">
                <span>卖出价格（可选）</span>
                <input
                  inputMode="decimal"
                  max="100000000"
                  min="0"
                  step="0.01"
                  type="number"
                  value={soldPrice}
                  onChange={(event) => setSoldPrice(event.target.value)}
                  placeholder="未填写"
                />
              </label>
              <label className="field">
                <span>卖出币种</span>
                <AppleSelect
                  ariaLabel="卖出币种"
                  value={soldCurrency}
                  options={currencies.map((option) => ({
                    value: option,
                    label: currencyLabel(option),
                  }))}
                  onChange={setSoldCurrency}
                />
              </label>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <label className="field">
        <span>备注（可选）</span>
        <textarea
          maxLength={2000}
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="例如首发购入、限定版内容或实体品相"
        />
      </label>

      {error ? (
        <p className="play-error" role="alert">
          {error}
        </p>
      ) : null}
      <footer>
        <span aria-live="polite">
          {saving ? "正在保存并刷新历史与收藏…" : "保存后会自动关联当前历史游戏"}
        </span>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "正在添加" : "添加到收藏"}
        </button>
      </footer>
    </form>
  );
}

function ManualPlayForm({
  target,
  purchases,
  showPlayStation,
  onCancel,
  onSaved,
}: {
  target: PlayGameDetail | null;
  purchases: PurchaseCandidate[];
  showPlayStation: boolean;
  onCancel: () => void;
  onSaved: (gameId: string) => Promise<void>;
}) {
  const [purchaseRecordId, setPurchaseRecordId] = useState("");
  const [title, setTitle] = useState("");
  const [platform, setPlatform] = useState("Nintendo Switch");
  const [startedAt, setStartedAt] = useState(() => toLocalDateTimeInput(new Date()));
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedPurchase = purchases.find((purchase) => purchase.id === purchaseRecordId) || null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const minutes = Number(durationMinutes);
    const parsedStartedAt = new Date(startedAt);
    if (!Number.isFinite(parsedStartedAt.getTime())) return setError("请填写有效的游玩时间");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440)
      return setError("游玩时长需为 1 分钟至 24 小时");
    if (!target && !selectedPurchase && !title.trim()) return setError("请填写游戏名称");
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/play-history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playGameId: target?.id || null,
          purchaseRecordId: target ? null : selectedPurchase?.id || null,
          title: target?.title || selectedPurchase?.title || title.trim(),
          platform: target?.platform || selectedPurchase?.platform || platform,
          startedAt: parsedStartedAt.toISOString(),
          durationSeconds: minutes * 60,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "手动记录保存失败");
      await onSaved(payload.gameId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "手动记录保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="manual-play-form" onSubmit={submit}>
      <header>
        <div>
          <h2>手动补录</h2>
          <p>{target ? `记录到 ${target.title}` : "只在同步历史中找不到游戏时使用。"}</p>
        </div>
        <button className="ghost-button" type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
      </header>

      {!target ? (
        <label className="field">
          <span>已有收藏（可选）</span>
          <AppleSelect
            ariaLabel="已有收藏"
            value={purchaseRecordId}
            options={[
              { value: "", label: "未收藏，手动填写游戏" },
              ...purchases
                .slice()
                .sort((left, right) => right.purchaseDate.localeCompare(left.purchaseDate))
                .map((purchase) => ({
                  value: purchase.id,
                  label: purchase.title,
                  description: `${purchase.format} · ${purchase.purchaseDate || "日期未填"}`,
                })),
            ]}
            onChange={setPurchaseRecordId}
          />
        </label>
      ) : null}

      {!target && !selectedPurchase ? (
        <>
          <label className="field">
            <span>游戏名称</span>
            <input
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如 集合啦！动物森友会"
            />
          </label>
          <label className="field">
            <span>平台</span>
            <AppleSelect
              ariaLabel="平台"
              value={platform}
              options={[
                { value: "Nintendo Switch", label: "Nintendo Switch" },
                { value: "Nintendo Switch 2", label: "Nintendo Switch 2" },
                ...(showPlayStation ? [{ value: "PlayStation", label: "PlayStation" }] : []),
              ]}
              onChange={setPlatform}
            />
          </label>
        </>
      ) : null}

      {selectedPurchase ? <PurchaseSummary purchase={selectedPurchase} compact /> : null}

      <label className="field">
        <span>开始时间</span>
        <input
          required
          type="datetime-local"
          value={startedAt}
          onChange={(event) => setStartedAt(event.target.value)}
        />
      </label>
      <label className="field">
        <span>游玩时长（分钟）</span>
        <input
          required
          min="1"
          max="1440"
          step="1"
          type="number"
          value={durationMinutes}
          onChange={(event) => setDurationMinutes(event.target.value)}
        />
      </label>

      <p className="manual-play-help">
        收藏资料仍由原游戏库维护；这里仅保存游玩时间，不复制购买或卖出字段。
      </p>
      {error ? <p className="play-error">{error}</p> : null}
      <footer>
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? "正在保存" : "保存游玩记录"}
        </button>
      </footer>
    </form>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function LinkSummary({ game }: { game: PlayGameSummary }) {
  if (game.link?.status === "confirmed")
    return <span className="play-link-state is-confirmed">已关联：{game.link.purchaseTitle}</span>;
  if (game.link?.status === "suggested")
    return <span className="play-link-state">待确认：{game.link.purchaseTitle}</span>;
  if (game.link?.status === "rejected")
    return <span className="play-link-state">已忽略自动建议，仍可手动选择</span>;
  return <span className="play-link-state">尚未补充收藏资料</span>;
}

function HistoryLinkControl({
  game,
  purchases,
  onCreate,
  onConfirm,
}: {
  game: PlayGameSummary;
  purchases: PurchaseCandidate[];
  onCreate?: () => void;
  onConfirm: (purchaseRecordId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <PurchaseLinkEditor
        game={game}
        purchases={purchases}
        initiallyExpanded
        onClose={() => setEditing(false)}
        onConfirm={async (purchaseRecordId) => {
          await onConfirm(purchaseRecordId);
          setEditing(false);
        }}
        onReject={async () => undefined}
      />
    );
  return (
    <div className="play-history-link">
      <LinkSummary game={game} />
      <div className="play-history-link__actions">
        {onCreate && game.link?.status !== "confirmed" ? (
          <button className="primary-button" type="button" onClick={onCreate}>
            补充收藏资料
          </button>
        ) : null}
        {purchases.length ? (
          <button className="ghost-button" type="button" onClick={() => setEditing(true)}>
            {game.link?.status === "confirmed" ? "更改关联" : "关联已有收藏"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PurchaseLinkEditor({
  game,
  purchases,
  initiallyExpanded = false,
  onClose,
  onConfirm,
  onReject,
}: {
  game: PlayGameSummary;
  purchases: PurchaseCandidate[];
  initiallyExpanded?: boolean;
  onClose?: () => void;
  onConfirm: (purchaseRecordId: string) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const suggestedId = game.link?.status === "suggested" ? game.link.purchaseRecordId : null;
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState(game.title);
  const [selectedId, setSelectedId] = useState(game.link?.purchaseRecordId || "");
  const [saving, setSaving] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const matches = purchases
    .filter(
      (purchase) =>
        !normalizedQuery || purchase.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery),
    )
    .sort((left, right) => {
      if (left.id === suggestedId) return -1;
      if (right.id === suggestedId) return 1;
      if (left.platform !== right.platform) return left.platform === "Nintendo Switch" ? -1 : 1;
      return right.purchaseDate.localeCompare(left.purchaseDate);
    })
    .slice(0, 8);
  const selected = purchases.find((purchase) => purchase.id === selectedId);

  async function confirm() {
    if (!selectedId || saving) return;
    setSaving(true);
    try {
      await onConfirm(selectedId);
    } catch {
      // The parent keeps the server error visible; keep this picker open.
    } finally {
      setSaving(false);
    }
  }

  async function reject() {
    if (saving) return;
    setSaving(true);
    try {
      await onReject();
    } catch {
      // Keep the current choice available for another attempt.
    } finally {
      setSaving(false);
    }
  }

  if (!expanded) {
    return (
      <div className="play-link-prompt">
        <span>
          <strong>
            {suggestedId ? `建议关联：${game.link?.purchaseTitle}` : "尚未关联到游戏库"}
          </strong>
          <small>
            {suggestedId
              ? "标题或官方标识匹配，可直接确认"
              : game.link?.status === "rejected"
                ? "自动建议已忽略，仍可手动选择"
                : "已有同款收藏时直接选择；没有时从历史补建"}
          </small>
        </span>
        <div>
          {suggestedId ? (
            <>
              <button className="ghost-button" type="button" disabled={saving} onClick={reject}>
                忽略
              </button>
              <button className="secondary-button" type="button" onClick={() => setExpanded(true)}>
                改选
              </button>
              <button className="primary-button" type="button" disabled={saving} onClick={confirm}>
                {saving ? "正在关联" : "确认建议"}
              </button>
            </>
          ) : (
            <button className="primary-button" type="button" onClick={() => setExpanded(true)}>
              选择已有收藏
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="play-link-editor">
      <div className="play-link-editor__heading">
        <strong>{suggestedId ? "确认建议或改选收藏" : "选择已有收藏"}</strong>
        {game.link?.status === "rejected" ? <span>之前已忽略自动建议</span> : null}
      </div>
      <label>
        <span>搜索游戏库</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入收藏标题"
        />
      </label>
      <div className="play-link-candidates" role="listbox" aria-label={`${game.title} 的收藏候选`}>
        {matches.map((purchase) => (
          <button
            className={purchase.id === selectedId ? "is-selected" : ""}
            type="button"
            role="option"
            aria-selected={purchase.id === selectedId}
            key={purchase.id}
            onClick={() => setSelectedId(purchase.id)}
          >
            <GameCover title={purchase.title} url={purchase.coverUrl} />
            <span>
              <strong>{purchase.title}</strong>
              <small>{purchaseCandidateLabel(purchase)}</small>
            </span>
            {purchase.id === suggestedId ? <b>建议</b> : null}
          </button>
        ))}
        {!matches.length ? (
          <p>
            {purchases.length ? (
              "没有匹配的收藏，换个关键词试试。"
            ) : (
              <>游戏库还没有收藏。后续可直接从这条历史补建并自动关联。</>
            )}
          </p>
        ) : null}
      </div>
      <div className="play-link-actions">
        <span>{selected ? `将关联到：${selected.title}` : "请先选择一条收藏记录"}</span>
        <button
          className="ghost-button"
          type="button"
          disabled={saving}
          onClick={() => {
            setExpanded(false);
            onClose?.();
          }}
        >
          取消
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!selectedId || saving}
          onClick={confirm}
        >
          {saving ? "正在关联" : "确认关联"}
        </button>
      </div>
    </div>
  );
}

function PurchaseSummary({
  purchase,
  compact = false,
}: {
  purchase: PurchaseCandidate;
  compact?: boolean;
}) {
  return (
    <div className={`play-purchase-summary${compact ? " is-compact" : ""}`}>
      <div>
        <strong>{purchase.format}</strong>
        <span className={purchase.soldDate ? "is-sold" : ""}>
          {purchase.soldDate ? `已卖出 · ${purchase.soldDate}` : "持有中"}
        </span>
      </div>
      <p>
        {[purchase.region, purchase.seller, purchase.purchaseDate].filter(Boolean).join(" · ") ||
          "收藏资料待补充"}
      </p>
    </div>
  );
}

function GameCover({ title, url }: { title: string; url: string }) {
  return url ? (
    <img src={url} alt="" />
  ) : (
    <span className="session-cover-fallback">{title.slice(0, 1)}</span>
  );
}

function Empty({ text, action, href }: { text: string; action?: string; href?: string }) {
  return (
    <div className="play-empty">
      <p>{text}</p>
      {action && href ? <Link href={href}>{action}</Link> : null}
    </div>
  );
}

function durationLabel(game: PlayGameSummary) {
  if (game.source === "nintendo_store") return "官方累计";
  if (game.timeSemantics === "daily_aggregate") return "日报合计";
  if (game.timeSemantics === "snapshot_observation") return "累计快照";
  return "会话合计";
}

function lastDateLabel(game: PlayGameSummary) {
  if (game.source === "nintendo_store") return "最近游玩";
  if (game.timeSemantics === "snapshot_observation") return "快照时间";
  return "最后游玩";
}

function sourceLabel(game: PlayGameSummary) {
  if (game.source === "nintendo_store") return `${platformLabel(game.platform)} · Nintendo Store`;
  if (game.source === "moon_connector") return `${platformLabel(game.platform)} · 家长控制日报`;
  if (game.source === "nintendo_connector")
    return `${platformLabel(game.platform)} · Nintendo 快照`;
  if (game.source === "manual") return `${platformLabel(game.platform)} · 手动记录`;
  return `${platformLabel(game.platform)} · 导入会话`;
}

function timeSemanticsDescription(game: PlayGameSummary) {
  if (game.source === "nintendo_store")
    return "Nintendo Store 官方累计；日报和手动会话只作时间线参考。";
  if (game.timeSemantics === "snapshot_observation")
    return "累计快照不是当天游玩，也不进入最近动态。";
  if (game.timeSemantics === "daily_aggregate")
    return "Moon 已保存日报的合计，不代表账号全部历史。";
  return `${game.sessionCount} 段可定位时间的会话记录。`;
}

function sessionSourceLabel(source: PlayGameDetail["sessions"][number]["source"]) {
  if (source === "manual") return "手动记录";
  if (source === "nintendo_connector") return "Nintendo 会话";
  return "导入会话";
}

function purchaseCandidateLabel(purchase: PurchaseCandidate) {
  return [
    purchase.platform,
    purchase.format,
    purchase.region,
    purchase.seller,
    purchase.purchaseDate,
    purchase.soldDate ? "已卖出" : "持有中",
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function formatDate(value: string) {
  if (!value) return "未提供";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value))
    return `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
  if (!Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
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
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function localDate(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toLocalDateTimeInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function platformLabel(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (["bee", "switch2", "nintendoswitch2"].includes(normalized)) return "Nintendo Switch 2";
  if (["hac", "switch", "nintendoswitch"].includes(normalized)) return "Nintendo Switch";
  return value.trim() || "Nintendo Switch";
}
