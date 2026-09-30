import { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

/** Exercise the installed ImapFlow 2.0.6 download pipeline without a network server. */
async function downloadFixture(
  bytes: Buffer,
  charset: string | null,
  transfer: "base64" | "quoted-printable" = "base64",
  maxBytes = 1024,
) {
  const part = "1.1";
  const encoded = Buffer.from(
    transfer === "base64"
      ? bytes.toString("base64")
      : [...bytes]
          .map((byte) => `=${byte.toString(16).padStart(2, "0")}`)
          .join(""),
    "ascii",
  );
  const headers = Buffer.from(
    `Content-Type: text/plain${charset ? `; charset=${charset}` : ""}\r\nContent-Transfer-Encoding: ${transfer}\r\n\r\n`,
    "ascii",
  );
  const queried: unknown[] = [];
  const fake = {
    mailbox: {},
    id: "charset-test",
    log: { warn: () => {}, error: () => {} },
    _openDownloads: 0,
    autoidle: () => {},
    fetchOne: async (uid: number, query: unknown, options: unknown) => {
      queried.push({ uid, query, options });
      return {
        uid: 42,
        size: encoded.length,
        bodyParts: new Map([
          [part, encoded],
          [`${part}.mime`, headers],
        ]),
      };
    },
  };
  const result = await ImapFlow.prototype.download.call(
    fake as unknown as ImapFlow,
    42,
    part,
    { uid: true, maxBytes },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of result.content) chunks.push(Buffer.from(chunk));
  return { meta: result.meta, content: Buffer.concat(chunks), queried };
}

async function throughMaildock(
  result: Awaited<ReturnType<typeof downloadFixture>>,
) {
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
        meta: result.meta,
        content: Readable.from([result.content]),
      }),
      logout: async () => {},
      close: () => {},
    }),
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  const account: ProviderImapAccount = {
    accountId: "test",
    imap: {
      host: "example.test",
      port: 993,
      security: "tls",
      username: "owner",
      credential: { kind: "password", password: "secret" },
    },
  };
  return new ImapSmtpMailProvider(factories).fetchMessageContent(account, {
    remotePath: "INBOX",
    uid: "42",
    expectedUidValidity: "7",
    parts: [{ part: "1.1", type: "text/plain" }],
    maxPartBytes: 1024,
  });
}

describe("installed ImapFlow download charset contract", () => {
  it.each([
    ["utf-8", "5a61c5bcc3b3c582c487", "Zażółć"],
    ["windows-1250", "5a61bff3b3e6", "Zażółć"],
    ["windows-1252", "636166e92080", "café €"],
    ["iso-8859-1", "636166e9", "café"],
    ["iso-8859-2", "5a61bff3b3e6", "Zażółć"],
    ["iso-8859-15", "636166e920a4", "café €"],
  ] as const)(
    "converts %s to UTF-8 and updates metadata",
    async (charset, hex, expected) => {
      const result = await downloadFixture(Buffer.from(hex, "hex"), charset);
      expect(result.meta.charset).toBe("utf-8");
      expect(result.content.toString("utf8")).toBe(expected);
      expect((await throughMaildock(result)).plainText).toBe(expected);
      expect(result.queried).toHaveLength(1);
      expect(result.queried[0]).toMatchObject({
        uid: 42,
        options: { uid: true },
      });
    },
  );

  it("transfer-decodes quoted-printable exactly once", async () => {
    const result = await downloadFixture(
      Buffer.from("Zażółć", "utf8"),
      "utf-8",
      "quoted-printable",
    );
    expect(result.content.toString("utf8")).toBe("Zażółć");
    expect((await throughMaildock(result)).plainText).toBe("Zażółć");
  });

  it.each(["x-unknown-charset", "x-malformed-charset@@@"])(
    "leaves bytes and original metadata unchanged when charset %s is unsupported",
    async (charset) => {
      const result = await downloadFixture(Buffer.from([0xe9]), charset);
      expect(result.meta.charset).toBe(charset);
      expect(result.content).toEqual(Buffer.from([0xe9]));
      await expect(throughMaildock(result)).rejects.toThrow(
        "Unsupported message charset.",
      );
    },
  );

  it("leaves missing-charset bytes as-is", async () => {
    const result = await downloadFixture(Buffer.from([0xe9]), null);
    expect(result.meta.charset).toBeUndefined();
    expect(result.content).toEqual(Buffer.from([0xe9]));
    await expect(throughMaildock(result)).rejects.toThrow("not valid UTF-8");
  });

  it("rejects malformed UTF-8 even when declared UTF-8", async () => {
    const result = await downloadFixture(Buffer.from([0xc3, 0x28]), "utf-8");
    await expect(throughMaildock(result)).rejects.toThrow("not valid UTF-8");
  });
});
