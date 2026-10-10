import type {
  GmailReceiveAdapter,
  MailTransportRouter,
} from "../../accounts/domain/receive-transport";
import type { GmailProvider } from "./gmail-provider";
import { gmailDisplay, gmailParts, gmailPartBytes } from "./gmail-mime";
import { decodeBase64Url } from "../../accounts/infrastructure/gmail-client";

/** Native locators only. Mailbox-oriented IMAP operations never reach this adapter. */
export function bindNativeGmail(
  router: MailTransportRouter,
  provider: GmailProvider,
  synchronize: GmailReceiveAdapter["synchronize"],
  limits: { maxMessageTextPartBytes: number; maxAttachmentBytes: number },
  mutate: GmailReceiveAdapter["mutate"],
) {
  router.bindGmail({
    synchronize,
    content: async (locator) => {
      const { client } = await provider.interactive(locator.accountId);
      return gmailDisplay(
        client,
        await client.message(locator.messageId, true),
        limits.maxMessageTextPartBytes,
      );
    },
    attachment: async (locator) => {
      const { client } = await provider.interactive(locator.message.accountId);
      if (locator.attachmentId)
        return decodeBase64Url(
          (
            await client.attachment(
              locator.message.messageId,
              locator.attachmentId,
            )
          ).data,
          limits.maxAttachmentBytes,
        );
      const message = await client.message(locator.message.messageId, true);
      const part = gmailParts(message.payload).find(
        (p) => p.partId === locator.partId,
      );
      if (!part) throw new Error("Gmail attachment part is unavailable.");
      return gmailPartBytes(
        client,
        message.id,
        part,
        limits.maxAttachmentBytes,
      );
    },
    // Mutation execution belongs to the durable command service/account authority.
    mutate,
    diagnostic: () => ({ transport: "gmail", status: "untested" }),
  });
}
