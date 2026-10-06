import { pageBoundary } from "@/shared/infrastructure/logging/web-boundary";
import { redirect, notFound } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
export const dynamic = "force-dynamic";
export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return pageBoundary(async () => {
    if (!(await getCurrentSession())) redirect("/login");
    const { id } = await params;
    try {
      await accountsService.get(id);
    } catch (error) {
      if (error instanceof MailAccountNotFoundError) notFound();
      throw error;
    }
    redirect(`/accounts?account=${encodeURIComponent(id)}`);
  });
}
