import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth";
import DashboardApp from "./dashboard-app";

export default async function DashboardPage() {
  const session = await readSession();
  if (!session) redirect("/login");
  return <DashboardApp />;
}
