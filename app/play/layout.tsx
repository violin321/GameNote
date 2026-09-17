import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accessCookieName, getJwtSecret } from "@/lib/auth/access";
import { verifyAccessSessionToken } from "@/lib/auth/session-token";
import { getRegisteredUser } from "@/lib/ledger/repository";

export default async function PlayAdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const identity = await verifyAccessSessionToken(
    cookieStore.get(accessCookieName)?.value || "",
    getJwtSecret(),
  );
  const owner = identity ? await getRegisteredUser() : null;
  if (
    !identity ||
    !owner ||
    owner.id !== identity.id ||
    owner.username !== identity.username ||
    owner.sessionVersion !== identity.sessionVersion
  )
    redirect("/");
  return children;
}
