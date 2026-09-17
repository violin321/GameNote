import { NextRequest, NextResponse } from "next/server";
import { getAccessIdentity } from "../auth/access";
import type { AccessIdentity } from "../auth/session-token";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "../http/api-security";
import { StoreAuthError } from "../../scripts/nintendo-store-probe/auth.mjs";
import { NintendoStoreError } from "./service";

const limits = new Map<string, { count: number; resetAt: number }>();
const noStore = { "cache-control": "no-store" };

export async function requireNintendoStoreAdmin(
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
    for (const [entryKey, entry] of limits) if (entry.resetAt <= now) limits.delete(entryKey);
    if (limits.size >= 1_000) limits.delete(limits.keys().next().value!);
    limits.set(key, { count: 1, resetAt: now + 60_000 });
  } else if (++current.count > (write ? 10 : 60)) {
    throw new NintendoStoreError("store_rate_limited", 429);
  }
  return { identity } as const;
}

export async function assertEmptyNintendoStoreBody(request: NextRequest) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new ApiRequestError(400, "Content-Length 无效");
    if (length > 8 * 1024) throw new ApiRequestError(413, "JSON 请求体过大");
    if (length > 0 && !request.body) throw new ApiRequestError(400, "请求体必须为空");
  }
  if (!request.body) return;
  // NextRequest may expose an empty stream for a bodyless fetch POST. An
  // untyped non-empty stream is never a valid control request.
  const contentType = request.headers.get("content-type");
  if (!contentType) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.byteLength) {
          await reader.cancel().catch(() => undefined);
          throw new ApiRequestError(415, "请求体必须为空");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
  const payload = await readBoundedJson<unknown>(request, 8 * 1024);
  if (
    !payload.value ||
    typeof payload.value !== "object" ||
    Array.isArray(payload.value) ||
    Object.keys(payload.value).length
  )
    throw new ApiRequestError(400, "请求体必须为空");
}

export async function readNintendoStoreJson(request: NextRequest) {
  return (await readBoundedJson<unknown>(request, 8 * 1024)).value;
}

export function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: noStore });
}

export function empty() {
  return new NextResponse(null, { status: 204, headers: noStore });
}

export function nintendoStoreErrorResponse(error: unknown) {
  if (error instanceof ApiRequestError) {
    const code =
      error.status === 403
        ? "forbidden"
        : error.status === 413
          ? "request_too_large"
          : error.status === 415
            ? "unsupported_media_type"
            : "invalid_request";
    return json({ error: code }, error.status);
  }
  if (error instanceof StoreAuthError)
    return json({ error: safeStoreErrorCode(error.code) }, safeStatus(error.status));
  if (error instanceof NintendoStoreError)
    return json({ error: safeStoreErrorCode(error.code) }, safeStatus(error.status));
  return json({ error: "store_unavailable" }, 503);
}

function safeStoreErrorCode(code: unknown) {
  if (typeof code !== "string" || code.length > 96) return "store_unavailable";
  // Service and probe errors are intentionally namespaced. Keep dynamic HTTP
  // status codes, but never reflect arbitrary exception text to the client.
  if (/^store_(?:http_[1-5][0-9]{2}|[a-z0-9]+(?:_[a-z0-9]+)*)$/.test(code)) return code;
  return "store_unavailable";
}

function safeStatus(status: number) {
  return status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
    ? status
    : 503;
}

export function assertStoreCallback(value: unknown): value is { callbackUrl: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { callbackUrl?: unknown }).callbackUrl === "string" &&
    (value as { callbackUrl: string }).callbackUrl.length > 0 &&
    (value as { callbackUrl: string }).callbackUrl.length <= 4096,
  );
}
