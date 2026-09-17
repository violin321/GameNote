import { redirect } from "next/navigation";

export default function UnlinkedPlayPage() {
  redirect("/play/history?view=unlinked");
}
