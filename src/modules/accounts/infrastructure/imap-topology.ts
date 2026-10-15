import type { ImapFlow, ReceivingResponse, ReceivingToken } from "imapflow";
import type { TopologyEntry } from "../../mail/application/receiving-bounded-publication";

export const TOPOLOGY_LIMITS = Object.freeze({
  identities: 128,
  bytes: 2 * 1024 * 1024,
  responseBytes: 64 * 1024,
});
export class TopologyError extends Error {}
type Token = ReceivingToken | ReceivingToken[] | null | undefined;
function atom(token: Token) {
  if (!token || Array.isArray(token))
    throw new TopologyError("Malformed topology atom");
  return token;
}
function string(token: Token) {
  const value = atom(token).value;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value))
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  throw new TopologyError("Malformed topology string");
}
function path(token: Token, utf8: boolean) {
  let value = string(token);
  if (!utf8) {
    if (/[^\x20-\x7e]/.test(value))
      throw new TopologyError("Invalid modified UTF-7 path");
    value = value.replace(/&([^-]*)-/g, (_, encoded: string) => {
      if (!encoded) return "&";
      if (!/^[A-Za-z0-9+,]+$/.test(encoded))
        throw new TopologyError("Invalid modified UTF-7 sequence");
      const bytes = Buffer.from(encoded.replaceAll(",", "/"), "base64");
      if (
        !bytes.length ||
        bytes.length % 2 ||
        bytes.toString("base64").replace(/=+$/, "").replaceAll("/", ",") !==
          encoded
      )
        throw new TopologyError("Invalid modified UTF-7 encoding");
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    });
    // An ampersand without a terminating shift is not a valid encoded path.
    if (/&[^-]*$/.test(string(token)))
      throw new TopologyError("Unterminated modified UTF-7 path");
  }
  if (
    !value ||
    /[\x00-\x1f\x7f]/.test(value) ||
    Buffer.byteLength(value) > 4096
  )
    throw new TopologyError("Invalid or oversized mailbox path");
  return value.toUpperCase() === "INBOX" ? "INBOX" : value;
}
const flags = [
  "\\Archive",
  "\\Trash",
  "\\Sent",
  "\\Drafts",
  "\\Junk",
  "\\All",
  "\\Flagged",
  "\\Inbox",
];
const canonicalFlag = (v: string) =>
  flags.find((f) => f.toLowerCase() === v.toLowerCase()) ?? v;
type Observation = Omit<TopologyEntry, "id">;
export type SelectedDestination = Readonly<{
  path: string;
  epoch: bigint;
  uidNext: bigint;
  exists: number;
  providerId?: string;
}>;

/** Raw hooks precede the installed adapter's lossy flag/name normalization.
 * One collector belongs to one admitted operation and is never reused. */
export class TopologyCollector {
  private active = false;
  private tag?: string;
  private completed = false;
  private entries = new Map<string, Observation>();
  private ids = new Map<string, string>();
  private stable = new Map<string, string>();
  private wirePaths = new Map<string, string>();
  private status?: { path: string; tag?: string; complete: boolean };
  private objectId = false;
  private utf8 = false;
  private selected?: {
    epoch?: bigint;
    uidNext?: bigint;
    tag?: string;
    complete?: boolean;
    providerId?: string;
    exists?: number;
  };
  begin(client: ImapFlow) {
    this.active = true;
    this.objectId = client.capabilities.has("OBJECTID");
    this.utf8 =
      client.enabled.has("UTF8=ACCEPT") ||
      (client.capabilities.has("IMAP4rev2") &&
        !Reflect.get(client, "skipRev2"));
  }
  beginSelect() {
    this.active = false;
    this.selected = {};
  }
  statusRequests() {
    return [...this.entries.values()]
      .filter((entry) => entry.selectable)
      .map((entry) => ({
        path: entry.path,
        wire: this.wirePaths.get(entry.path)!,
      }));
  }
  beginStatus(path: string) {
    this.status = { path, complete: false };
  }
  finishStatus() {
    if (!this.status?.complete || !this.ids.has(this.status.path))
      throw new TopologyError("Incomplete correlated MAILBOXID STATUS");
    this.status = undefined;
  }
  observe = (
    response: ReceivingResponse,
    request?: { tag: string; command: string; sent: boolean },
  ) => {
    if (response.nullBytesRemoved)
      throw new TopologyError("Null bytes in topology response");
    if (
      this.selected &&
      request?.sent &&
      ["SELECT", "EXAMINE"].includes(request.command)
    ) {
      const selected = this.selected;
      if (selected.tag && selected.tag !== request.tag)
        throw new TopologyError("Multiple destination SELECT commands");
      selected.tag = request.tag;
      if (response.tag === request.tag) {
        if (response.command !== "OK" || selected.complete)
          throw new TopologyError("Destination SELECT failed");
        selected.complete = true;
      }
      const first = response.attributes?.[0];
      const section =
        first && !Array.isArray(first) ? first.section : undefined;
      if (first && !Array.isArray(first) && first.value === "EXISTS") {
        if (
          selected.exists !== undefined ||
          !/^(0|[1-9][0-9]{0,9})$/.test(response.command ?? "")
        )
          throw new TopologyError("Invalid destination EXISTS evidence");
        selected.exists = Number(response.command);
      }
      if (
        section &&
        ["UIDVALIDITY", "UIDNEXT"].includes(String(section[0]?.value))
      ) {
        const key = section[0]?.value === "UIDVALIDITY" ? "epoch" : "uidNext";
        const raw = section[1]?.value;
        if (
          selected[key] !== undefined ||
          typeof raw !== "string" ||
          !/^[1-9][0-9]{0,9}$/.test(raw)
        )
          throw new TopologyError("Invalid selected identity evidence");
        const value = BigInt(raw);
        if (value > (key === "epoch" ? 4294967295n : 4294967296n))
          throw new TopologyError("Selected identity exceeds UID bounds");
        selected[key] = value;
      }
      if (section?.[0]?.value === "MAILBOXID") {
        if (
          selected.providerId ||
          !Array.isArray(section[1]) ||
          section[1].length !== 1
        )
          throw new TopologyError("Invalid selected MAILBOXID");
        selected.providerId = string(section[1][0]);
        if (!/^[A-Za-z0-9_-]{1,255}$/.test(selected.providerId))
          throw new TopologyError("Invalid selected MAILBOXID value");
      }
    }
    if (!this.active) return;
    if (
      !request?.sent ||
      (request.command !== "LIST" &&
        !(request.command === "STATUS" && this.status))
    ) {
      if (["LIST", "STATUS"].includes(response.command ?? ""))
        throw new TopologyError("Uncorrelated topology response");
      return;
    }
    if (request.command === "STATUS" && this.status) {
      if (this.status.tag && this.status.tag !== request.tag)
        throw new TopologyError("Uncorrelated MAILBOXID STATUS");
      this.status.tag = request.tag;
      if (response.tag === request.tag) {
        if (response.command !== "OK" || this.status.complete)
          throw new TopologyError("MAILBOXID STATUS failed");
        this.status.complete = true;
        return;
      }
    } else {
      if (this.tag && this.tag !== request.tag)
        throw new TopologyError("Multiple topology requests");
      this.tag = request.tag;
      if (response.tag === request.tag) {
        if (response.command !== "OK" || this.completed)
          throw new TopologyError("LIST did not complete successfully");
        this.completed = true;
        return;
      }
    }
    if (response.tag !== "*") return;
    if (response.command === "LIST") {
      if (request.command !== "LIST" || this.completed)
        throw new TopologyError("LIST entry outside its complete request");
      const items = response.attributes;
      if (
        !items ||
        items.length !== 3 ||
        !Array.isArray(items[0]) ||
        items[0].length > 128
      )
        throw new TopologyError("Malformed LIST entry");
      const name = path(items[2], this.utf8);
      if (
        this.entries.has(name) ||
        this.entries.size >= TOPOLOGY_LIMITS.identities
      )
        throw new TopologyError(
          "Duplicate path or topology exceeds 128 identities",
        );
      const attributes = items[0].map(string).map(canonicalFlag);
      if (
        items[0].some((value) => atom(value).type !== "ATOM") ||
        attributes.some((a) => !a || Buffer.byteLength(a) > 254) ||
        new Set(attributes.map((a) => a.toLowerCase())).size !==
          attributes.length
      )
        throw new TopologyError("Invalid LIST attributes");
      const delimiter = items[1] === null ? null : string(items[1]);
      if (delimiter !== null && [...delimiter].length !== 1)
        throw new TopologyError("Invalid hierarchy delimiter");
      const selectable = !attributes.some((a) =>
        ["\\noselect", "\\nonexistent"].includes(a.toLowerCase()),
      );
      this.entries.set(name, {
        path: name,
        name: delimiter ? name.split(delimiter).at(-1) || name : name,
        delimiter,
        attributes,
        specialUse: attributes.filter((a) => flags.includes(a)),
        selectable,
        subscribed: attributes.some((a) => a.toLowerCase() === "\\subscribed")
          ? true
          : null,
        providerMailboxId: null,
      });
      this.wirePaths.set(name, string(items[2]));
      return false;
    }
    if (response.command === "STATUS") {
      const items = response.attributes;
      if (
        !this.objectId ||
        items?.length !== 2 ||
        !Array.isArray(items[1]) ||
        items[1].length !== 2 ||
        string(items[1][0]).toUpperCase() !== "MAILBOXID" ||
        !Array.isArray(items[1][1]) ||
        items[1][1].length !== 1
      )
        throw new TopologyError("Malformed topology MAILBOXID status");
      const name = path(items[0], this.utf8),
        id = string(items[1][1][0]);
      if (this.status && this.status.path !== name)
        throw new TopologyError("STATUS returned a different mailbox");
      if (
        !/^[A-Za-z0-9_-]{1,255}$/.test(id) ||
        this.ids.has(name) ||
        this.stable.has(id)
      )
        throw new TopologyError("Duplicate or invalid stable mailbox identity");
      this.ids.set(name, id);
      this.stable.set(id, name);
      if (this.ids.size > TOPOLOGY_LIMITS.identities)
        throw new TopologyError("Topology STATUS exceeds identity budget");
      return false;
    }
  };
  finish() {
    if (!this.tag || !this.completed)
      throw new TopologyError("LIST lacks correlated tagged OK");
    for (const [name, id] of this.ids) {
      const entry = this.entries.get(name);
      if (!entry) throw new TopologyError("STATUS without LIST identity");
      this.entries.set(name, { ...entry, providerMailboxId: id });
    }
    if (
      this.objectId &&
      [...this.entries.values()].some(
        (e) => e.selectable && !e.providerMailboxId,
      )
    )
      throw new TopologyError("OBJECTID LIST omitted selectable MAILBOXID");
    return [...this.entries.values()];
  }
  selectedIdentity() {
    const s = this.selected;
    if (
      !s?.complete ||
      s.epoch === undefined ||
      s.uidNext === undefined ||
      s.exists === undefined ||
      BigInt(s.exists) > s.uidNext - 1n
    )
      throw new TopologyError("Incomplete destination SELECT identity");
    return {
      complete: true as const,
      epoch: s.epoch,
      uidNext: s.uidNext,
      providerId: s.providerId,
      exists: s.exists,
    };
  }
}

/** Narrow use of the installed adapter's command runner: no namespace prefix,
 * XLIST fallback, LSUB, name guesses, STATUS counts or independent transport. */
export async function listOwnedTopology(
  client: ImapFlow,
  collector: TopologyCollector,
) {
  const returns: unknown[] = [];
  const token = (value: string) => ({ type: "ATOM", value });
  if (
    client.capabilities.has("SPECIAL-USE") &&
    (client.capabilities.has("LIST-EXTENDED") ||
      client.capabilities.has("IMAP4rev2"))
  )
    returns.push(token("SPECIAL-USE"));
  const objectId = client.capabilities.has("OBJECTID");
  const inline =
    client.capabilities.has("LIST-STATUS") ||
    client.capabilities.has("IMAP4rev2");
  if (objectId && inline) {
    returns.push(token("STATUS"), [token("MAILBOXID")]);
  }
  const args: unknown[] = ["", "*"];
  if (returns.length) args.push(token("RETURN"), returns);
  const exec = Reflect.get(client, "exec") as (
    command: string,
    args: unknown[],
  ) => Promise<{ next(): void }>;
  const response = await exec.call(client, "LIST", args);
  response.next();
  if (objectId && !inline) {
    for (const entry of collector.statusRequests()) {
      collector.beginStatus(entry.path);
      const status = await exec.call(client, "STATUS", [
        entry.wire,
        [token("MAILBOXID")],
      ]);
      status.next();
      collector.finishStatus();
    }
  }
  return [];
}

/** Exact path EXAMINE avoids ImapFlow's implicit personal-namespace prefix and
 * preparatory LIST. No message, membership or interval commands are issued. */
export async function selectOwnedDestination(
  client: ImapFlow,
  path: string,
  collector: TopologyCollector,
): Promise<SelectedDestination> {
  if (!path || /[\x00-\x1f\x7f]/.test(path) || Buffer.byteLength(path) > 4096)
    throw new TopologyError("Invalid destination path");
  let encoded = path;
  const utf8 =
    client.enabled.has("UTF8=ACCEPT") ||
    (client.capabilities.has("IMAP4rev2") && !Reflect.get(client, "skipRev2"));
  if (!utf8)
    encoded = path.replace(/&|[^\x20-\x7e]+/gu, (part) =>
      part === "&"
        ? "&-"
        : `&${Buffer.from(part, "utf16le").swap16().toString("base64").replace(/=+$/, "").replaceAll("/", ",")}-`,
    );
  collector.beginSelect();
  const exec = Reflect.get(client, "exec") as (
    command: string,
    args: unknown[],
  ) => Promise<{ next(): void }>;
  const response = await exec.call(client, "EXAMINE", [encoded]);
  response.next();
  return { path, ...collector.selectedIdentity() };
}
