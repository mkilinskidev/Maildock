import { describe, expect, it } from "vitest";

import {
  ImapSmtpMailProvider,
  imapOptions,
  normalizeCapabilities,
  normalizeMailbox,
  normalizeEnvelope,
  normalizeMessage,
  normalizeMimeStructure,
  smtpOptions,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderAccount } from "@/modules/accounts/domain/mail-provider";
import type { ListResponse } from "imapflow";

const account: ProviderAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  imap: {
    host: "imap.example.test",
    port: 993,
    security: "tls",
    username: "owner",
    password: "imap-secret",
  },
  smtp: {
    host: "smtp.example.test",
    port: 587,
    security: "starttls",
    username: "owner",
    password: "smtp-secret",
  },
};

function factories(input?: {
  imapError?: Error & { code?: string };
  smtpError?: Error & { code?: string };
}) {
  const state = { imapClosed: 0, smtpClosed: 0 };
  const value: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {
        if (input?.imapError) throw input.imapError;
      },
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: 1n }),
      mailboxClose: async () => true,
      search: async () => [],
      fetch: async function* () {},
      download: async () => {
        throw new Error("Unexpected download");
      },
      logout: async () => undefined,
      close: () => {
        state.imapClosed += 1;
      },
    }),
    createSmtp: () => ({
      verify: async () => {
        if (input?.smtpError) throw input.smtpError;
      },
      close: () => {
        state.smtpClosed += 1;
      },
    }),
  };
  return { value, state };
}

describe("IMAP/SMTP connection provider", () => {
  it("returns separate successful results and closes both resources", async () => {
    const fake = factories();
    await expect(
      new ImapSmtpMailProvider(fake.value).testConnection(account),
    ).resolves.toEqual({ imap: { success: true }, smtp: { success: true } });
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("represents IMAP failure and SMTP success separately without raw errors", async () => {
    const error = Object.assign(
      new Error("login rejected with secret imap-secret"),
      { code: "EAUTH" },
    );
    const fake = factories({ imapError: error });
    const result = await new ImapSmtpMailProvider(fake.value).testConnection(
      account,
    );
    expect(result.imap).toEqual({
      success: false,
      category: "authentication_rejected",
      message: "IMAP authentication was rejected.",
    });
    expect(result.smtp).toEqual({ success: true });
    expect(JSON.stringify(result)).not.toContain("imap-secret");
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("represents IMAP success and SMTP failure separately and cleans up", async () => {
    const error = Object.assign(new Error("socket timed out smtp-secret"), {
      code: "ETIMEDOUT",
    });
    const fake = factories({ smtpError: error });
    const result = await new ImapSmtpMailProvider(fake.value).testConnection(
      account,
    );
    expect(result.imap).toEqual({ success: true });
    expect(result.smtp).toMatchObject({
      success: false,
      category: "connection_timeout",
    });
    expect(JSON.stringify(result)).not.toContain("smtp-secret");
    expect(fake.state).toEqual({ imapClosed: 1, smtpClosed: 1 });
  });

  it("maps implicit TLS and required STARTTLS without disabling certificate checks", () => {
    const implicit = imapOptions(account.imap);
    const starttls = smtpOptions(account.smtp);
    expect(implicit).toMatchObject({
      secure: true,
      doSTARTTLS: false,
      tls: { rejectUnauthorized: true },
    });
    expect(starttls).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      tls: { rejectUnauthorized: true },
    });
  });
});

function listed(
  input: Partial<ListResponse> & Pick<ListResponse, "path" | "name">,
): ListResponse {
  return {
    pathAsListed: input.path,
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set(),
    listed: true,
    subscribed: true,
    ...input,
  };
}

describe("IMAP mailbox normalization", () => {
  it("normalizes INBOX and status observations without using Recent", () => {
    expect(
      normalizeMailbox(
        listed({
          path: "INBOX",
          name: "INBOX",
          flags: new Set(["\\HasNoChildren"]),
          status: {
            path: "INBOX",
            messages: 1284,
            unseen: 12,
            recent: 99,
            uidNext: 2000,
            uidValidity: 4294967295n,
          },
        }),
      ),
    ).toEqual({
      remotePath: "INBOX",
      name: "INBOX",
      delimiter: "/",
      attributes: ["\\HasNoChildren"],
      selectable: true,
      specialUse: ["\\Inbox"],
      messageCount: "1284",
      unseenCount: "12",
      uidValidity: "4294967295",
      uidNext: "2000",
    });
  });

  it("preserves a non-slash hierarchy delimiter, Noselect, and unknown attributes", () => {
    const result = normalizeMailbox(
      listed({
        path: "Archive.2025",
        name: "2025",
        delimiter: ".",
        flags: new Set(["\\Noselect", "\\VendorExtension"]),
        subscribed: false,
      }),
    );
    expect(result).toMatchObject({
      remotePath: "Archive.2025",
      delimiter: ".",
      selectable: false,
      attributes: ["\\Noselect", "\\VendorExtension"],
      subscribed: false,
    });
  });

  it("keeps server SPECIAL-USE and ignores name-derived folder heuristics", () => {
    expect(
      normalizeMailbox(
        listed({
          path: "Localized",
          name: "Localized",
          flags: new Set(["\\Sent", "\\XCustom"]),
          specialUse: "\\Sent",
          specialUseSource: "extension",
        }),
      ).specialUse,
    ).toEqual(["\\Sent"]);
    expect(
      normalizeMailbox(
        listed({
          path: "Sent by name only",
          name: "Sent by name only",
          specialUse: "\\Sent",
          specialUseSource: "name",
        }),
      ).specialUse,
    ).toEqual([]);
  });

  it("allows missing status and preserves large MODSEQ values exactly", () => {
    expect(
      normalizeMailbox(listed({ path: "Empty", name: "Empty" })),
    ).not.toHaveProperty("uidValidity");
    expect(
      normalizeMailbox(
        listed({
          path: "Large",
          name: "Large",
          status: {
            path: "Large",
            highestModseq: 18_446_744_073_709_551_615n,
          },
        }),
      ).highestModseq,
    ).toBe("18446744073709551615");
  });

  it("captures only synchronization-relevant capabilities", () => {
    expect(
      normalizeCapabilities(
        ["IMAP4rev2", "IDLE", "MOVE", "AUTH=PLAIN", "LIST-STATUS"],
        ["CONDSTORE", "QRESYNC"],
      ),
    ).toEqual([
      "IMAP4REV2",
      "IDLE",
      "CONDSTORE",
      "QRESYNC",
      "MOVE",
      "LIST-STATUS",
    ]);
  });
});

describe("Phase 1C metadata normalization", () => {
  it("normalizes missing envelope fields and multiple addresses defensively", () => {
    expect(
      normalizeEnvelope({
        subject: "Hello",
        from: [
          { name: "Ania", address: "ania@example.test" },
          { address: "other@example.test" },
        ],
        to: [{ name: "Owner" }],
      }),
    ).toEqual({
      subject: "Hello",
      from: [
        { name: "Ania", address: "ania@example.test" },
        { address: "other@example.test" },
      ],
      sender: [],
      replyTo: [],
      to: [{ name: "Owner" }],
      cc: [],
      bcc: [],
    });
    expect(normalizeEnvelope()).toEqual({
      from: [],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
    });
  });

  it("normalizes BODYSTRUCTURE and conservatively detects attachment metadata", () => {
    const structure = normalizeMimeStructure({
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "text/plain",
          parameters: { charset: "utf-8" },
          size: 20,
        },
        {
          part: "2",
          type: "image/png",
          disposition: "inline",
          id: "logo",
          size: 30,
        },
        {
          part: "3",
          type: "application/pdf",
          disposition: "attachment",
          dispositionParameters: { filename: "invoice.pdf" },
          encoding: "base64",
          size: 40,
        },
      ],
    });
    expect(structure.children[0]).toMatchObject({
      part: "1",
      type: "text/plain",
      size: "20",
      filename: null,
    });
    expect(structure.children[1]).toMatchObject({
      disposition: "inline",
      filename: null,
    });
    expect(structure.children[2]).toMatchObject({
      disposition: "attachment",
      filename: "invoice.pdf",
    });
    expect(
      normalizeMessage({
        seq: 99,
        uid: 42,
        modseq: 18_446_744_073_709_551_615n,
        emailId: "provider-object",
        internalDate: new Date("2026-09-20T10:00:00Z"),
        size: 123,
        flags: new Set(["custom", "\\Seen"]),
        envelope: { messageId: "duplicate@example.test" },
        bodyStructure: {
          type: "application/pdf",
          parameters: { name: "file.pdf" },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        uid: "42",
        modseq: "18446744073709551615",
        providerEmailId: "provider-object",
        size: "123",
        flags: ["\\Seen", "custom"],
        hasAttachments: true,
      }),
    );
    expect(
      JSON.stringify(
        normalizeMessage({
          seq: 1234,
          uid: 7,
          internalDate: new Date(),
          size: 1,
        }),
      ),
    ).not.toContain("1234");
  });

  it("searches with UID and fetches explicit metadata in bounded batches without body fields", async () => {
    const fetchQueries: unknown[] = [];
    const ranges: string[] = [];
    const batches: number[] = [];
    const fake: ProtocolClientFactories = {
      createImap: () => ({
        capabilities: new Map(),
        enabled: new Set(),
        connect: async () => undefined,
        list: async () => [],
        mailboxOpen: async (_path, options) => {
          expect(options).toEqual({ readOnly: true });
          return { uidValidity: 77n };
        },
        mailboxClose: async () => true,
        search: async (query, options) => {
          expect(query.since).toEqual(new Date("2026-08-25T00:00:00Z"));
          expect(options).toEqual({ uid: true });
          return [1, 2, 3, 4, 5];
        },
        fetch: async function* (range, query, options) {
          ranges.push(range);
          fetchQueries.push(query);
          expect(options).toEqual({ uid: true });
          for (const uid of range.split(",").map(Number))
            yield {
              seq: uid + 100,
              uid,
              internalDate: new Date("2026-09-01T00:00:00Z"),
              size: 10,
            };
        },
        download: async () => {
          throw new Error("Unexpected download");
        },
        logout: async () => undefined,
        close: () => undefined,
      }),
      createSmtp: () => ({
        verify: async () => undefined,
        close: () => undefined,
      }),
    };
    const provider = new ImapSmtpMailProvider(fake);
    const result = await provider.synchronizeRecentMailbox(
      account,
      {
        remotePath: "INBOX",
        cutoff: new Date("2026-08-25T00:00:00Z"),
        batchSize: 2,
      },
      {
        selected: async (uidValidity) => expect(uidValidity).toBe("77"),
        batch: async (items) => {
          batches.push(items.length);
        },
      },
    );
    expect(result).toEqual({ uidValidity: "77", messageCount: 5 });
    expect(ranges).toEqual(["1,2", "3,4", "5"]);
    expect(batches).toEqual([2, 2, 1]);
    expect(fetchQueries).toEqual(
      Array(3).fill({
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        size: true,
      }),
    );
    for (const query of fetchQueries) {
      expect(query).not.toHaveProperty("source");
      expect(query).not.toHaveProperty("headers");
      expect(query).not.toHaveProperty("bodyParts");
    }
  });
});
