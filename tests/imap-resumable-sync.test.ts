import { describe, expect, it, vi, afterEach } from "vitest";
import type {
  ImapSliceSink,
  ImapSyncProgress,
} from "@/modules/accounts/domain/imap-sync-slice";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";
import { MailboxEpochChangedError } from "@/modules/accounts/domain/mail-provider";
import { sliceServer } from "./fixtures/imap-slice-server";

const account: ProviderImapAccount = {
  accountId: "00000000-0000-4000-8000-000000000001",
  revision: "1",
  imap: {
    host: "fake.invalid",
    port: 993,
    security: "tls",
    username: "fake",
    credential: { kind: "password", password: "fake" },
  },
};
const limits = { uidSpan: 3, batchSize: 2, timeoutMs: 60000 };
function sink() {
  let progress: ImapSyncProgress | null = null;
  const messages = new Set<string>();
  const flags = new Map<string, readonly string[]>();
  const completed = vi.fn();
  const callbacks: ImapSliceSink = {
    selected: async (epoch, frontier, modseq) =>
      progress
        ? { ...progress }
        : {
            revision: "1",
            uidValidity: epoch,
            cursor: "0",
            frontier,
            localCursor: "0",
            phase: "messages",
            highestModseq: modseq,
            cutoff: null,
            messageCount: 0,
          },
    messages: async (batch) => {
      for (const item of batch) messages.add(item.uid);
    },
    localUids: async (after, through, limit) =>
      [...messages]
        .filter(
          (uid) =>
            BigInt(uid) > BigInt(after) && BigInt(uid) <= BigInt(through),
        )
        .sort((a, b) => Number(a) - Number(b))
        .slice(0, limit),
    flags: async (batch) => {
      for (const item of batch) flags.set(item.uid, item.flags);
    },
    removed: async (uids) => {
      for (const uid of uids) messages.delete(uid);
    },
    checkpoint: async (value) => {
      progress = { ...value };
    },
    completed: async (value, observation) => {
      completed(value, observation);
      progress = null;
    },
  };
  return { callbacks, messages, flags, completed, progress: () => progress };
}
afterEach(() => vi.useRealTimers());
describe("bounded IMAP protocol slices", () => {
  it.each(["password", "oauth2"])(
    "imports a large mailbox over multiple slices using %s",
    async (auth) => {
      const server = sliceServer(),
        target = sink();
      for (let uid = 1; uid <= 7; uid++) server.add(uid);
      const credentials =
        auth === "oauth2"
          ? { kind: "oauth2" as const, accessToken: "fake" }
          : account.imap.credential;
      let runs = 0;
      while (
        await server.provider.synchronizeMailboxSlice(
          { ...account, imap: { ...account.imap, credential: credentials } },
          "INBOX",
          "recent",
          limits,
          target.callbacks,
        )
      )
        runs++;
      expect(runs).toBe(2);
      expect(target.messages.size).toBe(7);
      expect(
        server.state.fetches.every((group) => group.split(",").length <= 2),
      ).toBe(true);
      expect(server.state.searches.map((query) => query.uid)).toEqual([
        "1:3",
        "4:6",
        "7:7",
      ]);
      expect(server.state.clients).toHaveLength(3);
      expect(
        server.state.clients.every(
          (client) => vi.mocked(client.close).mock.calls.length === 1,
        ),
      ).toBe(true);
      expect(server.state.credentials).toEqual([auth, auth, auth]);
    },
  );
  it("does not checkpoint failed persistence; retry replays the same range", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(1);
    target.callbacks.messages = vi
      .fn()
      .mockRejectedValueOnce(new Error("DB failure"))
      .mockImplementation(async (batch) => {
        for (const item of batch) target.messages.add(item.uid);
      });
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.progress()).toBeNull();
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    expect(server.state.searches.map((query) => query.uid)).toEqual([
      "1:3",
      "1:3",
    ]);
    expect(target.progress()?.cursor).toBe("3");
  });
  it("retries an omitted live UID rather than advancing over it", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(1);
    server.add(2);
    server.state.omit.add(1);
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.progress()).toBeNull();
    server.state.omit.clear();
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    expect([...target.messages]).toEqual(["1", "2"]);
  });
  it("advances safely over empty ranges and expunges after SEARCH", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(2);
    server.state.onFetch = () => server.state.remote.delete(2);
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    expect(target.progress()?.cursor).toBe("3");
    expect(target.messages.size).toBe(0);
  });
  it.each([true, false])(
    "reconciles flags and confirms deletions between slices, CONDSTORE=%s",
    async (condstore) => {
      const server = sliceServer(),
        target = sink();
      server.state.condstore = condstore;
      for (let uid = 1; uid <= 3; uid++) server.add(uid);
      server.state.uidNext = 4;
      await server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      );
      expect(target.completed).not.toHaveBeenCalled();
      server.add(1, ["\\Seen"], 20n);
      server.state.modseq = 20n;
      server.state.remote.delete(2);
      while (
        await server.provider.synchronizeMailboxSlice(
          account,
          "INBOX",
          "delta",
          limits,
          target.callbacks,
        )
      ) {
        /* drain */
      }
      expect(target.flags.get("1")).toEqual(["\\Seen"]);
      expect(target.messages.has("2")).toBe(false);
      expect(target.completed.mock.calls[0][0].highestModseq).toBe(
        condstore ? "10" : null,
      );
    },
  );
  it("retains a fixed horizon when new messages arrive; the next cycle imports them", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(1);
    server.state.uidNext = 4;
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    server.add(4);
    while (
      await server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      )
    ) {
      /* drain */
    }
    expect(target.messages.has("4")).toBe(false);
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      { ...limits, uidSpan: 5 },
      target.callbacks,
    );
    expect(target.messages.has("4")).toBe(true);
  });
  it("rejects UIDVALIDITY changes while resuming and during STATUS", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(1);
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    server.state.epoch = 11n;
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      ),
    ).rejects.toBeInstanceOf(MailboxEpochChangedError);
    const fresh = sink();
    server.state.onFetch = () => {
      server.state.epoch = 12n;
    };
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        fresh.callbacks,
      ),
    ).rejects.toBeInstanceOf(MailboxEpochChangedError);
    expect(fresh.progress()).toBeNull();
  });
  it("closes on cancellation and does not advance progress", async () => {
    const server = sliceServer(),
      target = sink(),
      controller = new AbortController();
    server.add(1);
    server.state.onFetch = () => controller.abort();
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(target.progress()).toBeNull();
    expect(
      server.state.clients.every(
        (client) => vi.mocked(client.close).mock.calls.length >= 1,
      ),
    ).toBe(true);
  });
  it("closes the remote connection when the slice deadline expires during persistence", async () => {
    vi.useFakeTimers();
    const server = sliceServer(),
      target = sink();
    server.add(1);
    target.callbacks.messages = async () => {
      await vi.advanceTimersByTimeAsync(1000);
    };
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        { ...limits, timeoutMs: 1000 },
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.progress()).toBeNull();
    expect(vi.mocked(server.state.clients[0].close)).toHaveBeenCalled();
  });
  it("does not remove placements or commit a MODSEQ after STATUS failure", async () => {
    const server = sliceServer(),
      target = sink();
    server.add(1);
    server.state.uidNext = 4;
    await server.provider.synchronizeMailboxSlice(
      account,
      "INBOX",
      "delta",
      limits,
      target.callbacks,
    );
    server.state.remote.delete(1);
    server.state.failStatus = true;
    await expect(
      server.provider.synchronizeMailboxSlice(
        account,
        "INBOX",
        "delta",
        limits,
        target.callbacks,
      ),
    ).rejects.toThrow();
    expect(target.messages.has("1")).toBe(true);
    expect(target.progress()?.localCursor).toBe("0");
    expect(target.completed).not.toHaveBeenCalled();
  });
});
