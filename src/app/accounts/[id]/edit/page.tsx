import { notFound, redirect } from "next/navigation";

import { AccountForm } from "@/components/account-form";
import { MailAccountNotFoundError } from "@/modules/accounts/application/accounts-service";
import { accountsService } from "@/modules/accounts/infrastructure/accounts";
import { getCurrentSession } from "@/modules/auth/application/session";

export const dynamic = "force-dynamic";

async function findAccount(id: string) {
  try {
    return await accountsService.get(id);
  } catch (error) {
    if (error instanceof MailAccountNotFoundError) notFound();
    throw error;
  }
}

export default async function EditAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getCurrentSession())) redirect("/login");
  const { id } = await params;
  const account = await findAccount(id);
  if (account.authMethod === "oauth2") redirect("/accounts");
  return (
    <main className="page-shell">
      <section className="wide">
        <h1>Edit mail account</h1>
        <p>
          Stored passwords are never sent to this page. Leave password fields
          blank to keep them.
        </p>
        <AccountForm id={id} account={account} />
      </section>
    </main>
  );
}
