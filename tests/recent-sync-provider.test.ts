import { describe, expect, it } from "vitest";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import type { ProviderImapAccount } from "@/modules/accounts/domain/mail-provider";

const account: ProviderImapAccount = {
  accountId: "fixture",
  imap: {
    host: "imap.invalid",
    port: 993,
    security: "tls",
    username: "fixture",
    credential: { kind: "password", password: "fixture" },
  },
};
function fixture(
  found: number[],
  missing?: number,
  stillPresent = false,
  failRange = -1,
) {
  const fetches: number[][] = [];
  const saved: string[][] = [];
  const provider = new ImapSmtpMailProvider({
    createImap: () => ({
      capabilities: new Map(),
      enabled: new Set(),
      connect: async () => {},
      list: async () => [],
      mailboxOpen: async () => ({ uidValidity: 7n }),
      mailboxClose: async () => true,
      logout: async () => {},
      close: () => {},
      search: async (query) =>
        "since" in query ? found : stillPresent ? [missing!] : [],
      fetch: async function* (range) {
        // Every earlier batch must have reached the sink before the next FETCH.
        expect(saved.length).toBe(fetches.length);
        fetches.push(range.split(",").map(Number));
        if (fetches.length === failRange)
          throw new Error("fixture interrupted FETCH");
        // Deliberately return the selected batch in reverse order.
        for (const uid of [...fetches.at(-1)!].reverse()) {
          if (uid === missing) continue;
          yield {
            seq: uid,
            uid,
            flags: new Set<string>(),
            size: 1,
            internalDate: new Date(uid === 100 ? "2000-01-01" : "2026-01-01"),
          };
        }
      },
      download: async () => {
        throw new Error("forbidden");
      },
    }),
    createSmtp: () => {
      throw new Error("forbidden");
    },
  } satisfies ProtocolClientFactories);
  return {
    fetches,
    saved,
    run: () =>
      provider.synchronizeRecentMailbox(
        account,
        { remotePath: "INBOX", cutoff: new Date("2026-01-01"), batchSize: 150 },
        {
          selected: async (value) => {
            expect(value).toBe("7");
          },
          batch: async (items) => {
            saved.push(items.map((item) => item.uid));
          },
        },
      ),
  };
}

describe("newest UID first recent provider (no real network)", () => {
  it("sorts a copy numerically, commits the highest 25 first and saves before subsequent FETCH", async () => {
    const found = [
      9,
      100,
      2,
      ...Array.from({ length: 80 }, (_, index) => index + 10),
    ];
    const original = [...found];
    const test = fixture(found);
    await test.run();
    expect(found).toEqual(original);
    expect(test.fetches[0]).toEqual(
      [...found].sort((a, b) => b - a).slice(0, 25),
    );
    expect(test.fetches[1]).toEqual([...found].sort((a, b) => b - a).slice(25));
    expect(test.saved[0]).toContain("100"); // UID 100 has the oldest INTERNALDATE.
    expect(test.saved).toHaveLength(2);
  });
  it("handles an empty INBOX without FETCH", async () => {
    const test = fixture([]);
    expect((await test.run()).messageCount).toBe(0);
    expect(test.fetches).toEqual([]);
  });
  it("allows a UID expunged between SEARCH and FETCH", async () => {
    const test = fixture([1, 2, 100], 100);
    expect((await test.run()).messageCount).toBe(2);
  });
  it("rejects a missing UID that still exists without publishing the incomplete batch", async () => {
    const test = fixture([1, 2, 100], 100, true);
    await expect(test.run()).rejects.toThrow();
    expect(test.saved).toEqual([]);
  });
  it("keeps the first saved batch when a subsequent FETCH fails", async () => {
    const test = fixture(
      Array.from({ length: 50 }, (_, i) => i + 1),
      undefined,
      false,
      2,
    );
    await expect(test.run()).rejects.toThrow();
    expect(test.saved).toHaveLength(1);
    expect(test.saved[0]).toHaveLength(25);
  });
});
