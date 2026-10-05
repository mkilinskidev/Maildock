import { MailPreferencesService } from "@/modules/mail/application/mail-preferences-service";
import { NotificationService } from "@/modules/mail/application/notification-service";
import { z } from "zod";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";
import { isInstanceInitialized } from "@/modules/auth/application/instance-auth";
import {
  accountsService,
  mailboxService,
  mailboxRoleService,
} from "@/modules/accounts/infrastructure/accounts";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { MailClient } from "@/components/mail-client";
import { ConversationService } from "@/modules/mail/application/conversation-service";
import { getConfig } from "@/shared/infrastructure/config/config";

export const metadata = { title: "Mail" };
export const dynamic = "force-dynamic";
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    mailbox?: string;
    message?: string;
  }>;
}) {
  if (!(await isInstanceInitialized(db))) redirect("/setup");
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
  const params = await searchParams;
  const target = z
    .object({ account: z.uuid(), mailbox: z.uuid(), message: z.uuid() })
    .safeParse(params);
  const initialNotification =
    target.success &&
    accounts.some((a) => a.id === target.data.account && a.enabled) &&
    entries.some(
      ([id, boxes]) =>
        id === target.data.account &&
        boxes.some((box) => box.id === target.data.mailbox),
    )
      ? {
          accountId: target.data.account,
          mailboxId: target.data.mailbox,
          messageId: target.data.message,
        }
      : undefined;
  return (
    <MailClient
      initialNotificationsEnabled={
        (await new NotificationService(db).preferences()).enabled
      }
      initialNotification={initialNotification}
      contentPollIntervalMs={getConfig().contentPollIntervalMs}
      initialConversationView={await new ConversationService(db).enabled()}
      initialAutoRead={await new MailPreferencesService(db).autoRead()}
      accounts={accounts}
      mailboxesByAccount={Object.fromEntries(entries)}
      rolesByAccount={Object.fromEntries(roleEntries)}
    />
  );
}
