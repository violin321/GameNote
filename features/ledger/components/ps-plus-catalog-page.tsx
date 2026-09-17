import { catalogPageSize } from "../constants";
import type { AccessStatus, PsPlusCatalog, PsPlusCatalogGame, RecordDisplayMode } from "../types";

type PsPlusCatalogPageProps = {
  accessStatus: AccessStatus;
  catalog: PsPlusCatalog | null;
  catalogQuery: string;
  catalogStatus: "idle" | "loading" | "error";
  catalogError: string;
  displayMode: RecordDisplayMode;
  filteredGames: PsPlusCatalogGame[];
  visibleGames: PsPlusCatalogGame[];
  onQueryChange: (query: string) => void;
  onDisplayModeChange: (mode: RecordDisplayMode) => void;
  onLoad: (force?: boolean) => void;
  onLoadMore: (increment: number) => void;
};

export function PsPlusCatalogPage({
  accessStatus,
  catalog,
  catalogQuery,
  catalogStatus,
  catalogError,
  displayMode,
  filteredGames,
  visibleGames,
  onQueryChange,
  onDisplayModeChange,
  onLoad,
  onLoadMore,
}: PsPlusCatalogPageProps) {
  return (
    <section className="catalog-page">
      <div className="catalog-toolbar">
        <label className="field">
          <span>搜索游戏</span>
          <input
            value={catalogQuery}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="名称、PS4、PS5 或会员等级"
          />
        </label>
        <div className="field catalog-display-field">
          <span>展示方式</span>
          <div className="display-mode-switch" role="group" aria-label="PS Plus 展示方式">
            <button
              className={displayMode === "grid" ? "active" : ""}
              type="button"
              aria-pressed={displayMode === "grid"}
              onClick={() => onDisplayModeChange("grid")}
            >
              网格
            </button>
            <button
              className={displayMode === "list" ? "active" : ""}
              type="button"
              aria-pressed={displayMode === "list"}
              onClick={() => onDisplayModeChange("list")}
            >
              列表
            </button>
          </div>
        </div>
        <div className="catalog-actions">
          {accessStatus === "unlocked" ? (
            <button
              className="primary-button"
              type="button"
              disabled={catalogStatus === "loading"}
              onClick={() => onLoad(true)}
            >
              {catalogStatus === "loading" ? "更新中" : "立即更新"}
            </button>
          ) : null}
        </div>
      </div>
      <div className="catalog-summary">
        <div>
          <strong>{catalog?.games.length ?? "-"}</strong>
          <span>在库游戏</span>
        </div>
        <div>
          <strong>{filteredGames.length}</strong>
          <span>当前结果</span>
        </div>
        <p>
          这里展示港区 PlayStation Plus 完整游戏目录，不会自动加入购买记录。目录会随会员服务调整。
        </p>
      </div>
      {catalog ? (
        <p className="catalog-updated">
          {catalog.stale
            ? "更新失败，当前显示最近一次成功缓存的数据"
            : catalog.cached
              ? "已从缓存读取"
              : "已更新"}{" "}
          · {new Date(catalog.fetchedAt).toLocaleString("zh-CN")}
        </p>
      ) : null}
      {catalogStatus === "loading" && !catalog ? (
        <div className="catalog-message" role="status" aria-live="polite">
          正在从 PlayStation 官方获取游戏库
        </div>
      ) : null}
      {catalogError ? (
        <div className="catalog-message catalog-error" role="alert">
          {catalogError}
          <button className="ghost-button" type="button" onClick={() => onLoad()}>
            重试
          </button>
        </div>
      ) : null}
      {catalog && !filteredGames.length ? (
        <div className="catalog-message">没有符合搜索条件的游戏</div>
      ) : null}
      <div className={`catalog-grid${displayMode === "list" ? " catalog-list" : ""}`}>
        {visibleGames.map((game) => (
          <article className="catalog-card" key={game.id}>
            <div className="catalog-cover">
              {game.coverUrl ? (
                <img
                  src={game.coverUrl}
                  alt={(game.localizedTitle || game.title) + " 封面"}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span>PS+</span>
              )}
            </div>
            <div className="catalog-card-body">
              <h2>
                <a href={game.officialUrl} target="_blank" rel="noreferrer">
                  {game.localizedTitle || game.title}
                </a>
              </h2>
              {game.localizedTitle && game.localizedTitle !== game.title ? (
                <p>{game.title}</p>
              ) : null}
              <div className="catalog-tags">
                <span>{game.tier}</span>
                {game.platforms.map((platform) => (
                  <span key={platform}>{platform}</span>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
      {visibleGames.length < filteredGames.length ? (
        <div className="catalog-load-more">
          <button
            className="ghost-button"
            type="button"
            onClick={() => onLoadMore(catalogPageSize)}
          >
            加载更多
          </button>
          <span>
            已显示 {visibleGames.length} / {filteredGames.length}
          </span>
        </div>
      ) : null}
    </section>
  );
}
