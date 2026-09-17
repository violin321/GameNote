import { NextRequest, NextResponse } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hasValidAccessCookie } from "@/lib/auth/access";

export const runtime = "nodejs";
const maxImageBytes = 15 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export async function GET(request: NextRequest) {
  if (!(await hasValidAccessCookie(request)))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const value = request.nextUrl.searchParams.get("url");
  let url: URL;

  try {
    url = new URL(value || "");
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    return NextResponse.json({ error: "invalid image URL" }, { status: 400 });
  }

  try {
    if (!(await isPublicImageUrl(url))) {
      return NextResponse.json({ error: "image host unavailable" }, { status: 400 });
    }

    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 GameNote/1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();

    if (!response.ok || !allowedImageTypes.has(contentType)) {
      return NextResponse.json({ error: "image unavailable" }, { status: 502 });
    }

    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxImageBytes) {
      return NextResponse.json({ error: "image too large" }, { status: 413 });
    }

    const image = await response.arrayBuffer();
    if (image.byteLength > maxImageBytes) {
      return NextResponse.json({ error: "image too large" }, { status: 413 });
    }
    if (!hasExpectedImageSignature(new Uint8Array(image), contentType))
      return NextResponse.json({ error: "invalid image data" }, { status: 415 });

    return new NextResponse(image, {
      headers: {
        "cache-control": "private, max-age=86400",
        "content-type": contentType,
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "image unavailable" }, { status: 502 });
  }
}

function hasExpectedImageSignature(bytes: Uint8Array, contentType: string) {
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (contentType === "image/png")
    return bytes
      .slice(0, 8)
      .every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (contentType === "image/webp")
    return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
  if (contentType === "image/avif") {
    const brand = ascii(bytes, 4, 12);
    return brand.startsWith("ftyp") && /avif|avis|mif1/.test(ascii(bytes, 8, 32));
  }
  return false;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

async function isPublicImageUrl(url: URL) {
  if (url.username || url.password || url.port) {
    return false;
  }

  try {
    const addresses = await lookup(url.hostname, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    return false;
  }
}

function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (mappedIpv4) {
    return isPublicAddress(mappedIpv4);
  }

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}
