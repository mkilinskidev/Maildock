import { describe, expect, it } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
  type ProviderImapAccount,
} from "@/modules/accounts/domain/mail-provider";
import type { FetchMessageObject } from "imapflow";

const account: ProviderImapAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  imap: {
    host: "imap.test",
    port: 993,
    security: "tls",
    username: "a",
    credential: { kind: "password", password: "x" },
  },
};
function setup(
  options: {
    epoch?: bigint;
    exists?: boolean;
    move?: boolean;
    fail?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const factory: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(
        options.move === false
          ? []
          : [
              ["MOVE", true],
              ["CONDSTORE", true],
            ],
      ),
      enabled: new Set(["CONDSTORE"]),
      connect: async () => {},
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: options.epoch ?? 7n }),
      mailboxClose: async () => true,
      logout: async () => {},
      close: () => {},
      download: async () => {
        throw Error("Unexpected download");
      },
      search: async () => [],
      fetch: async function* () {},
      fetchOne: async () =>
        options.exists === false
          ? false
          : ({ uid: 42, flags: new Set(), modseq: 3n } as FetchMessageObject),
      messageFlagsAdd: async (_range, flags, store) => {
        calls.push(`add ${flags[0]} ${String(store.unchangedSince)}`);
        return !options.fail;
      },
      messageFlagsRemove: async (_range, flags) => {
        calls.push(`remove ${flags[0]}`);
        return !options.fail;
      },
      messageMove: async (_range, destination) => {
        calls.push(`move ${destination}`);
        return options.fail
          ? false
          : { uidValidity: 9n, uidMap: new Map([[42, 101]]) };
      },
    }),
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  return { provider: new ImapSmtpMailProvider(factory), calls };
}
const base = { sourcePath: "INBOX", uidValidity: "7", uid: "42" } as const;

describe("message mutation adapter", () => {
  it("does not misclassify a false library result as a MODIFIED conflict", async () => {
    const { provider, calls } = setup({ fail: true });
    await expect(
      provider.mutateMessage(account, {
        ...base,
        action: "mark_read",
        modseq: "3",
      }),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
    expect(calls).toEqual(["add \\Seen 3"]);
  });
  it.each([
    ["mark_read", "add \\Seen 3"],
    ["mark_unread", "remove \\Seen"],
    ["flag", "add \\Flagged 3"],
    ["unflag", "remove \\Flagged"],
  ] as const)("applies %s by UID", async (action, expected) => {
    const { provider, calls } = setup();
    expect(
      await provider.mutateMessage(account, { ...base, action, modseq: "3" }),
    ).toEqual({ outcome: "applied" });
    expect(calls).toEqual([expected]);
  });
  it("rejects an epoch change before STORE or MOVE", async () => {
    const { provider, calls } = setup({ epoch: 8n });
    await expect(
      provider.mutateMessage(account, {
        ...base,
        action: "trash",
        destinationPath: "Bin",
      }),
    ).rejects.toBeInstanceOf(MailboxEpochChangedError);
    expect(calls).toEqual([]);
  });
  it("captures COPYUID mapping from native MOVE", async () => {
    const { provider, calls } = setup();
    expect(
      await provider.mutateMessage(account, {
        ...base,
        action: "archive",
        destinationPath: "Saved",
      }),
    ).toEqual({
      outcome: "applied",
      destinationUidValidity: "9",
      destinationUid: "101",
    });
    expect(calls).toEqual(["move Saved"]);
  });
  it("does not infer success or issue MOVE when the source UID is gone", async () => {
    const { provider, calls } = setup({ exists: false });
    expect(
      await provider.mutateMessage(account, {
        ...base,
        action: "trash",
        destinationPath: "Bin",
      }),
    ).toEqual({ outcome: "source_missing" });
    expect(calls).toEqual([]);
  });
});
