import { createHash } from "node:crypto";

/**
 * Canonical purchase JSON is compact JSON with object keys sorted recursively.
 * Array order is significant. The projection hash is SHA-256 over the UTF-8
 * bytes of that canonical JSON, independent of input whitespace/key order.
 *
 * @param {unknown} value JSON value or JSON text
 */
export function canonicalPurchaseJson(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return JSON.stringify(sortJsonValue(parsed));
}

/** @param {unknown} value JSON value or JSON text */
export function purchaseProjectionHash(value) {
  return createHash("sha256").update(canonicalPurchaseJson(value), "utf8").digest("hex");
}

/**
 * Registers the deterministic SQL function required by migration 002.
 *
 * @param {{ function(name: string, options: { deterministic: boolean }, callback: (value: unknown) => string): void }} db
 */
export function registerPurchaseProjectionSqlFunctions(db) {
  db.function("purchase_projection_sha256", { deterministic: true }, purchaseProjectionHash);
}

/** @param {unknown} value */
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}
