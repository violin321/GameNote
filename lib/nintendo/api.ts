import { NextRequest, NextResponse } from "next/server";
import type { AccessIdentity } from "@/lib/auth/session-token";
import { getAccessIdentity } from "@/lib/auth/access";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "@/lib/http/api-security";
import { NintendoSidecarClient, NintendoSidecarError } from "./sidecar-client";
import { NintendoSnapshotError } from "./import";

const noStore = { "cache-control": "no-store" };
const limits = new Map<string, { count: number; resetAt: number }>();

export async function requireNintendoAdmin(request: NextRequest, write = false) {
  const identity = await getAccessIdentity(request);
  if (!identity) return { response: json({ error: "unauthorized" }, 401) } as const;
  if (write) assertSameOriginWrite(request);
  enforceRateLimit(identity, request.nextUrl.pathname);
  return { identity } as const;
}

export async function nintendoClient() {
  return NintendoSidecarClient.configured();
}

export async function readNintendoJson(request: NextRequest) {
  return (await readBoundedJson<unknown>(request, 8 * 1024)).value;
}

export function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return NextResponse.json(value, { status, headers: { ...noStore, ...extraHeaders } });
}

export function empty(status = 204) {
  return new NextResponse(null, { status, headers: noStore });
}

export function nintendoErrorResponse(error: unknown) {
  if (error instanceof ApiRequestError)
    return json({ error: apiRequestErrorCode(error.status) }, error.status);
  if (error instanceof NintendoSidecarError)
    return json(
      { error: error.code },
      error.status,
      error.retryAfter ? { "retry-after": String(error.retryAfter) } : {},
    );
  if (error instanceof NintendoSnapshotError) return json({ error: error.code }, 422);
  return json({ error: "nintendo_connector_error" }, 500);
}

function apiRequestErrorCode(status: number) {
  if (status === 403) return "forbidden";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  return "invalid_request";
}

function enforceRateLimit(identity: AccessIdentity, operation: string) {
  const now = Date.now();
  const key = `${identity.id}:${operation}`;
  const current = limits.get(key);
  if (!current || current.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > 30)
    throw new NintendoSidecarError(
      429,
      "connector_rate_limited",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    );
}
