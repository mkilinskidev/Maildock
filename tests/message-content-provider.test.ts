import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "a",
  imap: {
    host: "example.test",
    port: 993,
    security: "tls",
    username: "u",
    credential: { kind: "password", password: "secret" },
  },
};
const parts = [
  { part: "1.1", type: "text/plain" as const },
  { part: "1.2", type: "text/html" as const },
];
function setup(
  uidValidity = 7n,
  content = Buffer.from("Zażółć gęślą jaźń"),
  charset = "utf-8",
) {
  const downloads: unknown[][] = [];
  const events: string[] = [];
  const factories: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {
        events.push("connect");
      },
      list: async () => [],
      mailboxOpen: async (path, options) => {
        events.push(`open:${path}:${options.readOnly}`);
        return { uidValidity };
      },
      mailboxClose: async () => {
        events.push("mailboxClose");
        return true;
      },
      search: async () => [],
      fetch: async function* () {},
      download: async (uid, part, options) => {
        downloads.push([uid, part, options]);
        return {
          meta: {
            charset,
            encoding: "quoted-printable",
            contentType: part === "1.1" ? "text/plain" : "text/html",
          },
          content: Readable.from([content]),
        };
      },
      logout: async () => {
        events.push("logout");
      },
      close: () => {
        events.push("close");
      },
    }),
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  return { provider: new ImapSmtpMailProvider(factories), downloads, events };
}
const request = {
  remotePath: "INBOX",
  uid: "42",
  expectedUidValidity: "7",
  parts,
  maxPartBytes: 1024,
};

describe("selective content provider", () => {
  it("opens read-only, verifies UIDVALIDITY, downloads only selected UID parts, and closes", async () => {
    const state = setup();
    const result = await state.provider.fetchMessageContent(account, request);
    expect(result.plainText).toBe("Zażółć gęślą jaźń");
    expect(state.downloads).toEqual([
      [42, "1.1", { uid: true, maxBytes: 1025 }],
      [42, "1.2", { uid: true, maxBytes: 1025 }],
    ]);
    expect(state.events).toEqual([
      "connect",
      "open:INBOX:true",
      "mailboxClose",
      "logout",
      "close",
    ]);
  });
  it("rejects stale UIDVALIDITY without downloading", async () => {
    const state = setup(8n);
    await expect(
      state.provider.fetchMessageContent(account, request),
    ).rejects.toThrow();
    expect(state.downloads).toEqual([]);
    expect(state.events).toContain("close");
  });
  it("rejects parts over the byte limit and closes", async () => {
    const state = setup(7n, Buffer.alloc(1025));
    await expect(
      state.provider.fetchMessageContent(account, request),
    ).rejects.toThrow();
    expect(state.events).toContain("mailboxClose");
  });
  it("rejects an unknown charset rather than treating undecoded bytes as UTF-8", async () => {
    const state = setup(7n, Buffer.from([0xe9]), "unknown-legacy-charset");
    await expect(
      state.provider.fetchMessageContent(account, request),
    ).rejects.toThrow();
    expect(state.events).toContain("close");
  });
});
