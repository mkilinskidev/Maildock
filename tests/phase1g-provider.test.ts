import { describe, expect, it } from "vitest";
import type { FetchMessageObject } from "imapflow";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type {
  ProviderImapAccount,
  RemoteMessageMetadata,
} from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  imap: {
    host: "imap.example.test",
    port: 993,
    security: "tls",
    username: "owner",
    credential: { kind: "password", password: "secret" },
  },
};

function provider(
  remote: number[],
  fetched: number[],
  uidNext: number,
  disappears = false,
) {
  const ranges: string[] = [];
  const factory: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => undefined,
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: 7n, uidNext }),
      mailboxClose: async () => true,
      logout: async () => undefined,
      close: () => undefined,
      download: async () => {
        throw new Error("body download forbidden");
      },
      search: async (query) => {
        const range = (query as unknown as { uid: string }).uid;
        ranges.push(range);
        if (range.includes(":")) {
          const [low, high] = range.split(":").map(Number);
          return remote.filter((uid) => uid >= low! && uid <= high!);
        }
        return disappears
          ? []
          : remote.filter((uid) => range.split(",").includes(String(uid)));
      },
      fetch: async function* (range, query) {
        expect(query).toMatchObject({
          envelope: true,
          bodyStructure: true,
          internalDate: true,
          size: true,
        });
        for (const uid of range.split(",").map(Number)) {
          if (!fetched.includes(uid)) continue;
          yield {
            seq: uid,
            uid,
            flags: new Set(),
            internalDate: new Date("2025-01-01"),
            size: 1,
            envelope: { subject: String(uid) },
          } as FetchMessageObject;
        }
      },
    }),
    createSmtp: () => ({
      verify: async () => undefined,
      close: () => undefined,
    }),
  };
  return { value: new ImapSmtpMailProvider(factory), ranges };
}

async function scan(
  remote: number[],
  fetched: number[],
  frontier: string | null,
  uidNext = 11,
  disappears = false,
) {
  const fake = provider(remote, fetched, uidNext, disappears);
  const chunks: { uids: string[]; next: string }[] = [];
  await fake.value.synchronizeBackfillMailbox(
    account,
    { remotePath: "INBOX", frontier, chunkSize: 4 },
    {
      selected: async (epoch) => expect(epoch).toBe("7"),
      chunk: async (messages: readonly RemoteMessageMetadata[], next) => {
        chunks.push({ uids: messages.map((m) => m.uid), next });
      },
    },
  );
  return { chunks, ranges: fake.ranges };
}

describe("Phase 1G IMAP UID traversal", () => {
  it("walks sparse ranges in bounded jobs and completes an empty mailbox", async () => {
    expect(await scan([1, 9], [1, 9], null)).toMatchObject({
      chunks: [{ uids: ["9"], next: "6" }],
      ranges: ["7:10"],
    });
    expect(await scan([1, 9], [1, 9], "6")).toMatchObject({
      chunks: [{ uids: [], next: "2" }],
    });
    expect(await scan([1, 9], [1, 9], "2")).toMatchObject({
      chunks: [{ uids: ["1"], next: "0" }],
    });
    expect(await scan([], [], null, 1)).toMatchObject({
      chunks: [{ uids: [], next: "0" }],
    });
  });

  it("rechecks SEARCH hits omitted by FETCH before advancing", async () => {
    expect(await scan([9], [], null, 11, true)).toMatchObject({
      chunks: [{ uids: [], next: "6" }],
      ranges: ["7:10", "9"],
    });
    const fake = provider([9], [], 11);
    await expect(
      fake.value.synchronizeBackfillMailbox(
        account,
        { remotePath: "INBOX", frontier: null, chunkSize: 4 },
        {
          selected: async () => undefined,
          chunk: async () => {
            throw new Error("advanced");
          },
        },
      ),
    ).rejects.toThrow();
    // A stable SEARCH hit remains unresolved, so no chunk was committed.
    expect(fake.ranges).toEqual(["7:10", "9"]);
  });
});
