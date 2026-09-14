"use client";

import { ChangeEvent, useRef, useState } from "react";
import type { ImportPreview } from "@/lib/play-history/types";

type PreviewResponse = {
  batchId: string;
  preview: ImportPreview;
  replayed?: boolean;
};

export function PlayImportPanel({ onImported }: { onImported: () => Promise<void> | void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function previewFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setError("");
    setNotice("");
    setPreview(null);
    setFileName(file.name);

    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("JSON 文件不能超过 2 MB");
      const raw = await file.text();
      const response = await fetch("/api/play-import/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `file-${await digest(raw)}`,
        },
        body: raw,
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<PreviewResponse> & {
        error?: string;
      };
      if (!payload.preview || !payload.batchId) {
        throw new Error(payload.error || `无法预览文件（HTTP ${response.status}）`);
      }
      setPreview(payload as PreviewResponse);
      if (!response.ok && payload.preview.valid) {
        throw new Error(payload.error || "无法预览文件");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法预览文件");
    } finally {
      setBusy(false);
    }
  }

  async function commitPreview() {
    if (!preview?.preview.valid) return;
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/play-import/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: preview.batchId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        insertedGames?: number;
        insertedSessions?: number;
        replayed?: boolean;
      };
      if (!response.ok) throw new Error(payload.error || "导入失败");
      setPreview(null);
      setFileName("");
      setNotice(
        payload.replayed
          ? "这批数据之前已经导入，无需重复写入。"
          : `已导入 ${payload.insertedGames || 0} 款游戏、${payload.insertedSessions || 0} 条游玩记录。`,
      );
      await onImported();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="app-surface play-import-panel" aria-labelledby="play-import-title">
      <div className="play-section-heading">
        <div>
          <h2 id="play-import-title">导入游玩数据</h2>
          <p>先预览 JSON；确认后才会写入，重复会话会自动忽略。</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "正在处理" : "选择 JSON"}
        </button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="application/json,.json"
          onChange={previewFile}
          disabled={busy}
        />
      </div>

      {preview ? (
        <div className="play-import-preview">
          <div>
            <strong>{fileName || "待导入文件"}</strong>
            <span>
              来源 {preview.preview.sourceId} · {preview.preview.itemCount} 款游戏 ·{" "}
              {preview.preview.sessionCount} 条记录
            </span>
            {preview.preview.duplicateGames ||
            preview.preview.duplicateSessions ||
            preview.preview.existingGames ||
            preview.preview.existingSessions ||
            preview.preview.conflictingGames ||
            preview.preview.conflictingSessions ? (
              <span>
                文件内重复 {preview.preview.duplicateGames} 款 / {preview.preview.duplicateSessions}{" "}
                条；数据库已有 {preview.preview.existingGames} 款 /{" "}
                {preview.preview.existingSessions} 条；冲突 {preview.preview.conflictingGames} 款 /{" "}
                {preview.preview.conflictingSessions} 条
              </span>
            ) : null}
          </div>
          {preview.preview.issues.length ? (
            <ul>
              {preview.preview.issues.slice(0, 8).map((issue) => (
                <li key={`${issue.index}-${issue.path}-${issue.message}`}>
                  <code>{issue.path}</code>：{issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={commitPreview}
            >
              确认导入
            </button>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="play-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="play-message" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
    </section>
  );
}

async function digest(raw: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
