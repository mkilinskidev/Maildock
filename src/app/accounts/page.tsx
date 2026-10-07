import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/modules/auth/application/session";
import { AccountList } from "@/components/account-list";
import { microsoftOAuth } from "@/modules/accounts/infrastructure/accounts";
import {
  accountsService,
  mailboxService,
} from "@/modules/accounts/infrastructure/accounts";

export const dynamic = "force-dynamic";
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string; oauth_error?: string }>;
}) {
  if (!(await getCurrentSession())) redirect("/login");
  const accounts = await accountsService.list();
  const entries = await Promise.all(
    accounts.map(
      async (account) =>
        [account.id, await mailboxService.listForAccount(account.id)] as const,
    ),
  );
  return (
    <main className="page-shell">
      <section className="wide">
        <header className="page-header">
          <h1>Accounts</h1>
          <Link className="button-link" href="/">
            Back to mail
          </Link>
        </header>
        <AccountList
          accounts={accounts}
          mailboxesByAccount={Object.fromEntries(entries)}
          oauthConfigured={microsoftOAuth.configured}
          oauthResult={await searchParams}
        />
      </section>
    </main>
  );
}
