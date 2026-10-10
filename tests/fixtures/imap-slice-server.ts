import { vi } from "vitest";
import type { FetchMessageObject } from "imapflow";
import {
  ImapSmtpMailProvider,
  type ImapClient,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";

/** Mutable, isolated IMAP state; no sockets or live accounts. */
export function sliceServer() {
  const state = {
    epoch: 10n,
    modseq: 10n,
    condstore: true,
    uidNext: 8,
    remote: new Map<number, { flags: string[]; modseq: bigint; date: Date }>(),
    omit: new Set<number>(),
    failFetch: false,
    failStatus: false,
    onFetch: undefined as (() => void) | undefined,
    credentials: [] as string[],
    searches: [] as { uid?: string; since?: Date }[],
    fetches: [] as string[],
    clients: [] as ImapClient[],
  };
  const add = (
    uid: number,
    flags: string[] = [],
    modseq = state.modseq,
    date = new Date(),
  ) => {
    state.remote.set(uid, { flags, modseq, date });
    state.uidNext = Math.max(state.uidNext, uid + 1);
  };
  const range = (value: string) => {
    if (value.includes(":")) {
      const [start, end] = value.split(":").map(Number);
      return [...state.remote.keys()].filter(
        (uid) => uid >= start && uid <= end,
      );
    }
    return value
      .split(",")
      .map(Number)
      .filter((uid) => state.remote.has(uid));
  };
  const provider = new ImapSmtpMailProvider({
    createImap: (options) => {
      state.credentials.push(
        options.auth && "accessToken" in options.auth ? "oauth2" : "password",
      );
      const client = {
        capabilities: new Map(state.condstore ? [["CONDSTORE", true]] : []),
        enabled: new Set<string>(),
        connect: vi.fn(async () => undefined),
        list: async () => [],
        mailboxOpen: async () => ({
          uidValidity: state.epoch,
          uidNext: state.uidNext,
          highestModseq: state.condstore ? state.modseq : undefined,
        }),
        mailboxClose: vi.fn(async () => true),
        logout: vi.fn(async () => undefined),
        close: vi.fn(),
        status: async () => {
          if (state.failStatus) throw new Error("simulated STATUS failure");
          return {
            uidValidity: state.epoch,
            uidNext: state.uidNext,
            messages: state.remote.size,
            unseen: [...state.remote.values()].filter(
              (item) => !item.flags.includes("\\Seen"),
            ).length,
          };
        },
        search: async (query: { uid?: string; since?: Date }) => {
          state.searches.push(query);
          return range(query.uid!).filter(
            (uid) => !query.since || state.remote.get(uid)!.date >= query.since,
          );
        },
        fetch: async function* (
          uids: string,
          query: Parameters<ImapClient["fetch"]>[1],
        ) {
          state.fetches.push(uids);
          state.onFetch?.();
          if (state.failFetch) throw new Error("simulated FETCH failure");
          for (const uid of range(uids)) {
            if (state.omit.has(uid)) continue;
            const item = state.remote.get(uid)!;
            yield {
              uid,
              seq: uid,
              flags: new Set(item.flags),
              ...(state.condstore ? { modseq: item.modseq } : {}),
              ...(query.envelope
                ? {
                    internalDate: item.date,
                    size: 20,
                    envelope: { subject: `Synthetic ${uid}` },
                  }
                : {}),
            } as FetchMessageObject;
          }
        },
        download: async () => {
          throw new Error("body request forbidden");
        },
      } satisfies ImapClient;
      state.clients.push(client);
      return client;
    },
    createSmtp: () => ({
      verify: async () => undefined,
      close: () => undefined,
    }),
  });
  return { state, provider, add };
}
