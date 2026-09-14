"use client";

import { useMemo, useState } from "react";
import { normalizeChineseSearchText } from "@/lib/game/title-normalization";
import type { GameRecord } from "@/features/ledger/types";
import type { PlayGameSummary } from "@/lib/play-history/types";

export function PurchaseLinkEditor({
  game,
  purchases,
  onSaved,
  expandedByDefault = false,
}: {
  game: PlayGameSummary;
  purchases: GameRecord[];
  onSaved: () => Promise<void> | void;
  expandedByDefault?: boolean;
}) {
  const suggestedId = game.link?.status === "suggested" ? game.link.purchaseRecordId : null;
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [selectedId, setSelectedId] = useState(suggestedId || "");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(() => {
    const normalizedQuery = normalizeChineseSearchText(query).replace(/\s+/g, "");
    return purchases
      .filter((record) => {
        if (!normalizedQuery) return true;
        return normalizeChineseSearchText(record.title)
          .replace(/\s+/g, "")
          .includes(normalizedQuery);
      })
      .sort((left, right) => {
        if (left.id === suggestedId) return -1;
        if (right.id === suggestedId) return 1;
        return left.title.localeCompare(right.title, "zh-CN");
      })
      .slice(0, 50);
  }, [purchases, query, suggestedId]);

  const selected = purchases.find((record) => record.id === selectedId) || null;

  async function decide(action: "confirm" | "reject", purchaseRecordId?: string | null) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/play-links/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          playGameId: game.id,
          purchaseRecordId: purchaseRecordId || null,
          action,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "关联操作失败");
      setExpanded(false);
      await onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "关联操作失败");
    } finally {
      setSaving(false);
    }
  }

  if (!expanded) {
    return (
      <div className="play-link-summary">
        <span>{linkLabel(game)}</span>
        <div>
          {suggestedId ? (
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => void decide("confirm", suggestedId)}
            >
              确认建议
            </button>
          ) : null}
          {game.link?.status === "suggested" ? (
            <button
              className="ghost-button"
              type="button"
              disabled={saving}
              onClick={() => void decide("reject")}
            >
              忽略
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={() => setExpanded(true)}>
            {game.link?.status === "confirmed" ? "更改关联" : "选择收藏"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="play-link-editor">
      <label className="field">
        <span>搜索收藏</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入收藏标题"
        />
      </label>

      <div className="play-link-candidates" role="listbox" aria-label={`${game.title} 的收藏候选`}>
        {candidates.map((record) => (
          <button
            className={record.id === selectedId ? "is-selected" : ""}
            type="button"
            role="option"
            aria-selected={record.id === selectedId}
            key={record.id}
            onClick={() => setSelectedId(record.id)}
          >
            <GameCover title={record.title} url={record.coverUrl} />
            <span>
              <strong>{record.title}</strong>
              <small>
                {record.platform} · {record.format} · {record.purchaseDate || "未填写购买日期"}
              </small>
            </span>
            {record.id === suggestedId ? <b>建议</b> : null}
          </button>
        ))}
        {!candidates.length ? (
          <p>{purchases.length ? "没有匹配的收藏，请换个关键词。" : "游戏库还没有收藏记录。"}</p>
        ) : null}
      </div>

      {error ? (
        <p className="play-message is-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="play-link-actions">
        <span>{selected ? `将关联到：${selected.title}` : "请选择一条收藏记录"}</span>
        <button
          className="ghost-button"
          type="button"
          disabled={saving}
          onClick={() => setExpanded(false)}
        >
          取消
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!selectedId || saving}
          onClick={() => void decide("confirm", selectedId)}
        >
          {saving ? "正在关联" : "确认关联"}
        </button>
      </div>
    </div>
  );
}

function linkLabel(game: PlayGameSummary) {
  if (game.link?.status === "confirmed") {
    return game.link.purchaseTitle
      ? `已关联：${game.link.purchaseTitle}`
      : "原收藏已不存在，请重新关联";
  }
  if (game.link?.status === "suggested")
    return `建议关联：${game.link.purchaseTitle || "收藏记录"}`;
  if (game.link?.status === "rejected") return "已忽略自动建议，可手动选择收藏";
  return "尚未关联收藏";
}

function GameCover({ title, url }: { title: string; url: string }) {
  return url ? <img src={url} alt="" /> : <span aria-hidden="true">{title.slice(0, 1)}</span>;
}
