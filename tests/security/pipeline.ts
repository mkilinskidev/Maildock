import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "../../src/modules/accounts/infrastructure/imap-smtp-mail-provider";
import { sanitizeEmailHtml } from "../../src/modules/mail/infrastructure/sanitize-email-html";

/** MIME decoding is a fixture adapter for ImapFlow's already-decoded download
 * stream. Everything after that transport seam is the production implementation.
 * skipImageLinks is essential: mailparser must not pre-resolve CID resources. */
export async function parseFixture(mime: string) {
  const parsed = await simpleParser(mime, {
    skipImageLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
  });
  const factories: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {},
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: 7n }),
      mailboxClose: async () => true,
      search: async () => [],
      fetch: async function* () {},
      download: async () => ({
        meta: { charset: "utf-8", contentType: "text/html" },
        content: Readable.from([Buffer.from(parsed.html || "")]),
      }),
      logout: async () => {},
      close: () => {},
    }),
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  const result = await new ImapSmtpMailProvider(factories).fetchMessageContent(
    {
      accountId: "fixture",
      imap: {
        host: "unused.test",
        port: 993,
        security: "tls",
        username: "fixture",
        credential: { kind: "password", password: "unused" },
      },
    },
    {
      remotePath: "INBOX",
      uid: "42",
      expectedUidValidity: "7",
      parts: [{ part: "1", type: "text/html" }],
      maxPartBytes: 1024 * 1024,
    },
  );
  return { parsed, clean: sanitizeEmailHtml(result.html ?? "") };
}
