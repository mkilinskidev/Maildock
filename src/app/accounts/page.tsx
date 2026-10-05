import { MailPreferencesService } from "@/modules/mail/application/mail-preferences-service";
import { NotificationService } from "@/modules/mail/application/notification-service";
import { SettingsShell } from "@/components/settings-shell";
import { RemoteContentSenderService } from "@/modules/mail/application/remote-content-sender-service";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/modules/auth/application/session";
import { ConversationService } from "@/modules/mail/application/conversation-service";
import { db } from "@/shared/infrastructure/database/runtime-database";
import { oauthProviders } from "@/modules/accounts/infrastructure/accounts";
import {
  accountsService,
  mailboxService,
  mailboxRoleService,
  signatureService,
} from "@/modules/accounts/infrastructure/accounts";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{
    oauth?: string;
    oauth_error?: string;
    account?: string;
    add?: string;
    section?: string;
  }>;
}) {
  if (!(await getCurrentSession())) redirect("/login");
  const accounts = await accountsService.list();
  const signatureCatalog = await signatureService.catalog();
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
  return (
    <SettingsShell
      key={`${params.section ?? ""}:${params.account ?? ""}`}
      notificationPreferences={await new NotificationService(db).preferences()}
      autoReadPreference={await new MailPreferencesService(db).autoRead()}
      accounts={accounts}
      mailboxesByAccount={Object.fromEntries(entries)}
      rolesByAccount={Object.fromEntries(roleEntries)}
      signatureCatalog={signatureCatalog}
      oauthProviders={await Promise.all(
        oauthProviders.list().map(async (provider) => ({
          ...provider.getDefinition(),
          configured: await provider.isConfigured(),
        })),
      )}
      oauthResult={params}
      initialAccountId={params.account}
      initialOAuthProviders={params.section === "oauth-providers"}
      initialApplicationLogs={params.section === "application-logs"}
      initialAddAccount={params.add === "1" || !!params.oauth_error}
      conversationEnabled={await new ConversationService(db).enabled()}
      trustedSenders={await new RemoteContentSenderService(db).list()}
    />
  );
}
