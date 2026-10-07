import assert from "node:assert/strict";
import { ImapFlow } from "imapflow";
import { ImapSmtpMailProvider } from "../../src/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { MailProviderOperationError } from "../../src/modules/accounts/domain/mail-provider";

// A real ImapFlow EventEmitter in a separate process, with no global handlers.
const client = new ImapFlow({
  host: "unused.invalid",
  port: 993,
  logger: false,
});
let connected = false;
client.connect = async () => {
  connected = true;
};
client.list = async () => {
  assert(connected);
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      client.emit(
        "error",
        Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" }),
      );
      resolve();
    }),
  );
  return [];
};
client.logout = async () => {};
const provider = new ImapSmtpMailProvider({
  createImap: () => client,
  createSmtp: () => {
    throw new Error("Unexpected SMTP");
  },
});
await assert.rejects(
  provider.listMailboxes({
    accountId: "test",
    imap: {
      host: "unused.invalid",
      port: 993,
      security: "tls",
      username: "test",
      credential: { kind: "password", password: "test" },
    },
  }),
  MailProviderOperationError,
);
assert(client.isClosed);
console.log("operation failed safely; process survived");
