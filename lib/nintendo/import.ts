import "server-only";

import { createHash } from "node:crypto";
import { commitImportBatch, saveImportPreview } from "@/lib/play-history/repository";
import { payloadSha256, validateImportPayload } from "@/lib/play-history/validation";
import { nintendoDataSource, type NintendoPlayLog, type NintendoSnapshot } from "./types";

export class NintendoSnapshotError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NintendoSnapshotError";
  }
}

export async function importNintendoSnapshot(snapshot: NintendoSnapshot) {
  const payload = nintendoSnapshotToImportPayload(snapshot);
  const raw = JSON.stringify(payload);
  const hash = payloadSha256(raw);
  const preview = validateImportPayload(payload);
  if (!preview.valid) throw new NintendoSnapshotError("invalid_snapshot_playlog");
  const saved = await saveImportPreview(`nintendo-coral34-${hash.slice(0, 40)}`, hash, preview);
  const committed = await commitImportBatch(saved.batchId, { source: "nintendo_connector" });
  return { ...committed, preview: saved.preview, dataSource: nintendoDataSource };
}

export function nintendoSnapshotToImportPayload(snapshot: NintendoSnapshot) {
  if (
    !snapshot ||
    snapshot.schema !== "gamenote.nintendo.readonly.v1" ||
    snapshot.source?.coralVersion !== "3.4.0" ||
    snapshot.source?.readOnly !== true
  )
    throw new NintendoSnapshotError("unsupported_snapshot");
  const observedAt = safeDate(snapshot.capturedAt);
  if (!observedAt) throw new NintendoSnapshotError("invalid_snapshot_captured_at");
  const playLog = selectPlayLog(snapshot);
  return {
    version: 1,
    games: playLog
      .map((entry) => toGame(entry, observedAt))
      .filter((value): value is NonNullable<typeof value> => Boolean(value)),
  };
}

function selectPlayLog(snapshot: NintendoSnapshot) {
  const current = snapshot.currentUser?.playLog;
  if (Array.isArray(current)) return current;
  const shown = snapshot.userShow?.playLog;
  return Array.isArray(shown) ? shown : [];
}

function toGame(entry: NintendoPlayLog, observedAt: string) {
  const titleId = safeId(entry.titleId);
  const title = typeof entry.name === "string" ? entry.name.trim().slice(0, 200) : "";
  const officialUrl = safeHttpsUrl(entry.officialUrl);
  const imageUrl = safeHttpsUrl(entry.imageUrl);
  const firstPlayedAt = safeDate(entry.firstPlayedAt);
  const total = Number(entry.totalPlayTime);
  if (!title || !Number.isFinite(total) || total < 0) return null;
  const externalId = stableGameId({ titleId, officialUrl, title, imageUrl });
  const totalSeconds = Math.round(total * 60);
  if (!Number.isSafeInteger(totalSeconds)) return null;
  // Coral Game has no last-played field. Persist the aggregate as an
  // observation at snapshot.capturedAt; never manufacture a play session or
  // present the capture timestamp as a last-played timestamp.
  return {
    externalId,
    title,
    titleId,
    officialUrl,
    sessions: [],
    observations: [
      {
        externalId: `nintendo-observation:${externalId.slice("nintendo:".length)}:${observedAt}`,
        observedAt,
        totalSeconds,
        firstPlayedAt,
      },
    ],
  };
}

function stableGameId(fields: {
  titleId: string;
  officialUrl: string;
  title: string;
  imageUrl: string;
}) {
  if (fields.titleId) return `nintendo:title:${fields.titleId}`;
  if (fields.officialUrl) return `nintendo:url:${digest(fields.officialUrl)}`;
  // Versioned, bounded content identity fallback for legal Coral Game records
  // that contain neither titleId nor shopUri. No random or mutable clock input.
  return `nintendo:content-v1:${digest(
    JSON.stringify({ name: fields.title.normalize("NFKC"), imageUrl: fields.imageUrl }),
  )}`;
}
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}
function safeId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : "";
}
function safeDate(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toISOString();
}
function safeHttpsUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}
