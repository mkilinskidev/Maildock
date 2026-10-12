import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import {
  TransportExperiment,
  EvidenceError,
  validateEpoch,
  type Outcome,
  type Epoch,
} from "../imap-transport/hardening.js";

export const limits = { timeoutMs: 10_000, byteLimit: 2 * 1024 * 1024 };
export const username = "fixture";
export class Lane {
  client: ImapFlow;
  transport!: TransportExperiment;
  epoch!: Epoch;
  bytesIn = 0;
  bytesOut = 0;
  commands: { at: number; command: string }[] = [];
  tagged: { at: number; tag: string; status: string }[] = [];
  setupMs = 0;
  operations: Record<string, unknown>[] = [];
  constructor(ca: Buffer, condstore = true) {
    const diagnostic = (entry: object) => this.transport?.diagnostic(entry);
    this.client = new ImapFlow({
      host: "127.0.0.1",
      port: 31993,
      secure: true,
      auth: { user: username, pass: "maildock-disposable-only" },
      tls: { ca, servername: "localhost", rejectUnauthorized: true },
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: !condstore,
      qresync: false,
      maxLineLength: 256 * 1024,
      maxLiteralSize: 256 * 1024,
      maxResponseSize: 2 * 1024 * 1024,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
      logger: {
        debug: (entry: { src?: string; msg?: string }) => {
          if (entry.src === "c" && entry.msg)
            this.commands.push({
              at: performance.now(),
              command: entry.msg.replace(/LOGIN .*/, "LOGIN [fixture]"),
            });
          const tag =
            entry.src === "s" &&
            /^([0-9A-F]+) (OK|NO|BAD)\b/i.exec(entry.msg ?? "");
          if (tag)
            this.tagged.push({
              at: performance.now(),
              tag: tag[1],
              status: tag[2],
            });
        },
        info: () => {},
        warn: diagnostic,
        error: diagnostic,
      },
    });
    this.client.on("error", () => {});
  }
  static async open(condstore = true, mailbox = "INBOX") {
    const ca = await readFile(new URL(".runtime/tls/tls.crt", import.meta.url));
    const lane = new Lane(ca, condstore);
    const start = performance.now();
    const timer = setTimeout(() => lane.client.close(), 10_000);
    try {
      await lane.client.connect();
      if (!condstore) lane.client.capabilities.delete("CONDSTORE");
      lane.transport = new TransportExperiment(lane.client);
      lane.transport.socket.on("data", (b: Buffer) => {
        lane.bytesIn += b.length;
      });
      const socket = lane.transport.socket;
      const original = socket.write.bind(socket);
      socket.write = ((...args: Parameters<typeof socket.write>) => {
        const value = args[0];
        lane.bytesOut +=
          typeof value === "string"
            ? Buffer.byteLength(value)
            : value.byteLength;
        return original(...args);
      }) as typeof socket.write;
      await lane.op("SELECT", async (guard) => {
        const selected = await lane.client.mailboxOpen(mailbox);
        guard();
        if (!selected || !selected.uidValidity || !selected.uidNext)
          throw new Error("Invalid SELECT identity");
        lane.epoch = { path: mailbox, uidValidity: selected.uidValidity };
        return selected;
      });
      lane.setupMs = performance.now() - start;
      return lane;
    } catch (error) {
      lane.client.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  unwrap<T>(outcome: Outcome<T>) {
    if (outcome.status !== "justified")
      throw new Error(JSON.stringify(outcome));
    return outcome.value;
  }
  async op<T>(
    kind: string,
    work: (guard: () => void) => Promise<T>,
    byteLimit = limits.byteLimit,
  ) {
    const start = performance.now();
    const result = await this.transport.execute(
      {
        ...limits,
        byteLimit,
        mutation: /APPEND|FLAGS|CLEAN|DELETE|CREATE/.test(kind),
      },
      async (guard) => {
        const value = await work(guard);
        guard();
        if (!this.tagged.some((t) => t.at >= start && t.status === "OK"))
          throw new Error("No actual tagged success observed");
        return value;
      },
    );
    this.operations.push({
      kind,
      start,
      end: performance.now(),
      ...result,
      value: undefined,
    });
    return this.unwrap(result);
  }
  async search(low: number, high: number) {
    const start = performance.now();
    const result = await this.transport.search(low, high, 128, limits);
    this.operations.push({
      kind: "SEARCH",
      low,
      high,
      start,
      end: performance.now(),
      ...result,
      value: undefined,
    });
    return this.unwrap(result);
  }
  async metadata(uids: number[]) {
    if (!uids.length || uids.length > 128 || new Set(uids).size !== uids.length)
      throw new Error("Exact distinct bounded UID set required");
    const start = performance.now();
    const unsolicitedHints: { uid?: number; seq: number }[] = [];
    const result = await this.transport.execute(limits, async (guard) => {
      validateEpoch(this.client, this.epoch);
      const rows = new Map<number, FetchMessageObject>();
      for await (const row of this.client.fetch(
        uids,
        {
          uid: true,
          flags: true,
          headers: true,
          bodyStructure: true,
          size: true,
        },
        { uid: true },
      )) {
        guard();
        // Dovecot can interleave unsolicited flag-only FETCH with requested
        // metadata. Such rows are hints, never metadata or absence evidence.
        if (
          row.flags instanceof Set &&
          row.headers === undefined &&
          row.bodyStructure === undefined &&
          row.size === undefined
        ) {
          if (
            !Number.isSafeInteger(row.seq) ||
            row.seq < 1 ||
            (row.uid !== undefined &&
              (!Number.isSafeInteger(row.uid) ||
                row.uid < 1 ||
                row.uid > 0xffffffff))
          )
            throw new EvidenceError(
              "malformed",
              "Invalid unsolicited identity hint",
            );
          if (unsolicitedHints.length >= 128)
            throw new EvidenceError("budget", "Excessive unsolicited hints");
          unsolicitedHints.push({ uid: row.uid, seq: row.seq });
          continue;
        }
        if (!uids.includes(row.uid) || rows.has(row.uid))
          throw new EvidenceError(
            "incomplete",
            "Unexpected or duplicate metadata UID",
          );
        if (
          !Buffer.isBuffer(row.headers) ||
          !(row.flags instanceof Set) ||
          !row.bodyStructure ||
          typeof row.size !== "number"
        )
          throw new EvidenceError("incomplete", "Required metadata missing");
        rows.set(row.uid, row);
      }
      guard();
      validateEpoch(this.client, this.epoch);
      if (rows.size !== uids.length)
        throw new EvidenceError(
          "incomplete",
          `Missing exact metadata UIDs: ${uids.filter((uid) => !rows.has(uid)).join(",")}; recheck required`,
        );
      return [...rows.values()];
    });
    this.operations.push({
      kind: "FETCH",
      uids,
      expected: uids.length,
      unsolicitedHints,
      start,
      end: performance.now(),
      ...result,
      value: undefined,
    });
    return this.unwrap(result);
  }
  async slice(uid: number, length: number) {
    const start = performance.now();
    const result = await this.transport.slice(
      uid,
      "1",
      0,
      length,
      this.epoch,
      limits,
    );
    this.operations.push({
      kind: "USER BODY.PEEK",
      uid,
      origin: 0,
      length,
      start,
      end: performance.now(),
      ...result,
      value: undefined,
    });
    return this.unwrap(result);
  }
  async close() {
    if (!this.client.isClosed)
      await this.op("LOGOUT", async () => {
        await this.client.logout();
      });
    this.transport.dispose();
  }
}
