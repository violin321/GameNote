import { describe, expect, it } from "vitest";
import {
  STORE_CLIENT_ID,
  STORE_REDIRECT_URI,
  STORE_SCOPE,
  ProbeError,
  classifyStoreHttpError,
  createStoreClient,
} from "../scripts/nintendo-store-probe/client.mjs";

type StoreTransportRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
};

describe("Nintendo Store probe client", () => {
  it("maps a revoked long-lived session to a reauthorization-required code", () => {
    expect(
      classifyStoreHttpError(
        "https://accounts.nintendo.com/connect/1.0.0/api/token",
        400,
        JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
      ),
    ).toBe("store_reauthorization_required");
    expect(
      classifyStoreHttpError(
        "https://app-api.znej.nintendo.com/api/v2.0/users/me/play_histories",
        401,
      ),
    ).toBe("store_auth_rejected");
  });

  it("exchanges a code against the fixed Store client", async () => {
    const calls: StoreTransportRequest[] = [];
    const client = createStoreClient({
      transport: async (request: StoreTransportRequest) => {
        calls.push(request);
        return { session_token: "session-token-value" };
      },
    });
    await expect(client.exchangeCode("code-value", "verifier-value")).resolves.toBe(
      "session-token-value",
    );
    expect(STORE_CLIENT_ID).toBe("5c38e31cd085304b");
    expect(STORE_REDIRECT_URI).toContain(STORE_CLIENT_ID);
    expect(STORE_SCOPE).toContain("user.email");
    expect(calls[0].url).toContain("/session_token");
    expect(calls[0].headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(calls[0].body)).toContain(`client_id=${STORE_CLIENT_ID}`);
  });

  it("normalizes cumulative minutes without inventing missing zeroes", async () => {
    const client = createStoreClient({
      transport: async ({ url }: StoreTransportRequest) => {
        if (url.endsWith("/token")) return { access_token: "access-token-value" };
        return {
          playHistories: [
            {
              titleId: "0100",
              titleName: "Animal Crossing",
              platform: "Switch",
              totalPlayedMinutes: 740,
              totalPlayedDays: 12,
              ignored: "secret",
            },
            { titleId: "0200", titleName: "No duration" },
          ],
          recentPlayHistories: [
            {
              date: "2026-09-11T00:00:00Z",
              dailyPlayHistories: [
                {
                  titleId: "0100",
                  titleName: "Animal Crossing",
                  imageUrl: "https://example.test/ac.png",
                  totalPlayedMinutes: 45,
                  ignored: "secret",
                },
              ],
            },
            { playedDate: "2026-09-10" },
          ],
          lastUpdatedAt: "2026-09-12T04:30:00Z",
        };
      },
    });
    const result = await client.collect("session-token-value");
    expect(result.authentication).toBe("access_token");
    expect(result.history.playHistories).toEqual([
      {
        titleId: "0100",
        titleName: "Animal Crossing",
        platform: "Switch",
        totalPlayedMinutes: 740,
        totalPlayedDays: 12,
      },
      { titleId: "0200", titleName: "No duration" },
    ]);
    expect(result.history.recentPlayHistories).toEqual({
      count: 2,
      dates: ["2026-09-11", "2026-09-10"],
      days: [
        {
          playedDate: "2026-09-11",
          dailyPlayHistories: [
            {
              titleId: "0100",
              titleName: "Animal Crossing",
              imageUrl: "https://example.test/ac.png",
              totalPlayedMinutes: 45,
            },
          ],
        },
        { playedDate: "2026-09-10", dailyPlayHistories: [] },
      ],
    });
    expect(result.history.lastUpdatedAt).toBe("2026-09-12T04:30:00Z");
  });

  it("uses id token only for authentication rejection", async () => {
    const authHeaders: string[] = [];
    const client = createStoreClient({
      transport: async ({ url, headers }: StoreTransportRequest) => {
        if (url.endsWith("/token"))
          return { access_token: "access-token-value", id_token: "id-token-value" };
        authHeaders.push(String(headers?.Authorization || ""));
        if (authHeaders.length === 1) throw new ProbeError("store_auth_rejected", 401);
        return { playHistories: [] };
      },
    });
    await expect(client.collect("session-token-value")).resolves.toMatchObject({
      authentication: "id_token",
    });
    expect(authHeaders).toEqual(["Bearer access-token-value", "Bearer id-token-value"]);
  });

  it("does not fallback for unrelated upstream errors", async () => {
    let historyCalls = 0;
    const client = createStoreClient({
      transport: async ({ url }: StoreTransportRequest) => {
        if (url.endsWith("/token"))
          return { access_token: "access-token-value", id_token: "id-token-value" };
        historyCalls++;
        throw new ProbeError("store_http_500", 500);
      },
    });
    await expect(client.collect("session-token-value")).rejects.toMatchObject({
      code: "store_http_500",
    });
    expect(historyCalls).toBe(1);
  });
});
