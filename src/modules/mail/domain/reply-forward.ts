import { z } from "zod";
import {
  parseOutgoingAddresses,
  type OutgoingAddress,
} from "./outgoing-message";
import type { ComposeMode } from "./compose-source";

type Address = Readonly<{ address?: string; name?: string }>;
export type ReplySource = {
  from: readonly Address[];
  sender: readonly Address[];
  replyTo: readonly Address[];
  to: readonly Address[];
  cc: readonly Address[];
  subject: string | null;
  rfcMessageId: string | null;
  references: string | null;
  sentAt: Date | null;
  internalDate: Date;
};
export class ReplyUnavailableError extends Error {}
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
export function safeAddresses(input: readonly Address[]): OutgoingAddress[] {
  return input.flatMap((item) => {
    const address = item.address?.trim();
    if (!address || !z.email().max(254).safeParse(address).success) return [];
    const name = clean(item.name ?? "").slice(0, 200);
    return [{ address, ...(name ? { name } : {}) }];
  });
}
export function formatAddresses(input: readonly OutgoingAddress[]): string {
  return input
    .map((item) =>
      item.name
        ? `${JSON.stringify(item.name)} <${item.address}>`
        : item.address,
    )
    .join(", ");
}
export function replyRecipients(
  source: ReplySource,
  self: string,
  all: boolean,
) {
  const own = new Set(
    parseOutgoingAddresses(self).map((a) => a.address.toLowerCase()),
  );
  const withoutSelf = (items: OutgoingAddress[]) =>
    items.filter((a) => !own.has(a.address.toLowerCase()));
  const replyTo = withoutSelf(safeAddresses(source.replyTo));
  const effectiveFrom = safeAddresses(source.from);
  const from = withoutSelf(effectiveFrom);
  // Sender is a fallback only when no usable author mailbox exists.
  const author = replyTo.length
    ? replyTo
    : from.length
      ? from
      : effectiveFrom.length
        ? []
        : withoutSelf(safeAddresses(source.sender));
  const seen = new Map<string, { address: string; name?: string }>();
  const unique = (items: OutgoingAddress[]) =>
    items.flatMap((a) => {
      const key = a.address.toLowerCase();
      if (own.has(key)) return [];
      const previous = seen.get(key);
      if (previous) {
        if (!previous.name && a.name) previous.name = a.name;
        return [];
      }
      const mailbox = { ...a };
      seen.set(key, mailbox);
      return [mailbox];
    });
  const to = unique([...author, ...(all ? safeAddresses(source.to) : [])]);
  const cc = unique(all ? safeAddresses(source.cc) : []);
  if (!to.length && !cc.length)
    throw new ReplyUnavailableError("No usable reply recipient is available.");
  return { to: formatAddresses(to), cc: formatAddresses(cc) };
}
// Conservative Internet message-id subset; never repair unsafe tokens into IDs.
const idPattern =
  /^<[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*>$/;
export function validMessageId(
  value: string | null | undefined,
): string | undefined {
  return value && value.length <= 254 && idPattern.test(value)
    ? value
    : undefined;
}
export function threading(
  source: Pick<ReplySource, "rfcMessageId" | "references">,
  mode: ComposeMode,
) {
  if (mode === "forward")
    return { inReplyTo: null, references: [] as string[] };
  const inReplyTo = validMessageId(source.rfcMessageId) ?? null;
  const ids =
    (source.references ?? "").slice(-65536).match(/<[^<>\s]+>/g) ?? [];
  const references = [...new Set(ids.filter((id) => validMessageId(id)))];
  if (inReplyTo) {
    const previous = references.indexOf(inReplyTo);
    if (previous >= 0) references.splice(previous, 1);
    references.push(inReplyTo);
  }
  while (references.length > 30 || references.join(" ").length > 4000)
    references.shift();
  return { inReplyTo, references };
}
export function derivedSubject(subject: string | null, mode: ComposeMode) {
  const prefix = mode === "forward" ? "Fwd" : "Re";
  const value = clean(subject ?? "").replace(
    new RegExp(`^(?:${prefix}:\\s*)+`, "i"),
    "",
  );
  return `${prefix}: ${value || "(No subject)"}`.slice(0, 998);
}
export function derivedBody(
  source: ReplySource,
  text: string,
  mode: ComposeMode,
) {
  const date = (source.sentAt ?? source.internalDate).toUTCString();
  const from =
    formatAddresses(safeAddresses(source.from)) ||
    formatAddresses(safeAddresses(source.sender)) ||
    "Unknown sender";
  const body = text.replace(/\r\n?/g, "\n").replace(/\x00/g, "");
  if (mode === "forward")
    return `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${date}\nSubject: ${clean(source.subject ?? "")}\nTo: ${formatAddresses(safeAddresses(source.to))}${source.cc.length ? `\nCc: ${formatAddresses(safeAddresses(source.cc))}` : ""}\n\n${body}`;
  return `\n\nOn ${date}, ${from} wrote:\n${body
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n")}`;
}
