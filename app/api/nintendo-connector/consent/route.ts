import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { getJwtSecret } from "@/lib/auth/access";
import {
  json,
  nintendoClient,
  nintendoErrorResponse,
  readNintendoJson,
  requireNintendoAdmin,
} from "@/lib/nintendo/api";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request);
    if ("response" in access) return access.response;
    return json(await (await nintendoClient()).consentChallenge());
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    const value = await readNintendoJson(request);
    if (!isConsent(value)) return json({ error: "invalid_consent" }, 400);
    const subject = localConsentSubject(access.identity.id, getJwtSecret());
    return json(
      await (
        await nintendoClient()
      ).grantConsent({
        riskNoticeHash: value.riskNoticeHash,
        userSubject: `user:${subject}`,
        adminSubject: `admin:${subject}`,
      }),
      201,
    );
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const access = await requireNintendoAdmin(request, true);
    if ("response" in access) return access.response;
    return json(await (await nintendoClient()).revokeConsent());
  } catch (error) {
    return nintendoErrorResponse(error);
  }
}

function isConsent(value: unknown): value is {
  riskNoticeHash: string;
  acknowledged: true;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).length === 2 &&
    typeof fields.riskNoticeHash === "string" &&
    /^sha256:[a-f0-9]{64}$/i.test(fields.riskNoticeHash) &&
    fields.acknowledged === true
  );
}

function localConsentSubject(identityId: string, secret: string) {
  // The receipt gets a stable, domain-separated pseudonym derived only from the
  // authenticated local account. The browser never selects or sees this subject.
  return createHmac("sha256", secret)
    .update("gamenote:nintendo-provider-consent\0", "utf8")
    .update(identityId, "utf8")
    .digest("base64url");
}
