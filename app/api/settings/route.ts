import { NextRequest, NextResponse } from "next/server";
import { accessCookieName, getAccessIdentity } from "@/lib/auth/access";
import {
  getRegisteredUser,
  readAppSettings,
  updateRegisteredUserPassword,
  writeAppSettings,
} from "@/lib/ledger/repository";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isAccessibleThemeColor } from "@/lib/ui/theme-color";

export const runtime = "nodejs";
const datePattern = /^$|^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const [identity, settings] = await Promise.all([
    getAccessIdentity(request).catch(() => null),
    readAppSettings(),
  ]);
  return NextResponse.json({
    siteTitle: settings.siteTitle,
    avatarUrl: settings.avatarUrl,
    themeColor: settings.themeColor,
    showNintendoSwitch: settings.showNintendoSwitch,
    showPlayStation: settings.showPlayStation,
    showPsPlusCatalog: settings.showPsPlusCatalog,
    showMemberships: settings.showMemberships,
    ...(identity
      ? {
          aiBaseUrl: settings.aiBaseUrl,
          aiModel: settings.aiModel,
          aiApiKeyConfigured: Boolean(settings.aiApiKey),
          psPlusEnabled: settings.psPlusEnabled,
          psPlusExpiresAt: settings.psPlusExpiresAt,
          psPlusAutoAddMonthly: settings.psPlusAutoAddMonthly,
          nsOnlineEnabled: settings.nsOnlineEnabled,
          nsOnlineExpiresAt: settings.nsOnlineExpiresAt,
        }
      : {}),
  });
}

export async function PUT(request: NextRequest) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const current = await readAppSettings();
  const siteTitle =
    typeof payload.siteTitle === "string"
      ? payload.siteTitle.trim().slice(0, 40)
      : current.siteTitle;
  const avatarUrl = typeof payload.avatarUrl === "string" ? payload.avatarUrl : current.avatarUrl;
  const themeColor =
    typeof payload.themeColor === "string" && /^#[0-9a-f]{6}$/i.test(payload.themeColor)
      ? payload.themeColor
      : current.themeColor;
  const showNintendoSwitch =
    typeof payload.showNintendoSwitch === "boolean"
      ? payload.showNintendoSwitch
      : current.showNintendoSwitch;
  const showPlayStation =
    typeof payload.showPlayStation === "boolean"
      ? payload.showPlayStation
      : current.showPlayStation;
  const requestedShowPsPlusCatalog =
    typeof payload.showPsPlusCatalog === "boolean"
      ? payload.showPsPlusCatalog
      : current.showPsPlusCatalog;
  const showPsPlusCatalog = showPlayStation && requestedShowPsPlusCatalog;
  const showMemberships =
    typeof payload.showMemberships === "boolean"
      ? payload.showMemberships
      : current.showMemberships;
  const aiBaseUrl =
    typeof payload.aiBaseUrl === "string"
      ? payload.aiBaseUrl.trim().replace(/\/$/, "")
      : current.aiBaseUrl;
  const aiModel =
    typeof payload.aiModel === "string" ? payload.aiModel.trim().slice(0, 80) : current.aiModel;
  let aiApiKey = current.aiApiKey;
  const psPlusEnabled =
    typeof payload.psPlusEnabled === "boolean" ? payload.psPlusEnabled : current.psPlusEnabled;
  const psPlusExpiresAt =
    typeof payload.psPlusExpiresAt === "string"
      ? payload.psPlusExpiresAt.trim()
      : current.psPlusExpiresAt;
  const psPlusAutoAddMonthly =
    typeof payload.psPlusAutoAddMonthly === "boolean"
      ? payload.psPlusAutoAddMonthly
      : current.psPlusAutoAddMonthly;
  const nsOnlineEnabled =
    typeof payload.nsOnlineEnabled === "boolean"
      ? payload.nsOnlineEnabled
      : current.nsOnlineEnabled;
  const nsOnlineExpiresAt =
    typeof payload.nsOnlineExpiresAt === "string"
      ? payload.nsOnlineExpiresAt.trim()
      : current.nsOnlineExpiresAt;
  if (typeof payload.aiApiKey === "string" && payload.aiApiKey.trim())
    aiApiKey = payload.aiApiKey.trim();
  if (payload.clearAiApiKey === true) aiApiKey = "";
  if (
    !siteTitle ||
    (!showNintendoSwitch && !showPlayStation) ||
    !aiModel ||
    !isSecureHttpUrl(aiBaseUrl) ||
    !datePattern.test(psPlusExpiresAt) ||
    !datePattern.test(nsOnlineExpiresAt)
  )
    return NextResponse.json({ error: "设置内容无效" }, { status: 400 });
  if (avatarUrl.length > 750_000)
    return NextResponse.json({ error: "头像图片过大" }, { status: 400 });
  if (!isAccessibleThemeColor(themeColor))
    return NextResponse.json(
      { error: "主题色与白色背景对比度不足，请选择更深的颜色" },
      { status: 400 },
    );
  await writeAppSettings({
    siteTitle,
    avatarUrl,
    themeColor,
    showNintendoSwitch,
    showPlayStation,
    showPsPlusCatalog,
    showMemberships,
    aiBaseUrl,
    aiModel,
    aiApiKey,
    psPlusEnabled,
    psPlusExpiresAt,
    psPlusAutoAddMonthly,
    nsOnlineEnabled,
    nsOnlineExpiresAt,
  });
  return NextResponse.json({
    siteTitle,
    avatarUrl,
    themeColor,
    showNintendoSwitch,
    showPlayStation,
    showPsPlusCatalog,
    showMemberships,
    aiBaseUrl,
    aiModel,
    aiApiKeyConfigured: Boolean(aiApiKey),
    psPlusEnabled,
    psPlusExpiresAt,
    psPlusAutoAddMonthly,
    nsOnlineEnabled,
    nsOnlineExpiresAt,
  });
}

function isSecureHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await getAccessIdentity(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = (await request.json().catch(() => ({}))) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  const currentPassword =
    typeof payload.currentPassword === "string" ? payload.currentPassword : "";
  const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
  const user = await getRegisteredUser();
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash)))
    return NextResponse.json({ error: "当前密码不正确" }, { status: 401 });
  if (newPassword.length < 8 || newPassword.length > 128)
    return NextResponse.json({ error: "新密码需为 8-128 位" }, { status: 400 });
  await updateRegisteredUserPassword(await hashPassword(newPassword));
  const response = NextResponse.json({ updated: true, signedOut: true });
  response.cookies.set(accessCookieName, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "strict",
  });
  return response;
}
