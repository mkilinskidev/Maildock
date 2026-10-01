import { describe, expect, it, vi } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "owner",
  imap: {
    host: "imap.example.com",
    port: 993,
    security: "tls",
    username: "owner",
    credential: { kind: "password", password: "private" },
  },
};
const mime = Buffer.from(
  "Message-ID: <ours@maildock.invalid>\r\n\r\nExact UTF-8 żółć\r\n",
);
const request = {
  remotePath: "custom/output",
  flags: ["\\Seen"],
  internalDate: new Date("2026-01-01T12:00:00Z"),
};
function fixture() {
  const client = {
    connect: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => ({ uidValidity: 9n })),
    append: vi.fn<
      (
        path: string,
        raw: Buffer,
        flags: string[],
        date: Date,
      ) => Promise<{ uidValidity?: bigint; uid?: number }>
    >(async () => ({ uidValidity: 9n, uid: 42 })),
    search: vi.fn(async () => [1, 2]),
    fetchOne: vi.fn(async (uid: string | number) => ({
      uid: Number(uid),
      flags: new Set<string>(),
      envelope: {
        messageId:
          Number(uid) === 2
            ? "<ours@maildock.invalid>"
            : "<ours@maildock.invalid>.unrelated",
      },
    })),
    logout: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const provider = new ImapSmtpMailProvider({
    createImap: () => client,
  } as unknown as ProtocolClientFactories);
  return { client, provider };
}
describe("Sent-copy provider boundary", () => {
  it("APPENDs the exact Buffer with Seen and original internal date", async () => {
    const { client, provider } = fixture();
    expect(await provider.appendMessage(account, request, mime)).toEqual({
      outcome: "saved",
      uidValidity: "9",
      uid: "42",
    });
    expect(client.append).toHaveBeenCalledExactlyOnceWith(
      request.remotePath,
      mime,
      request.flags,
      request.internalDate,
    );
    expect(client.append.mock.calls[0][1]).toBe(mime);
  });
  it("does not invent identity without APPENDUID", async () => {
    const { client, provider } = fixture();
    client.append.mockResolvedValue({} as never);
    expect(await provider.appendMessage(account, request, mime)).toEqual({
      outcome: "saved",
      uidValidity: undefined,
      uid: undefined,
    });
  });
  it.each(["connect", "mailboxOpen"] as const)(
    "fails before APPEND at %s without leaking errors",
    async (stage) => {
      const { client, provider } = fixture();
      client[stage].mockRejectedValue(new Error("private body credentials"));
      expect(await provider.appendMessage(account, request, mime)).toEqual({
        outcome: "failed",
      });
      expect(client.append).not.toHaveBeenCalled();
    },
  );
  it("classifies every unproven post-entry APPEND exception as uncertain", async () => {
    const { client, provider } = fixture();
    client.append.mockRejectedValue(
      Object.assign(new Error("private"), { responseStatus: "NO" }),
    );
    expect(await provider.appendMessage(account, request, mime)).toEqual({
      outcome: "uncertain",
    });
    expect(client.append).toHaveBeenCalledOnce();
  });
  it("does not revoke acceptance because cleanup fails", async () => {
    const { client, provider } = fixture();
    client.logout.mockRejectedValue(new Error("closed"));
    client.close.mockImplementation(() => {
      throw new Error("closed");
    });
    expect(await provider.appendMessage(account, request, mime)).toMatchObject({
      outcome: "saved",
    });
  });
  it("verifies exact Message-ID after substring SEARCH and retains actual UID identity", async () => {
    const { client, provider } = fixture();
    expect(
      await provider.findSentCopy(
        account,
        request.remotePath,
        "<ours@maildock.invalid>",
      ),
    ).toEqual({ outcome: "found", uidValidity: "9", uid: "2" });
    expect(client.search).toHaveBeenCalledWith(
      { header: { "Message-ID": "<ours@maildock.invalid>" } },
      { uid: true },
    );
    expect(client.fetchOne).toHaveBeenCalledTimes(2);
  });
  it("does not treat an unrelated substring match as proof", async () => {
    const { client, provider } = fixture();
    client.search.mockResolvedValue([1]);
    expect(
      await provider.findSentCopy(
        account,
        request.remotePath,
        "<ours@maildock.invalid>",
      ),
    ).toEqual({ outcome: "not_found" });
  });
  it("treats failed search or excessive matches as uncertain", async () => {
    const { client, provider } = fixture();
    client.search.mockRejectedValueOnce(new Error("unavailable"));
    expect(
      await provider.findSentCopy(
        account,
        request.remotePath,
        "<ours@maildock.invalid>",
      ),
    ).toEqual({ outcome: "uncertain" });
    client.search.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
    expect(
      await provider.findSentCopy(
        account,
        request.remotePath,
        "<ours@maildock.invalid>",
      ),
    ).toEqual({ outcome: "uncertain" });
    expect(client.fetchOne).not.toHaveBeenCalled();
  });
});
