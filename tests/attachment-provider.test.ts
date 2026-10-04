import { describe, expect, it, vi } from "vitest";
import type { MessageStructureObject } from "imapflow";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "owner",
  imap: {
    host: "imap.example.test",
    port: 993,
    security: "tls",
    username: "owner",
    credential: { kind: "password", password: "secret" },
  },
};
const request = {
  remotePath: "INBOX",
  uid: "42",
  expectedUidValidity: "7",
  partId: "2",
  maxBytes: 1024,
};
function setup(
  epoch = 7n,
  bytes = Buffer.from([0, 255, 128, 61]),
  validPart = true,
) {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain" },
      {
        part: "2",
        type: "text/plain",
        parameters: { charset: "iso-8859-2", name: "text.txt" },
        disposition: validPart ? "attachment" : undefined,
        dispositionParameters: validPart ? { filename: "text.txt" } : {},
        encoding: "base64",
        size: 100,
      },
    ],
  } as MessageStructureObject;
  if (!validPart) structure.childNodes![1].parameters = {};
  const fetchOne = vi.fn(
    async (
      _uid: string,
      query: {
        bodyStructure?: boolean;
        bodyParts?: (
          string | { key: string; start: number; maxLength: number }
        )[];
      },
    ) => {
      if (query.bodyStructure)
        return { uid: 42, seq: 999, bodyStructure: structure };
      const spec = query.bodyParts?.[0] as {
        key: string;
        start: number;
        maxLength: number;
      };
      const encoded = Buffer.from(bytes.toString("base64"));
      return {
        uid: 42,
        seq: 999,
        bodyParts: new Map([
          [
            spec.key.toLowerCase(),
            encoded.subarray(spec.start, spec.start + spec.maxLength),
          ],
        ]),
      };
    },
  );
  const download = vi.fn();
  const close = vi.fn();
  const factories: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {},
      logout: async () => {},
      close,
      list: async () => [],
      search: async () => [],
      fetch: async function* () {},
      fetchOne,
      download,
      mailboxOpen: async () => ({ uidValidity: epoch }),
      mailboxClose: async () => true,
    }),
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  return {
    provider: new ImapSmtpMailProvider(factories),
    fetchOne,
    download,
    close,
  };
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe("selective attachment provider", () => {
  it("checks remote MIME membership and uses exact UID/part with bounded BODY fetches, preserving text file bytes", async () => {
    const bytes = Buffer.from([0, 255, 128, 61]);
    const state = setup(7n, bytes);
    expect(
      await state.provider.fetchAttachment(account, request, collect),
    ).toEqual(bytes);
    expect(state.fetchOne.mock.calls).toEqual([
      ["42", { uid: true, bodyStructure: true }, { uid: true }],
      [
        "42",
        { uid: true, bodyParts: [{ key: "2", start: 0, maxLength: 65536 }] },
        { uid: true },
      ],
    ]);
    expect(state.download).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("rejects UIDVALIDITY mismatch before fetching MIME or bytes", async () => {
    const state = setup(8n);
    await expect(
      state.provider.fetchAttachment(account, request, collect),
    ).rejects.toThrow("UIDVALIDITY");
    expect(state.fetchOne).not.toHaveBeenCalled();
  });
  it("rejects ordinary body parts instead of downloading them as attachments", async () => {
    const state = setup(7n, Buffer.from("x"), false);
    await expect(
      state.provider.fetchAttachment(account, request, collect),
    ).rejects.toThrow("not an attachment");
    expect(state.fetchOne).toHaveBeenCalledOnce();
  });
  it("rejects actual remote byte overflow", async () => {
    const state = setup(7n, Buffer.alloc(1025));
    await expect(
      state.provider.fetchAttachment(account, request, collect),
    ).rejects.toThrow("size limit");
    expect(state.close).toHaveBeenCalledOnce();
  });
  it.each(["0", "-1", "4294967296", "1:42"])(
    "rejects invalid UID %s",
    async (uid) => {
      const state = setup();
      await expect(
        state.provider.fetchAttachment(account, { ...request, uid }, collect),
      ).rejects.toThrow();
      expect(state.fetchOne).not.toHaveBeenCalled();
    },
  );
  it("closes the adapter when storage consumption fails", async () => {
    const state = setup();
    await expect(
      state.provider.fetchAttachment(account, request, async () => {
        throw Error("storage unavailable");
      }),
    ).rejects.toThrow("storage unavailable");
    expect(state.close).toHaveBeenCalledOnce();
  });
});
