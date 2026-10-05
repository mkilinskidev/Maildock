import { z } from "zod";

export type MailNavigation = {
  accountId: string;
  mailboxId?: string;
  messageId?: string;
};

/** Resolve supported deep links without introducing an implicit first account. */
export function resolveMailNavigation(
  params: { account?: string; mailbox?: string; message?: string },
  accounts: readonly { id: string; enabled: boolean }[],
  mailboxesByAccount: Record<string, readonly { id: string }[]>,
): MailNavigation | undefined {
  const target = z
    .object({
      account: z.uuid().optional(),
      mailbox: z.uuid().optional(),
      message: z.uuid().optional(),
    })
    .safeParse(params);
  if (!target.success) return undefined;
  const { account, mailbox, message } = target.data;
  const owner = accounts.find(
    (a) =>
      a.enabled &&
      (account
        ? a.id === account
        : mailbox &&
          mailboxesByAccount[a.id]?.some((box) => box.id === mailbox)),
  );
  if (
    !owner ||
    (mailbox &&
      !mailboxesByAccount[owner.id]?.some((box) => box.id === mailbox))
  )
    return undefined;
  // A message needs an explicit placement; its account cannot be guessed.
  if (message && !mailbox) return undefined;
  return { accountId: owner.id, mailboxId: mailbox, messageId: message };
}
