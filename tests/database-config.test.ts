import { describe, expect, it } from "vitest";
import { playDatabaseFilePath } from "../lib/play-history/database-config";

describe("NS2 database configuration", () => {
  it("fails closed in production without an explicit NS2 database", () => {
    expect(() => playDatabaseFilePath({ NODE_ENV: "production" })).toThrow("APP_DATABASE_FILE");
    expect(() =>
      playDatabaseFilePath({ NODE_ENV: "production", APP_DATABASE_FILE: "/data/records.sqlite" }),
    ).toThrow("records.sqlite");
    expect(() =>
      playDatabaseFilePath({ NODE_ENV: "production", APP_DATABASE_FILE: "/data/other.sqlite" }),
    ).toThrow("ns2.sqlite");
    expect(() =>
      playDatabaseFilePath({ NODE_ENV: "production", APP_DATABASE_FILE: "/tmp/ns2.sqlite" }),
    ).toThrow("/data/ns2.sqlite");
  });

  it("rejects legacy or ambiguously named database files in every environment", () => {
    expect(() =>
      playDatabaseFilePath({ NODE_ENV: "test", APP_DATABASE_FILE: "/tmp/records.sqlite" }),
    ).toThrow("records.sqlite");
    expect(() =>
      playDatabaseFilePath({ NODE_ENV: "test", APP_DATABASE_FILE: "/tmp/copy.sqlite" }),
    ).toThrow("ns2.sqlite");
    expect(playDatabaseFilePath({ NODE_ENV: "test", APP_DATABASE_FILE: "/tmp/ns2.sqlite" })).toBe(
      "/tmp/ns2.sqlite",
    );
  });

  it("accepts only an explicitly named NS2 database in production", () => {
    expect(
      playDatabaseFilePath({ NODE_ENV: "production", APP_DATABASE_FILE: "/data/ns2.sqlite" }),
    ).toBe("/data/ns2.sqlite");
  });

  it("allows an absolute private database for the explicit local production runtime", () => {
    expect(
      playDatabaseFilePath({
        NODE_ENV: "production",
        GAMENOTE_LOCAL_RUNTIME: "1",
        APP_DATABASE_FILE: "/Users/example/.local/share/gamenote/data/ns2.sqlite",
      }),
    ).toBe("/Users/example/.local/share/gamenote/data/ns2.sqlite");
    expect(() =>
      playDatabaseFilePath({
        NODE_ENV: "production",
        GAMENOTE_LOCAL_RUNTIME: "1",
        APP_DATABASE_FILE: "data/ns2.sqlite",
      }),
    ).toThrow("absolute");
  });
});
