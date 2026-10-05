import { createServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import {
  ImapSmtpMailProvider,
  type ProtocolClientFactories,
} from "@/modules/accounts/infrastructure/imap-smtp-mail-provider";
import {
  MailboxEpochChangedError,
  MailProviderOperationError,
} from "@/modules/accounts/domain/mail-provider";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real installed ImapFlow, parser/compiler and TCP wire. No mocked STORE return. */
async function fixture(
  options: {
    modseq?: bigint;
    flags?: string[];
    failure?: "BAD" | "NO";
    modifiedStatus?: "OK" | "NO";
    alreadySatisfied?: string;
    epochChange?: boolean;
    conflictAgain?: boolean;
    missingAfterConflict?: boolean;
    missingModseqAfterConflict?: boolean;
    missingInitialModseq?: boolean;
    condstore?: boolean;
    cjs?: boolean;
  } = {},
) {
  let modseq = options.modseq ?? 3n;
  const flags = new Set(options.flags ?? ["\\Answered", "custom"]);
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  let selectCount = 0;
  let stores = 0;
  const condstore = options.condstore !== false;
  const capabilities = `IMAP4rev1 MOVE${condstore ? " ENABLE CONDSTORE" : ""}`;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.write(`* PREAUTH [CAPABILITY ${capabilities}] Test IMAP\r\n`);
    let buffered = "";
    socket.on("data", (bytes) => {
      buffered += bytes.toString();
      let boundary: number;
      while ((boundary = buffered.indexOf("\r\n")) >= 0) {
        const line = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const space = line.indexOf(" ");
        const tag = line.slice(0, space);
        const command = line.slice(space + 1);
        commands.push(command);
        const send = (value: string) => socket.write(value + "\r\n");
        if (command === "CAPABILITY") send(`* CAPABILITY ${capabilities}`);
        else if (command.startsWith("ENABLE ")) send("* ENABLED CONDSTORE");
        else if (command.startsWith("LIST ")) send('* LIST () "/" ""');
        else if (command.startsWith("SELECT ")) {
          selectCount++;
          send("* 1 EXISTS");
          send("* FLAGS (\\Seen \\Flagged \\Answered custom)");
          send("* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Answered \\*)] Flags");
          send(
            `* OK [UIDVALIDITY ${options.epochChange && selectCount > 1 ? 8 : 7}] Epoch`,
          );
          send("* OK [UIDNEXT 43] Next");
          if (condstore) send(`* OK [HIGHESTMODSEQ ${modseq}] Baseline`);
          send(`${tag} OK [READ-WRITE] Selected`);
          continue;
        } else if (command.startsWith("UID FETCH ")) {
          if (!(options.missingAfterConflict && stores > 0))
            send(
              `* 1 FETCH (UID 42 FLAGS (${[...flags].join(" ")})${condstore && !options.missingInitialModseq && !(options.missingModseqAfterConflict && stores > 0) ? ` MODSEQ (${modseq})` : ""})`,
            );
        } else if (command.startsWith("UID STORE ")) {
          stores++;
          // Reject the old incorrect modifier placement exactly as a strict server does.
          const match =
            /^UID STORE 42(?: \(UNCHANGEDSINCE (\d+)\))? ([+-])FLAGS \((\\Seen|\\Flagged)\)$/.exec(
              command,
            );
          if (!match || options.failure) {
            send(`${tag} ${options.failure ?? "BAD"} STORE rejected`);
            continue;
          }
          if (options.conflictAgain && stores > 1) modseq++;
          if (match[1] !== undefined && BigInt(match[1]) < modseq) {
            if (options.alreadySatisfied) {
              flags.add(options.alreadySatisfied);
              modseq++;
            }
            send(
              `${tag} ${options.modifiedStatus ?? "OK"} [MODIFIED 42] Conditional conflict`,
            );
            continue;
          }
          if (match[2] === "+") flags.add(match[3]);
          else flags.delete(match[3]);
          modseq++;
          send(
            `* 1 FETCH (UID 42 FLAGS (${[...flags].join(" ")})${condstore ? ` MODSEQ (${modseq})` : ""})`,
          );
        } else if (command === "LOGOUT") {
          send("* BYE Closing");
          send(`${tag} OK Logout`);
          socket.end();
          continue;
        } else if (command !== "CLOSE" && command !== "NOOP") {
          send(`${tag} BAD Unexpected command`);
          continue;
        }
        send(`${tag} OK Completed`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const Client = options.cjs
    ? (createRequire(import.meta.url)("imapflow") as typeof import("imapflow"))
        .ImapFlow
    : ImapFlow;
  const client = new Client({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    doSTARTTLS: false,
    logger: false,
    disableAutoIdle: true,
    socketTimeout: 3000,
    connectionTimeout: 3000,
  });
  cleanups.push(async () => client.close());
  const factories: ProtocolClientFactories = {
    createImap: () => client,
    createSmtp: () => ({ verify: async () => {}, close: () => {} }),
  };
  const provider = new ImapSmtpMailProvider(factories);
  const account = {
    accountId: "test-account",
    imap: {
      host: "127.0.0.1",
      port: address.port,
      security: "starttls" as const,
      username: "test",
      credential: { kind: "password" as const, password: "test" },
    },
  };
  const request = {
    sourcePath: "INBOX",
    uidValidity: "7",
    uid: "42",
    modseq: "3",
    action: "mark_read" as const,
  };
  return {
    client,
    provider,
    account,
    request,
    flags,
    commands,
    storeCommands: () =>
      commands.filter((command) => command.startsWith("UID STORE ")),
  };
}

describe("installed ImapFlow conditional STORE protocol", () => {
  it("preserves protocol-sized MODSEQ integers without Number conversion", async () => {
    const modseq = 1234567890123456789n;
    const f = await fixture({ modseq });
    expect(
      await f.provider.mutateMessage(f.account, {
        ...f.request,
        modseq: modseq.toString(),
      }),
    ).toEqual({ outcome: "applied" });
    expect(f.storeCommands()).toEqual([
      `UID STORE 42 (UNCHANGEDSINCE ${modseq}) +FLAGS (\\Seen)`,
    ]);
  });
  it("keeps a zero UNCHANGEDSINCE conditional instead of silently omitting it", async () => {
    const f = await fixture();
    expect(
      await f.provider.mutateMessage(f.account, { ...f.request, modseq: "0" }),
    ).toEqual({ outcome: "applied" });
    expect(f.storeCommands()).toEqual([
      "UID STORE 42 (UNCHANGEDSINCE 0) +FLAGS (\\Seen)",
      "UID STORE 42 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)",
    ]);
  });
  it.each([false, true])(
    "serializes RFC 7162 and applies matching MODSEQ (CJS=%s)",
    async (cjs) => {
      const f = await fixture({ cjs });
      expect(await f.provider.mutateMessage(f.account, f.request)).toEqual({
        outcome: "applied",
      });
      expect(f.storeCommands()).toEqual([
        "UID STORE 42 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)",
      ]);
      expect([...f.flags].sort()).toEqual(["\\Answered", "\\Seen", "custom"]);
    },
  );
  it.each(["OK", "NO"] as const)(
    "surfaces stale MODSEQ as a distinct %s [MODIFIED] conflict",
    async (modifiedStatus) => {
      const f = await fixture({ modseq: 5n, modifiedStatus });
      await f.client.connect();
      await f.client.mailboxOpen("INBOX");
      await expect(
        f.client.messageFlagsAdd("42", ["\\Seen"], {
          uid: true,
          unchangedSince: 3n,
        }),
      ).rejects.toMatchObject({ code: "ConditionalStoreFailed" });
      expect(f.flags.has("\\Seen")).toBe(false);
      expect(f.storeCommands()).toHaveLength(1);
    },
  );
  it.each(["BAD", "NO"] as const)(
    "propagates %s as a protocol error, never a conflict or reconciliation retry",
    async (failure) => {
      const f = await fixture({ failure });
      await expect(
        f.provider.mutateMessage(f.account, f.request),
      ).rejects.toBeInstanceOf(MailProviderOperationError);
      expect(f.storeCommands()).toHaveLength(1);
      expect(
        f.commands.filter((command) => command.startsWith("SELECT ")),
      ).toHaveLength(1);
      expect(f.flags.has("\\Seen")).toBe(false);
    },
  );
  it("treats an already satisfied flag after conflict as success without another STORE", async () => {
    const f = await fixture({ modseq: 5n, alreadySatisfied: "\\Seen" });
    expect(await f.provider.mutateMessage(f.account, f.request)).toEqual({
      outcome: "applied",
    });
    expect(f.storeCommands()).toHaveLength(1);
    expect(
      f.commands.filter((command) => command.startsWith("SELECT ")),
    ).toHaveLength(2);
  });
  it.each([
    ["mark_read", "+", "\\Seen", []],
    ["mark_unread", "-", "\\Seen", ["\\Seen"]],
    ["flag", "+", "\\Flagged", []],
    ["unflag", "-", "\\Flagged", ["\\Flagged"]],
  ] as const)(
    "rebases %s once using fresh MODSEQ and preserves unrelated flags",
    async (action, operation, flag, initialFlags) => {
      const f = await fixture({
        modseq: 5n,
        flags: ["\\Answered", "custom", ...initialFlags],
      });
      expect(
        await f.provider.mutateMessage(f.account, { ...f.request, action }),
      ).toEqual({ outcome: "applied" });
      expect(f.storeCommands()).toEqual([
        `UID STORE 42 (UNCHANGEDSINCE 3) ${operation}FLAGS (${flag})`,
        `UID STORE 42 (UNCHANGEDSINCE 5) ${operation}FLAGS (${flag})`,
      ]);
      expect(f.flags.has(flag)).toBe(operation === "+");
      expect(f.flags.has("\\Answered")).toBe(true);
      expect(f.flags.has("custom")).toBe(true);
    },
  );
  it("aborts on UIDVALIDITY change during reconciliation before another FETCH/STORE", async () => {
    const f = await fixture({ modseq: 5n, epochChange: true });
    await expect(
      f.provider.mutateMessage(f.account, f.request),
    ).rejects.toBeInstanceOf(MailboxEpochChangedError);
    expect(f.storeCommands()).toHaveLength(1);
    expect(
      f.commands.filter((command) => command.startsWith("UID FETCH ")),
    ).toHaveLength(1);
  });
  it("returns conflict after a second MODIFIED without an unbounded retry", async () => {
    const f = await fixture({ modseq: 5n, conflictAgain: true });
    expect(await f.provider.mutateMessage(f.account, f.request)).toEqual({
      outcome: "conflict",
    });
    expect(f.storeCommands()).toHaveLength(2);
    expect(f.flags.has("\\Seen")).toBe(false);
  });
  it("recognizes source disappearance after conflict", async () => {
    const f = await fixture({ modseq: 5n, missingAfterConflict: true });
    expect(await f.provider.mutateMessage(f.account, f.request)).toEqual({
      outcome: "source_missing",
    });
    expect(f.storeCommands()).toHaveLength(1);
  });
  it("does not downgrade the retry to unconditional STORE when fresh MODSEQ is missing", async () => {
    const f = await fixture({ modseq: 5n, missingModseqAfterConflict: true });
    await expect(
      f.provider.mutateMessage(f.account, f.request),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
    expect(f.storeCommands()).toHaveLength(1);
  });
  it("does not downgrade the initial conditional update when server MODSEQ is missing", async () => {
    const f = await fixture({ missingInitialModseq: true });
    await expect(
      f.provider.mutateMessage(f.account, f.request),
    ).rejects.toBeInstanceOf(MailProviderOperationError);
    expect(f.storeCommands()).toHaveLength(0);
  });
  it("preserves the existing single-flag behavior on servers without CONDSTORE", async () => {
    const f = await fixture({ condstore: false });
    expect(await f.provider.mutateMessage(f.account, f.request)).toEqual({
      outcome: "applied",
    });
    expect(f.storeCommands()).toEqual(["UID STORE 42 +FLAGS (\\Seen)"]);
    expect(f.flags.has("custom")).toBe(true);
  });
});
