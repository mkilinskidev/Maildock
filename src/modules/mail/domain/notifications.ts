import { z } from "zod";

export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    folders: z.enum(["inbox", "all"]),
    accountIds: z.array(z.uuid()).max(500).nullable(),
    backgroundOnly: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>;
export const defaultNotificationPreferences: NotificationPreferences = {
  enabled: false,
  folders: "inbox",
  accountIds: null,
  backgroundOnly: true,
};
export type ArrivalNotification = {
  id: string;
  accountId: string;
  mailboxId: string;
  messageId: string;
  sender: string;
  subject: string;
  accountName: string;
};
export function matchesNotificationPreferences(
  preferences: NotificationPreferences,
  accountId: string,
  isInbox: boolean,
) {
  return (
    preferences.enabled &&
    (preferences.accountIds === null ||
      preferences.accountIds.includes(accountId)) &&
    (preferences.folders === "all" || isInbox)
  );
}
