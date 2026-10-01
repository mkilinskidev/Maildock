import { redirect } from "next/navigation";
import Link from "next/link";
import { ThemeControl } from "@/components/theme-control";
import { getCurrentSession } from "@/modules/auth/application/session";
import { AccountList } from "@/components/account-list";
import { microsoftOAuth } from "@/modules/accounts/infrastructure/accounts";
import {
  accountsService,
  mailboxService,
  mailboxRoleService,
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
  const roleEntries = await Promise.all(
    accounts.map(
      async (account) =>
        [account.id, await mailboxRoleService.list(account.id)] as const,
    ),
  );
  return (
    <main className="page-shell">
      <section className="page-content">
        <header className="page-header">
          <div>
            <h1>Accounts</h1>
            <p>Manage your mail connections and preferences.</p>
          </div>
          <div className="page-header-actions">
            <ThemeControl />
            <Link className="button-link secondary" href="/">
              Back to mail
            </Link>
          </div>
        </header>
        <AccountList
          accounts={accounts}
          mailboxesByAccount={Object.fromEntries(entries)}
          rolesByAccount={Object.fromEntries(roleEntries)}
          oauthConfigured={microsoftOAuth.configured}
          oauthResult={await searchParams}
        />
      </section>
    </main>
  );
}
