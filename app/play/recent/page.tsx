import { redirect } from "next/navigation";

export default function RecentPlayPage() {
  redirect("/play/history?view=recent");
}
