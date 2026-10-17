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

/** Fake client that logs every protocol step in order. */
function subBatchProvider(options: {
  remote: number[];
  uidNext: number;
  /** UIDs SEARCH reports but FETCH omits. */
  omitted?: number[];
  /** Omitted UIDs a recheck SEARCH still sees (never deleted). */
  stillPresent?: boolean;
  /** Throws on the nth FETCH (1-based) after one message. */
  failFetch?: number;
  reverse?: boolean;
}) {
  const log: string[] = [];
  let fetches = 0;
  const factory: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => undefined,
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: 7n, uidNext: options.uidNext }),
      mailboxClose: async () => {
        log.push("close");
        return true;
      },
      logout: async () => {
        log.push("logout");
      },
      close: () => undefined,
      download: async () => {
        throw new Error("body download forbidden");
      },
      search: async (query) => {
        const range = (query as unknown as { uid: string }).uid;
        log.push(`search ${range}`);
        if (range.includes(":")) {
          const [low, high] = range.split(":").map(Number);
          // Unordered SEARCH result.
          return options.remote
            .filter((uid) => uid >= low! && uid <= high!)
            .reverse();
        }
        return options.stillPresent ? range.split(",").map(Number) : [];
      },
      fetch: async function* (range) {
        fetches++;
        log.push(`fetch ${range}`);
        let uids = range
          .split(",")
          .map(Number)
          .filter((uid) => !options.omitted?.includes(uid));
        if (options.reverse) uids = uids.reverse();
        let sent = 0;
        for (const uid of uids) {
          if (options.failFetch === fetches && sent === 1)
            throw new Error("socket reset");
          sent++;
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
  return { value: new ImapSmtpMailProvider(factory), log };
}

async function subBatches(
  fake: ReturnType<typeof subBatchProvider>,
  frontier: string | null,
  yieldAfter: number | null,
  chunkSize = 10,
) {
  let asked = 0;
  await fake.value.synchronizeBackfillMailbox(
    account,
    { remotePath: "INBOX", frontier, chunkSize, subBatchSize: 3 },
    {
      selected: async () => undefined,
      chunk: async (messages, next) => {
        fake.log.push(
          `commit ${messages.map((m) => m.uid).join(",")} -> ${next}`,
        );
      },
      shouldYield: async () => {
        asked++;
        fake.log.push("check");
        return yieldAfter !== null && asked >= yieldAfter;
      },
    },
  );
  return fake.log;
}

describe("Stage 3 cooperative history sub-batches", () => {
  it("walks disjoint descending sub-ranges and checks only between commits", async () => {
    const fake = subBatchProvider({
      remote: [1, 2, 4, 5, 6, 8, 9, 10],
      uidNext: 11,
    });
    expect(await subBatches(fake, null, null)).toEqual([
      "search 8:10",
      "fetch 10,9,8",
      "commit 10,9,8 -> 7",
      "check",
      "search 5:7",
      "fetch 6,5",
      "commit 6,5 -> 4",
      "check",
      "search 2:4",
      "fetch 4,2",
      "commit 4,2 -> 1",
      "check",
      "search 1:1",
      "fetch 1",
      // Frontier 0: complete, no check after the last sub-range.
      "commit 1 -> 0",
      "close",
      "logout",
    ]);
  });

  it("yields after the committed sub-batch and never starts the next FETCH", async () => {
    const fake = subBatchProvider({ remote: [1, 5, 9], uidNext: 11 });
    expect(await subBatches(fake, null, 1)).toEqual([
      "search 8:10",
      "fetch 9",
      "commit 9 -> 7",
      "check",
      // Regular end: mailbox closed and session logged out, no teardown.
      "close",
      "logout",
    ]);
  });

  it("stays inside the job range and advances empty sub-ranges", async () => {
    const fake = subBatchProvider({ remote: [2], uidNext: 1 });
    expect(await subBatches(fake, "20", null, 5)).toEqual([
      "search 18:20",
      "commit  -> 17",
      "check",
      "search 16:17",
      // The job range [16, 20] is done: no check, the worker continues.
      "commit  -> 15",
      "close",
      "logout",
    ]);
  });

  it("commits unordered FETCH responses completely", async () => {
    const fake = subBatchProvider({
      remote: [3, 7, 8],
      uidNext: 9,
      reverse: true,
    });
    const log = await subBatches(fake, null, null);
    expect(log.filter((line) => line.startsWith("commit"))).toEqual([
      "commit 7,8 -> 5",
      "commit 3 -> 2",
      "commit  -> 0",
    ]);
  });

  it("skips a UID deleted during FETCH but blocks on one still present", async () => {
    const deleted = subBatchProvider({
      remote: [8, 9, 10],
      uidNext: 11,
      omitted: [9],
    });
    expect((await subBatches(deleted, null, 1)).slice(0, 4)).toEqual([
      "search 8:10",
      "fetch 10,9,8",
      "search 9",
      "commit 10,8 -> 7",
    ]);
    const present = subBatchProvider({
      remote: [1, 2, 3, 8, 9, 10],
      uidNext: 11,
      omitted: [2],
      stillPresent: true,
    });
    await expect(subBatches(present, null, null)).rejects.toThrow();
    // The first sub-range stays committed; the incomplete one never is.
    expect(present.log.filter((line) => line.startsWith("commit"))).toEqual([
      "commit 10,9,8 -> 7",
      "commit  -> 4",
    ]);
  });

  it("a FETCH failure commits nothing of its sub-range", async () => {
    const fake = subBatchProvider({
      remote: [4, 5, 6, 8, 9, 10],
      uidNext: 11,
      failFetch: 2,
    });
    await expect(subBatches(fake, null, null)).rejects.toThrow();
    expect(fake.log.filter((line) => line.startsWith("commit"))).toEqual([
      "commit 10,9,8 -> 7",
    ]);
    expect(fake.log.slice(-2)).toEqual(["close", "logout"]);
  });
});
