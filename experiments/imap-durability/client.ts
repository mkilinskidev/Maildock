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
export const username = "p3-smoke";
export class Lane {
  client: ImapFlow;
  transport!: TransportExperiment;
  epoch!: Epoch;
  bytesIn = 0;
  bytesOut = 0;
  commands: { at: number; command: string }[] = [];
  tagged: { at: number; tag: string; status: string }[] = [];
  searchResponses = 0;
  setupMs = 0;
  operations: Record<string, unknown>[] = [];
  deadline = Infinity;
  operationStartBytes: number | undefined;
  constructor(ca: Buffer, condstore = true, account = username, port = 32993) {
    const diagnostic = (entry: object) => this.transport?.diagnostic(entry);
    this.client = new ImapFlow({
      host: "127.0.0.1",
      port,
      secure: true,
      auth: { user: account, pass: "maildock-disposable-only" },
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
          if (entry.src === "s" && /^\* SEARCH(?:\s|$)/i.test(entry.msg ?? ""))
            this.searchResponses++;
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
  static async open(
    condstore = true,
    mailbox = "INBOX",
    account = username,
    port = 32993,
    deadline = Infinity,
  ) {
    const ca = await readFile(new URL(".runtime/tls/tls.crt", import.meta.url));
    const lane = new Lane(ca, condstore, account, port);
    const setupEnd = Math.min(deadline, performance.now() + 10_000);
    lane.deadline = setupEnd;
    if (Number.isFinite(deadline)) lane.operationStartBytes = 0;
    const start = performance.now();
    const timer = setTimeout(
      () => lane.client.close(),
      Math.max(1, setupEnd - start),
    );
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
      lane.deadline = deadline;
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
  budget() {
    const timeoutMs = Math.min(
      limits.timeoutMs,
      this.deadline - performance.now(),
    );
    if (timeoutMs <= 0) {
      this.client.close();
      throw new Error("Full operation deadline");
    }
    const byteLimit =
      limits.byteLimit -
      (this.operationStartBytes === undefined
        ? 0
        : this.bytesIn - this.operationStartBytes);
    if (byteLimit <= 0) {
      this.client.close();
      throw new EvidenceError(
        "budget",
        "Full turn input byte budget exhausted",
      );
    }
    return { ...limits, timeoutMs, byteLimit };
  }
  async op<T>(
    kind: string,
    work: (guard: () => void) => Promise<T>,
    byteLimit = limits.byteLimit,
  ) {
    const start = performance.now();
    const result = await this.transport.execute(
      {
        ...this.budget(),
        byteLimit: Math.min(byteLimit, this.budget().byteLimit),
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
    const responses = this.searchResponses;
    const result = await this.transport.search(low, high, 128, this.budget());
    this.operations.push({
      kind: "SEARCH",
      low,
      high,
      start,
      end: performance.now(),
      ...result,
      value: undefined,
      legacySearchResponses: this.searchResponses - responses,
    });
    if (result.status === "justified" && this.searchResponses === responses)
      throw new EvidenceError(
        "incomplete",
        "Tagged OK without complete legacy SEARCH response",
      );
    return this.unwrap(result);
  }
  async exactSearch(uids: number[]) {
    if (!uids.length || uids.length > 128 || new Set(uids).size !== uids.length)
      throw new Error("Exact bounded membership set required");
    const start = performance.now();
    const responses = this.searchResponses;
    const result = await this.transport.execute(
      this.budget(),
      async (guard) => {
        validateEpoch(this.client, this.epoch);
        const hits = await this.client.search(
          { uid: uids.join(",") },
          { uid: true },
        );
        guard();
        if (this.searchResponses === responses)
          throw new EvidenceError(
            "incomplete",
            "Tagged OK without complete membership SEARCH response",
          );
        if (
          !Array.isArray(hits) ||
          new Set(hits).size !== hits.length ||
          hits.some((uid) => !uids.includes(uid))
        )
          throw new EvidenceError(
            "incomplete",
            "Invalid exact membership evidence",
          );
        validateEpoch(this.client, this.epoch);
        return hits;
      },
      (scope) => {
        scope.search = {
          low: Math.min(...uids),
          high: Math.max(...uids),
          maximum: 128,
          seen: new Set(),
        };
      },
    );
    this.operations.push({
      kind: "EXACT MEMBERSHIP",
      uids,
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
    const result = await this.transport.execute(
      this.budget(),
      async (guard) => {
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
      },
    );
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
      this.budget(),
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
    if (!this.transport.socket.closed) {
      const closed = new Promise<void>((resolve) =>
        this.transport.socket.once("close", resolve),
      );
      this.client.close();
      await closed;
    }
    this.transport.dispose();
  }
}
