import manifest from "../../package.json";

export type AppRelease = {
  version: string;
  revision: string | null;
};

export function getAppRelease(): AppRelease {
  const revision = process.env.APP_REVISION?.trim();
  return {
    version: manifest.version,
    revision: revision && /^[a-f\d]{40}$/i.test(revision) ? revision.slice(0, 7) : null,
  };
}
