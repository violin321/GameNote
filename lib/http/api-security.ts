import type { NextRequest } from "next/server";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ApiRequestError";
  }
}

/**
 * Browser writes must carry an exact same-origin Origin header. Non-browser API
 * clients normally omit Origin and must opt in explicitly so a missing browser
 * header never silently bypasses CSRF protection.
 */
export function assertSameOriginWrite(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ApiRequestError(403, "origin 不合法");
    }
    const host = request.headers.get("host")?.trim() || request.nextUrl.host;
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      .trim()
      .toLowerCase();
    const protocol = forwardedProtocol || request.nextUrl.protocol.replace(/:$/, "");
    if (!host || (protocol !== "http" && protocol !== "https"))
      throw new ApiRequestError(403, "请求来源不可验证");
    if (parsed.origin !== `${protocol}://${host}`) throw new ApiRequestError(403, "禁止跨源写入");
    return;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  const explicitApiClient = request.headers.get("x-gamenote-api") === "1";
  if (fetchSite || !explicitApiClient) throw new ApiRequestError(403, "写请求需要同源 Origin");
}

export async function readBoundedJson<T = unknown>(request: NextRequest, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("maximumBytes must be a positive safe integer");

  const declaredValue = request.headers.get("content-length");
  if (declaredValue) {
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared) || declared < 0)
      throw new ApiRequestError(400, "Content-Length 无效");
    if (declared > maximumBytes) throw new ApiRequestError(413, "JSON 请求体过大");
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json")
    throw new ApiRequestError(415, "Content-Type 必须为 application/json");
  if (!request.body) throw new ApiRequestError(400, "缺少 JSON 请求体");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("body limit exceeded").catch(() => undefined);
        throw new ApiRequestError(413, "JSON 请求体过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { raw, value: JSON.parse(raw) as T };
  } catch {
    throw new ApiRequestError(400, "无效 JSON");
  }
}
