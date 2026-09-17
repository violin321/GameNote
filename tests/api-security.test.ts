import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError, assertSameOriginWrite, readBoundedJson } from "../lib/http/api-security";

function writeRequest(headers: Record<string, string> = {}, body = "{}") {
  return new NextRequest("https://games.example/api/play-import/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("write API security", () => {
  it("accepts an exact same-origin browser write", () => {
    expect(() =>
      assertSameOriginWrite(writeRequest({ origin: "https://games.example" })),
    ).not.toThrow();
    expect(() =>
      assertSameOriginWrite(
        new NextRequest("http://internal:3000/api/play-import/preview", {
          method: "POST",
          headers: {
            origin: "https://games.example",
            host: "games.example",
            "x-forwarded-host": "untrusted.example",
            "x-forwarded-proto": "https",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a cross-origin browser write", () => {
    expect(() =>
      assertSameOriginWrite(writeRequest({ origin: "https://evil.example" })),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("rejects a missing Origin unless a direct API client explicitly opts in", () => {
    expect(() => assertSameOriginWrite(writeRequest())).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => assertSameOriginWrite(writeRequest({ "x-gamenote-api": "1" }))).not.toThrow();
    expect(() =>
      assertSameOriginWrite(
        writeRequest({ "x-gamenote-api": "1", "sec-fetch-site": "same-origin" }),
      ),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("reads JSON within the bound and rejects declared or streamed overflow", async () => {
    await expect(readBoundedJson(writeRequest({}, '{"ok":true}'), 64)).resolves.toMatchObject({
      value: { ok: true },
    });
    await expect(
      readBoundedJson(writeRequest({ "content-length": "65" }), 64),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readBoundedJson(writeRequest({}, `{"value":"${"x".repeat(80)}"}`), 64),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("rejects invalid JSON and non-JSON media types", async () => {
    await expect(readBoundedJson(writeRequest({}, "{"), 64)).rejects.toMatchObject({ status: 400 });
    const request = new NextRequest("https://games.example/api/play-import/commit", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readBoundedJson(request, 64)).rejects.toMatchObject({ status: 415 });
  });
});
