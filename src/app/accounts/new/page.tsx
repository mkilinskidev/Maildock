import { pageBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";

export const dynamic = "force-dynamic";

export default async function NewAccountPage() {
  return pageBoundary(async () => {
    if (!(await getCurrentSession())) redirect("/login");
    redirect("/accounts?add=1");
  });
}
