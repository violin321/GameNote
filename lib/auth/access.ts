import type { NextRequest } from "next/server";
import {
  accessCookieName,
  createAccessSessionToken,
  verifyAccessSessionToken,
  type AccessIdentity,
} from "@/lib/auth/session-token";
import { getRegisteredUser } from "@/lib/ledger/repository";

export { accessCookieName };

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) {
    if (process.env.NODE_ENV === "production" && Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("JWT_SECRET 至少需要 32 字节");
    }
    return secret;
  }
  if (process.env.NODE_ENV !== "production") return "gamenote-local-development-secret";
  throw new Error("JWT_SECRET 未配置");
}

export async function getAccessIdentity(request: NextRequest) {
  const cookie = request.cookies.get(accessCookieName)?.value ?? "";
  const identity = await verifyAccessSessionToken(cookie, getJwtSecret());
  if (!identity) return null;
  const user = await getRegisteredUser();
  if (
    !user ||
    user.id !== identity.id ||
    user.username !== identity.username ||
    user.sessionVersion !== identity.sessionVersion
  )
    return null;
  return identity;
}

export async function hasValidAccessCookie(request: NextRequest) {
  return Boolean(await getAccessIdentity(request));
}

export async function createSessionToken(identity: AccessIdentity) {
  return createAccessSessionToken(identity, getJwtSecret());
}
