"use client";

import { useState, type ChangeEvent } from "react";
import type { ImportPreview } from "@/lib/play-history/types";

type PreviewResponse = { batchId: string; preview: ImportPreview; replayed: boolean };
export function PlayImportPanel() {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function previewFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus("");
    setPreview(null);
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("游玩 JSON 不能超过 2MB");
      const raw = await file.text();
      const key = `file-${await digest(raw)}`;
      const response = await fetch("/api/play-import/preview", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: raw,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok && !payload.preview) throw new Error(payload.error || "预览失败");
      setPreview(payload);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function commitPreview() {
    if (!preview?.preview.valid) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/play-import/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId: preview.batchId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "导入失败");
      setPreview(null);
      setStatus(
        `已导入 ${payload.insertedGames || 0} 款游戏、${payload.insertedSessions || 0} 段会话`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-fields play-data-source">
      <label className="ghost-button data-source-upload">
        {busy ? "处理中" : "选择游玩记录 JSON"}
        <input type="file" accept="application/json,.json" onChange={previewFile} disabled={busy} />
      </label>
      {preview ? (
        <div className="settings-wide play-preview">
          <strong>导入预览</strong>
          <p>
            {preview.preview.itemCount} 款游戏 · {preview.preview.sessionCount} 段会话 ·{" "}
            {preview.preview.issues.length} 个错误
          </p>
          {preview.preview.issues.length ? (
            <ul>
              {preview.preview.issues.slice(0, 8).map((issue) => (
                <li key={`${issue.index}-${issue.path}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={commitPreview}
              disabled={busy}
            >
              确认导入游玩记录
            </button>
          )}
        </div>
      ) : null}
      {status ? (
        <p className="settings-wide settings-message" role="status">
          {status}
        </p>
      ) : null}
    </div>
  );
}
async function digest(raw: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
