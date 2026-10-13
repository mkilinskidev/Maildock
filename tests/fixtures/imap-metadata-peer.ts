import { createRequire } from "node:module";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import {
  fixture,
  type Peer,
  type Command,
} from "../../experiments/imap-transport/fixture";

export type WindowPeerOptions = {
  /** Mutable small mailbox oracle for repeated coordinator connections. */
  boundedMailbox?: boolean;
  onCommand?: (peer: Peer, command: Command) => boolean | void;
  uids?: number[];
  uidNext?: number;
  epoch?: number;
  search?: "absent" | "duplicate" | "invalid" | "esearch" | "hung" | "no";
  fetch?:
    | "missing"
    | "duplicate"
    | "unexpected"
    | "flags"
    | "sequence"
    | "incomplete"
    | "oversized"
    | "aggregate"
    | "hung"
    | "no";
  select?: "hung" | "missing-next";
  taggedDelay?: number;
  cjs?: boolean;
  raw?:
    | "flags"
    | "envelope"
    | "structure"
    | "duplicate-field"
    | "wrong-section"
    | "nil-header"
    | "nesting"
    | "malformed";
  staleStatus?: boolean;
  trickle?: boolean;
  greeting?: "PREAUTH" | "OK";
  attachment?: boolean;
  minimalDisposition?: boolean;
};

export async function metadataPeer(options: WindowPeerOptions = {}) {
  const uids = options.uids ?? [129, 130];
  const sendRow = (peer: Peer, command: Command, uid: number, extra = 0) => {
    const header = Buffer.from(
      `References: <parent@example.test>${"x".repeat(extra)}\r\n\r\n`,
    );
    let prefix =
      `* 1 FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "01-Jan-2026 00:00:00 +0000" RFC822.SIZE 100 ` +
      `ENVELOPE (NIL "Fixture ${uid}" NIL NIL NIL NIL NIL NIL NIL "<stage2-${uid}@example.test>") ` +
      `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1) ` +
      `BODY[HEADER.FIELDS (REFERENCES)] {${header.length}}\r\n`;
    if (options.attachment)
      prefix = prefix.replace(
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)',
        '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)' +
          '("APPLICATION" "PDF" ("NAME" "fixture.pdf") NIL NIL "BASE64" 88 NIL ("ATTACHMENT" ("FILENAME" "fixture.pdf")) NIL NIL) "MIXED" ("BOUNDARY" "fixture") NIL NIL NIL)',
      );
    if (options.minimalDisposition)
      prefix = prefix.replace(
        '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1)',
        '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 88 NIL ("ATTACHMENT" ("FILENAME" "fixture.pdf")))',
      );
    if (options.raw === "flags")
      prefix = prefix.replace("FLAGS (\\Seen)", "FLAGS NIL");
    if (options.raw === "envelope")
      prefix = prefix.replace(`NIL "Fixture ${uid}"`, `(1 2) "Fixture ${uid}"`);
    if (options.raw === "structure")
      prefix = prefix.replace('"7BIT" 10 1', '"7BIT" NIL 1');
    if (options.raw === "duplicate-field")
      prefix = prefix.replace(`UID ${uid}`, `UID ${uid} UID ${uid}`);
    if (options.raw === "wrong-section")
      prefix = prefix.replace("HEADER.FIELDS (REFERENCES)", "TEXT");
    if (options.raw === "nil-header") {
      peer.send(prefix.replace(`{${header.length}}\r\n`, "NIL)\r\n"), command);
      return;
    }
    if (options.raw === "nesting") {
      peer.send(
        `* 1 FETCH (${"(".repeat(100)}UID ${uid}${")".repeat(100)})\r\n`,
        command,
      );
      return;
    }
    if (options.raw === "malformed") {
      peer.send("* malformed (\r\n", command);
      return;
    }
    peer.send(prefix, command);
    peer.send(header, command);
    peer.send(")\r\n", command);
  };
  const peer = await fixture(
    (p, cmd) => {
      if (options.onCommand?.(p, cmd)) return true;
      if (
        cmd.command.startsWith("LOGIN") ||
        cmd.command.startsWith("AUTHENTICATE")
      ) {
        p.ok(cmd);
        return true;
      }
      if (cmd.command.startsWith("STATUS") && options.staleStatus) {
        p.send(
          '* STATUS "INBOX" (UIDNEXT 1 UIDVALIDITY 7 MESSAGES 0)\r\n',
          cmd,
        );
        p.ok(cmd);
        return true;
      }
      if (/^(SELECT|EXAMINE) /.test(cmd.command)) {
        if (options.select === "hung") return true;
        p.send(
          `* ${uids.length} EXISTS\r\n* FLAGS (\\Seen)\r\n* OK [UIDVALIDITY ${options.epoch ?? 7}] Epoch\r\n` +
            (options.select === "missing-next"
              ? ""
              : `* OK [UIDNEXT ${options.uidNext ?? 257}] Next\r\n`),
          cmd,
        );
        p.ok(cmd, "OK [READ-ONLY] Selected");
        return true;
      }
      if (cmd.command.startsWith("UID SEARCH")) {
        if (options.search === "hung") return true;
        if (options.search === "no") {
          p.ok(cmd, "NO Search refused");
          return true;
        }
        if (options.search !== "absent") {
          const hits =
            options.search === "duplicate"
              ? [129, 129]
              : options.search === "invalid"
                ? [0]
                : options.boundedMailbox
                  ? uids.filter((uid) => {
                      const range = /UID SEARCH UID (\d+):(\d+)/.exec(
                        cmd.command,
                      );
                      return (
                        range &&
                        uid >= Number(range[1]) &&
                        uid <= Number(range[2])
                      );
                    })
                  : uids;
          p.send(
            options.search === "esearch"
              ? "* ESEARCH UID ALL 1:4294967295\r\n"
              : `* SEARCH${hits.length ? " " + hits.join(" ") : ""}\r\n`,
            cmd,
          );
        }
        p.ok(cmd);
        return true;
      }
      if (cmd.command.startsWith("UID FETCH")) {
        if (options.fetch === "hung") {
          if (options.trickle)
            for (let i = 1; i <= 30; i++)
              p.later(i * 10, () => p.send("* OK still waiting\r\n", cmd));
          return true;
        }
        if (options.fetch === "flags")
          p.send(
            "* 2 FETCH (FLAGS (\\Seen))\r\n* 2 FETCH (UID 500 FLAGS ())\r\n",
            cmd,
          );
        if (options.fetch === "sequence") p.send("* 2 FETCH ()\r\n", cmd);
        if (options.fetch === "incomplete")
          p.send(`* 1 FETCH (UID ${uids[0]} RFC822.SIZE 100)\r\n`, cmd);
        else {
          const rows =
            options.fetch === "missing"
              ? uids.slice(1)
              : options.fetch === "unexpected"
                ? [...uids, 1]
                : options.fetch === "duplicate"
                  ? [...uids, uids[0]]
                  : options.boundedMailbox
                    ? uids.filter((uid) =>
                        cmd.command
                          .split(" ")[2]
                          .split(",")
                          .some((part) => {
                            const [low, high = low] = part
                              .split(":")
                              .map(Number);
                            return uid >= low && uid <= high;
                          }),
                      )
                    : uids;
          for (const uid of rows)
            sendRow(
              p,
              cmd,
              uid,
              options.fetch === "oversized"
                ? 262144
                : options.fetch === "aggregate"
                  ? 20000
                  : 0,
            );
        }
        if (options.taggedDelay) p.later(options.taggedDelay, () => p.ok(cmd));
        else p.ok(cmd, options.fetch === "no" ? "NO Fetch refused" : undefined);
        return true;
      }
      return false;
    },
    {},
    options.greeting,
    "IMAP4rev1 IDLE AUTH=XOAUTH2 SASL-IR",
  );
  const observed: ImapFlow[] = [];
  const Client = options.cjs
    ? (
        createRequire(import.meta.url)("imapflow") as {
          ImapFlow: typeof ImapFlow;
        }
      ).ImapFlow
    : ImapFlow;
  const createClient = (opts: ImapFlowOptions) => {
    const client = new Client({ ...opts, tls: { rejectUnauthorized: false } });
    observed.push(client);
    return client;
  };
  return {
    ...peer,
    observed,
    createClient,
    connection: {
      host: peer.endpoint.host,
      port: peer.endpoint.port,
      security: "tls" as const,
      username: "fixture",
      credential: { kind: "password" as const, password: "fixture-only" },
    },
  };
}
