import { Dashboard } from "@/components/dashboard";
import { getDashboardData } from "@/lib/data";

export default async function Home() {
  const data = await getDashboardData();
  return <Dashboard {...data} />;
}
