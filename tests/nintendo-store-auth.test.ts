import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginStoreAuthorization,
  completeStoreAuthorization,
  nintendoStoreDataDirectory,
  readStoreCredentialState,
  readStoreSession,
  validateStoreCallback,
} from "../services/nintendo-store/auth.mjs";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "gamenote-store-auth-"));
  directories.push(directory);
  return {
    directory,
    environment: {
      NODE_ENV: "test",
      NINTENDO_STORE_DATA_DIR: directory,
    } satisfies NodeJS.ProcessEnv,
  };
}

describe("Nintendo Store local authorization", () => {
  it("requires an explicit absolute private data directory", () => {
    expect(() => nintendoStoreDataDirectory({ NODE_ENV: "test" })).toThrow("not_configured");
    expect(() =>
      nintendoStoreDataDirectory({
        NODE_ENV: "test",
        NINTENDO_STORE_DATA_DIR: "relative/store-data",
      }),
    ).toThrow("not_configured");
    expect(() =>
      nintendoStoreDataDirectory({ NODE_ENV: "test", NINTENDO_STORE_DATA_DIR: "/" }),
    ).toThrow("not_configured");
  });

  it("creates a state-bound PKCE request without requesting email", async () => {
    const { directory, environment } = await fixtureEnvironment();
    const authorization = await beginStoreAuthorization(1_800_000_000_000, environment);
    const url = new URL(authorization.authorizationUrl);
    const scope = url.searchParams.get("scope") || "";

    expect(url.origin).toBe("https://accounts.nintendo.com");
    expect(url.searchParams.get("session_token_code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("session_token_code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,128}$/);
    expect(scope).toBe("openid user user.mii user.links[].id");
    expect(scope).not.toContain("user.email");
    expect((await stat(join(directory, "pending.json"))).mode & 0o077).toBe(0);
  });

  it("encrypts the long-lived session with AES-GCM and reports tampering", async () => {
    const { directory, environment } = await fixtureEnvironment();
    const authorization = await beginStoreAuthorization(Date.now(), environment);
    const state = new URL(authorization.authorizationUrl).searchParams.get("state");
    const callback = `npf5c38e31cd085304b://auth#session_token_code=fixture-code&state=${state}`;
    const sessionToken = "fixture-session-token";

    await expect(
      completeStoreAuthorization(callback, {
        environment,
        client: {
          exchangeCode: async () => sessionToken,
          collect: async () => ({
            history: {
              playHistories: [],
              recentPlayHistories: { count: 0, dates: [], days: [] },
              lastUpdatedAt: undefined,
            },
            authentication: "access_token",
          }),
        },
      }),
    ).resolves.toEqual({ authentication: "access_token" });

    const encrypted = await readFile(join(directory, "session.enc"), "utf8");
    expect(encrypted).not.toContain(sessionToken);
    expect(JSON.parse(encrypted)).toMatchObject({ version: 1 });
    expect((await stat(join(directory, "secret.key"))).mode & 0o077).toBe(0);
    await expect(readStoreSession(environment)).resolves.toBe(sessionToken);
    await expect(readStoreCredentialState(environment)).resolves.toBe("connected");

    await writeFile(join(directory, "session.enc"), '{"version":1,"data":"tampered"}', {
      mode: 0o600,
    });
    await expect(readStoreCredentialState(environment)).resolves.toBe("invalid");
  });

  it("rejects mismatched and replayed callback state", async () => {
    const { environment } = await fixtureEnvironment();
    const authorization = await beginStoreAuthorization(Date.now(), environment);
    const state = new URL(authorization.authorizationUrl).searchParams.get("state");
    expect(() =>
      validateStoreCallback("npf5c38e31cd085304b://auth#session_token_code=fixture&state=wrong", {
        state,
        expiresAt: Date.now() + 60_000,
      }),
    ).toThrow("store_state_mismatch");

    const callback = `npf5c38e31cd085304b://auth#session_token_code=fixture&state=${state}`;
    const options = {
      environment,
      client: {
        exchangeCode: async () => "fixture-session-token",
        collect: async () => ({
          history: {
            playHistories: [],
            recentPlayHistories: { count: 0, dates: [], days: [] },
            lastUpdatedAt: undefined,
          },
          authentication: "access_token",
        }),
      },
    };
    await completeStoreAuthorization(callback, options);
    await expect(completeStoreAuthorization(callback, options)).rejects.toMatchObject({
      code: "store_authorization_expired",
    });
  });
});
