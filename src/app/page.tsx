import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import {
  accountsService,
  mailboxService,
} from "@/modules/accounts/infrastructure/accounts";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MailClient } from "@/components/mail-client";

export const dynamic = "force-dynamic";
export default async function HomePage() {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
  if (!(await getCurrentSession())) redirect("/login");
  const accounts = await accountsService.list();
  const entries = await Promise.all(
    accounts.map(
      async (account) =>
        [account.id, await mailboxService.listForAccount(account.id)] as const,
    ),
  );
  return (
    <MailClient
      accounts={accounts}
      mailboxesByAccount={Object.fromEntries(entries)}
    />
  );
}
