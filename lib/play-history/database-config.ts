import { basename, isAbsolute } from "node:path";

export const ns2DatabaseIdentity = "gamenote-ns2";
export const ns2SchemaVersion = 6;
export const productionNs2DatabasePath = "/data/ns2.sqlite";

export function playDatabaseFilePath(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.APP_DATABASE_FILE?.trim();
  if (configured) assertNs2DatabasePath(configured);
  if (environment.NODE_ENV === "production") {
    if (!configured) throw new Error("APP_DATABASE_FILE must explicitly select the NS2 database");
    if (environment.GAMENOTE_LOCAL_RUNTIME === "1") {
      if (!isAbsolute(configured))
        throw new Error("APP_DATABASE_FILE must be absolute for the local runtime");
      return configured;
    }
    if (configured !== productionNs2DatabasePath)
      throw new Error(`APP_DATABASE_FILE must be ${productionNs2DatabasePath} in production`);
    return configured;
  }
  return configured || "data/ns2.sqlite";
}

export function assertNs2DatabasePath(file: string) {
  if (basename(file).toLowerCase() === "records.sqlite")
    throw new Error("legacy records.sqlite is forbidden for NS2");
  if (basename(file).toLowerCase() !== "ns2.sqlite")
    throw new Error("NS2 database path must end in ns2.sqlite");
}
