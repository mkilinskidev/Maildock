import { sourceContext } from "./compose-source";
import { z } from "zod";
import addressparser from "nodemailer/lib/addressparser";

export type OutgoingAddress = Readonly<{ name?: string; address: string }>;
export const UNCERTAIN_SEND =
  "Maildock could not confirm whether this message was sent.";
const header = z.string().refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const composeInput = z
  .object({
    accountId: z.uuid(),
    source: sourceContext.optional(),
    to: header.max(8000),
    cc: header.max(8000).default(""),
    bcc: header.max(8000).default(""),
    subject: header.max(998),
    plainText: z
      .string()
      .max(500_000)
      .refine((value) => !value.includes("\x00")),
  })
  .strict();

/** Nodemailer handles mailbox syntax; Zod validates each actual addr-spec.
 * Intentionally restrict this phase to ordinary Internet addresses (no groups). */
export function parseOutgoingAddresses(input: string): OutgoingAddress[] {
  header.max(8000).parse(input);
  if (!input.trim()) return [];
  // The parser is deliberately forgiving of unfinished editor input. Reject
  // unbalanced quoting/brackets before accepting its normalized mailboxes.
  let quoted = false;
  let escaped = false;
  let angle = false;
  const segments: string[] = [];
  let segment = "";
  for (const character of input) {
    if (character === "," && !quoted && !angle) {
      segments.push(segment.trim());
      segment = "";
      continue;
    }
    segment += character;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "<") {
      if (angle) throw Error("Invalid recipient address.");
      angle = true;
    }
    if (character === ">") {
      if (!angle) throw Error("Invalid recipient address.");
      angle = false;
    }
  }
  if (quoted || angle || escaped) throw Error("Invalid recipient address.");
  segments.push(segment.trim());
  return segments.map((raw) => {
    const parsed = addressparser(raw);
    if (parsed.length !== 1 || parsed[0].group !== undefined)
      throw Error("Invalid recipient address.");
    const item = parsed[0];
    // Do not accept parser repairs of trailing garbage or unfinished list entries.
    const spec = raw.endsWith(">")
      ? raw.slice(raw.lastIndexOf("<") + 1, -1).trim()
      : raw;
    if (z.email().parse(spec) !== item.address)
      throw Error("Invalid recipient address.");
    const address = z.email().max(254).parse(item.address);
    const name = header.max(200).parse(item.name);
    return { address, ...(name ? { name } : {}) };
  });
}
