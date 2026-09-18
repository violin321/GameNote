import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const version = manifest.version;

if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
  lock.version !== version ||
  lock.packages?.[""]?.version !== version
) {
  console.error("Package and lockfile versions must match and use a valid release version.");
  process.exit(1);
}

const tag = process.argv[2];
if (tag && tag !== `v${version}`) {
  console.error(`Release tag ${tag} does not match package version v${version}.`);
  process.exit(1);
}

console.log(version);
