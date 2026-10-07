import { describe, expect, it } from "vitest";
import type { FetchMessageObject } from "imapflow";

import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type {
  DeltaMailboxSnapshot,
  DeltaMailboxSyncSink,
  ProviderImapAccount,
  RemoteFlagDelta,
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

type Script = {
  remote?: number[];
  fetched?: number[];
  recent?: number[];
  flags?: Record<number, { flags: string[]; modseq?: bigint }>;
  epoch?: bigint;
  uidNext?: number;
  selectModseq?: bigint;
  statusModseq?: bigint;
  condstore?: boolean;
  failFetch?: string;
  failSearch?: string;
};

function harness(script: Script = {}) {
  const calls: {
    searches: unknown[];
    fetches: { range: string; query: unknown; options: unknown }[];
  } = {
    searches: [],
    fetches: [],
  };
  const remote = script.remote ?? [];
  const fetched = script.fetched ?? remote;
  const fake: ProtocolClientFactories = {
    createImap: () => ({
      capabilities: new Map(script.condstore ? [["CONDSTORE", true]] : []),
      enabled: new Set(),
      connect: async () => undefined,
      list: async () => [],
      mailboxOpen: async () => ({
        uidValidity: script.epoch ?? 10n,
        uidNext: script.uidNext ?? Math.max(1, ...remote) + 1,
        exists: remote.length,
        ...(script.selectModseq === undefined
          ? {}
          : { highestModseq: script.selectModseq }),
      }),
      mailboxClose: async () => true,
      status: async () => ({
        messages: remote.length,
        unseen: 0,
        uidNext: script.uidNext ?? Math.max(1, ...remote) + 1,
        highestModseq: script.statusModseq ?? script.selectModseq,
      }),
      search: async (query) => {
        calls.searches.push(query);
        if ("since" in query) return script.recent ?? [];
        const uid = (query as { uid: string }).uid;
        if (uid === script.failSearch) throw new Error("search failed");
        if (uid.endsWith(":*")) {
          const start = Number(uid.slice(0, -2));
          return remote.filter((item) => item >= start);
        }
        const requested = uid.split(",").map(Number);
        return remote.filter((item) => requested.includes(item));
      },
      fetch: async function* (range, query, options) {
        calls.fetches.push({ range, query, options });
        if (range === script.failFetch) throw new Error("fetch failed");
        const requested =
          range === "1:*" ? remote : range.split(",").map(Number);
        for (const uid of requested) {
          if (!fetched.includes(uid)) continue;
          const flag = script.flags?.[uid];
          if (
            "changedSince" in options &&
            (flag?.modseq === undefined || flag.modseq <= options.changedSince!)
          )
            continue;
          yield {
            seq: uid + 1000,
            uid,
            flags: new Set(flag?.flags ?? []),
            ...(flag?.modseq === undefined ? {} : { modseq: flag.modseq }),
            ...(query.envelope
              ? {
                  internalDate: new Date("2026-09-01T00:00:00Z"),
                  size: 20,
                  envelope: { subject: `Message ${uid}` },
                }
              : {}),
          } as FetchMessageObject;
        }
      },
      download: async () => {
        throw new Error("body fetch forbidden");
      },
      logout: async () => undefined,
      close: () => undefined,
    }),
    createSmtp: () => ({
      verify: async () => undefined,
      close: () => undefined,
    }),
  };
  return { provider: new ImapSmtpMailProvider(fake), calls };
}

function sink(snapshot: DeltaMailboxSnapshot) {
  const state = {
    checkpoint: snapshot.lastSeenUid,
    messages: new Map<string, RemoteMessageMetadata>(),
    flags: [] as RemoteFlagDelta[],
    removed: [] as string[],
    completed: null as Parameters<DeltaMailboxSyncSink["completed"]>[0] | null,
    selected: [] as string[],
    advance: [] as string[],
  };
  const callbacks: DeltaMailboxSyncSink = {
    selected: async (epoch) => {
      state.selected.push(epoch);
      return snapshot;
    },
    advanceUid: async (uid) => {
      state.advance.push(uid);
      state.checkpoint = uid;
    },
    newBatch: async (items, through) => {
      for (const item of items) state.messages.set(item.uid, item);
      state.checkpoint = through;
    },
    flagsBatch: async (changes) => {
      state.flags.push(...changes);
    },
    removed: async (uids) => {
      state.removed.push(...uids);
    },
    completed: async (value) => {
      state.completed = value;
    },
  };
  return { state, callbacks };
}

async function run(
  script: Script,
  snapshot: DeltaMailboxSnapshot,
  batchSize = 2,
) {
  const fake = harness(script);
  const target = sink(snapshot);
  await fake.provider.synchronizeDeltaMailbox(
    account,
    "INBOX",
    batchSize,
    target.callbacks,
  );
  return { ...fake, ...target };
}

describe("Phase 1E IMAP delta provider", () => {
  it("handles no new messages and leaves the UID checkpoint alone", async () => {
    const { state } = await run(
      { remote: [1, 2] },
      { lastSeenUid: "2", highestModseq: null, localUids: [] },
    );
    expect(state.messages.size).toBe(0);
    expect(state.checkpoint).toBe("2");
    expect(state.completed?.uidNext).toBe("3");
  });

  it.each([
    [[3], [3]],
    [
      [3, 4, 5],
      [3, 4, 5],
    ],
    [
      [3, 8, 12],
      [3, 8, 12],
    ],
  ])(
    "fetches new UIDs %j, including gaps, and repeats idempotently",
    async (remote, expected) => {
      const fake = harness({ remote });
      const target = sink({
        lastSeenUid: "2",
        highestModseq: null,
        localUids: [],
      });
      await fake.provider.synchronizeDeltaMailbox(
        account,
        "INBOX",
        2,
        target.callbacks,
      );
      expect([...target.state.messages.keys()]).toEqual(expected.map(String));
      expect(target.state.checkpoint).toBe(String(expected.at(-1)));
      const second = sink({
        lastSeenUid: target.state.checkpoint,
        highestModseq: null,
        localUids: [],
      });
      await fake.provider.synchronizeDeltaMailbox(
        account,
        "INBOX",
        2,
        second.callbacks,
      );
      expect(second.state.messages.size).toBe(0);
      expect(second.state.checkpoint).toBe(target.state.checkpoint);
    },
  );

  it("keeps the checkpoint below a searched UID omitted by FETCH, even when later UIDs were fetched", async () => {
    const first = await run(
      { remote: [3, 4, 5], fetched: [3, 5] },
      { lastSeenUid: "2", highestModseq: null, localUids: [] },
    );
    expect([...first.state.messages.keys()]).toEqual(["3", "5"]);
    expect(first.state.checkpoint).toBe("3");
    const retry = await run(
      { remote: [3, 4, 5] },
      {
        lastSeenUid: first.state.checkpoint,
        highestModseq: null,
        localUids: ["3", "5"],
      },
    );
    expect(retry.calls.searches).toContainEqual({ uid: "4:*" });
    expect(retry.state.messages.has("4")).toBe(true);
    expect(retry.state.checkpoint).toBe("5");
  });

  it("repeats an empty Phase 1C bootstrap SINCE search and treats UIDNEXT only as a frontier", async () => {
    const cutoff = new Date("2026-09-01T00:00:00Z");
    const snapshot = {
      lastSeenUid: "0",
      highestModseq: null,
      localUids: [],
      emptyBootstrapCutoff: cutoff,
    };
    const first = await run(
      { remote: [1, 50], recent: [], uidNext: 51 },
      snapshot,
    );
    expect(first.calls.searches).toContainEqual({ since: cutoff });
    expect(first.state.messages.size).toBe(0);
    expect(first.state.advance).toEqual(["50"]);
    const repeated = await run(
      { remote: [1, 50], recent: [], uidNext: 51 },
      snapshot,
    );
    expect(repeated.calls.searches).toContainEqual({ since: cutoff });
    expect(repeated.state.messages.size).toBe(0);
    const current = await run(
      { remote: [1, 50, 51], recent: [50, 51], uidNext: 52 },
      snapshot,
    );
    expect([...current.state.messages.keys()]).toEqual(["50", "51"]);
    expect(current.state.messages.has("1")).toBe(false);
  });

  it("does not commit the bootstrap frontier when a batch fails", async () => {
    const target = sink({
      lastSeenUid: "0",
      highestModseq: null,
      localUids: [],
      emptyBootstrapCutoff: new Date(),
    });
    const fake = harness({
      remote: [1, 50],
      recent: [50],
      uidNext: 51,
      failFetch: "50",
    });
    await expect(
      fake.provider.synchronizeDeltaMailbox(
        account,
        "INBOX",
        2,
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.state.advance).toEqual([]);
    expect(target.state.completed).toBeNull();
  });

  it("uses changedSince and the SELECT MODSEQ, with flags only and no body fetch", async () => {
    const result = await run(
      {
        remote: [1, 2],
        condstore: true,
        selectModseq: 15n,
        statusModseq: 99n,
        flags: {
          1: { flags: ["\\Seen", "custom"], modseq: 12n },
          2: { flags: ["\\Flagged"], modseq: 13n },
        },
      },
      { lastSeenUid: "2", highestModseq: "10", localUids: ["1", "2"] },
    );
    expect(
      result.calls.fetches.some(
        (call) =>
          (call.options as { changedSince?: bigint }).changedSince === 10n,
      ),
    ).toBe(true);
    expect(result.state.flags).toEqual([
      { uid: "1", flags: ["\\Seen", "custom"], modseq: "12" },
      { uid: "2", flags: ["\\Flagged"], modseq: "13" },
    ]);
    expect(result.state.completed?.highestModseq).toBe("15");
    expect(
      result.calls.fetches.every(
        (call) => !(call.query as { envelope?: boolean }).envelope,
      ),
    ).toBe(true);
    expect(
      result.calls.fetches.every(
        (call) => !(call.query as { source?: boolean }).source,
      ),
    ).toBe(true);
  });

  it("falls back to locally indexed UID flags and does not import remote history", async () => {
    const result = await run(
      { remote: [1, 2, 500], flags: { 2: { flags: ["\\Seen", "custom"] } } },
      { lastSeenUid: "500", highestModseq: null, localUids: ["2"] },
    );
    expect(result.state.flags).toEqual([
      { uid: "2", flags: ["\\Seen", "custom"] },
    ]);
    expect(result.state.messages.size).toBe(0);
    expect(result.calls.fetches.map((call) => call.range)).toEqual(["2"]);
    expect(result.state.completed?.highestModseq).toBeNull();
  });

  it("removes only confirmed missing local UIDs and ignores unrelated remote UIDs", async () => {
    const result = await run(
      { remote: [1, 3, 500] },
      { lastSeenUid: "500", highestModseq: null, localUids: ["2", "3"] },
    );
    expect(result.state.removed).toEqual(["2"]);
    expect(result.state.messages.size).toBe(0);
    expect(result.calls.searches).toContainEqual({ uid: "2,3" });
  });

  it("does not complete or advance MODSEQ after a failed flag fetch", async () => {
    const target = sink({
      lastSeenUid: "2",
      highestModseq: "10",
      localUids: ["1"],
    });
    const fake = harness({
      remote: [1],
      condstore: true,
      selectModseq: 20n,
      failFetch: "1:*",
    });
    await expect(
      fake.provider.synchronizeDeltaMailbox(
        account,
        "INBOX",
        2,
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.state.completed).toBeNull();
    expect(target.state.checkpoint).toBe("2");
  });
});
