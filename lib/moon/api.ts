import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "@/lib/auth/access";
import type { AccessIdentity } from "@/lib/auth/session-token";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import { MoonSidecarClient, MoonSidecarError } from "./sidecar-client";
import { MoonSnapshotError } from "./import";

const limits = new Map<string, { count: number; resetAt: number }>();
const noStore = { "cache-control": "no-store" };

export async function requireMoonAdmin(
  request: NextRequest,
  write = false,
): Promise<{ response: NextResponse } | { identity: AccessIdentity }> {
  const identity = await getAccessIdentity(request);
  if (!identity) return { response: json({ error: "unauthorized" }, 401) } as const;
  if (write) assertSameOriginWrite(request);
  const now = Date.now();
  const key = `${identity.id}:${request.nextUrl.pathname}`;
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    for (const [id, entry] of limits) if (entry.resetAt <= now) limits.delete(id);
    if (limits.size >= 1_000) limits.delete(limits.keys().next().value!);
    limits.set(key, { count: 1, resetAt: now + 60_000 });
  } else if (++current.count > (write ? 10 : 60)) {
    throw new MoonSidecarError(
      429,
      "connector_rate_limited",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    );
  }
  return { identity } as const;
}

export function moonClient() {
  return MoonSidecarClient.configured();
}
export async function readMoonJson(request: NextRequest) {
  return (await readBoundedJson<unknown>(request, 8 * 1024)).value;
}
export async function assertEmptyMoonBody(request: NextRequest) {
  if (!request.body) return;
  // NextRequest can expose an empty stream for fetch POSTs without a body.
  // Accept only an actually empty stream when no JSON content type was sent.
  if (!request.headers.get("content-type")) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.byteLength) {
          await reader.cancel().catch(() => undefined);
          throw new ApiRequestError(415, "Unexpected request body");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const value = await readMoonJson(request);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)
    throw new ApiRequestError(400, "Unexpected request body");
}
export function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(value, { status, headers: { ...noStore, ...extraHeaders } });
}
export function empty() {
  return new NextResponse(null, { status: 204, headers: noStore });
}
export function moonErrorResponse(error: unknown) {
  if (error instanceof ApiRequestError) {
    const code =
      (
        { 403: "forbidden", 413: "request_too_large", 415: "unsupported_media_type" } as Record<
          number,
          string
        >
      )[error.status] || "invalid_request";
    return json({ error: code }, error.status);
  }
  if (error instanceof MoonSidecarError) {
    return json(
      { error: error.code },
      error.status,
      error.retryAfter ? { "retry-after": String(error.retryAfter) } : {},
    );
  }
  if (error instanceof MoonSnapshotError) return json({ error: "invalid_snapshot" }, 422);
  return json({ error: "moon_connector_error" }, 500);
}
