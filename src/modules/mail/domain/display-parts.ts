import type { RemoteMimePart } from "../../accounts/domain/mail-provider";

export type DisplayPart = Readonly<{
  part: string;
  type: "text/plain" | "text/html";
}>;

function isBody(node: RemoteMimePart, transport: "imap" | "gmail"): boolean {
  return (
    (node.type === "text/plain" || node.type === "text/html") &&
    node.disposition !== "attachment" &&
    !node.filename &&
    typeof node.part === "string" &&
    (transport === "gmail" || /^(?:[1-9]\d*)(?:\.[1-9]\d*)*$/.test(node.part))
  );
}

/** Pick one body branch. Alternatives can contribute one plain and one HTML part. */
export function selectDisplayParts(
  root: RemoteMimePart | null | undefined,
  transport: "imap" | "gmail" = "imap",
): DisplayPart[] {
  if (!root) return [];
  // ImapFlow leaves `part` unset on a single-part BODYSTRUCTURE. Its
  // download(uid, "1") path explicitly maps that body to the IMAP TEXT section.
  if (
    root.part === null &&
    root.children.length === 0 &&
    (root.type === "text/plain" || root.type === "text/html") &&
    root.disposition !== "attachment" &&
    !root.filename
  )
    return [{ part: "1", type: root.type }];
  function visit(node: RemoteMimePart): DisplayPart[] {
    if (node.disposition === "attachment" || node.filename) return [];
    if (isBody(node, transport))
      return [{ part: node.part!, type: node.type as DisplayPart["type"] }];
    if (!node.type.startsWith("multipart/")) return [];
    if (node.type === "multipart/alternative") {
      const choices = node.children.flatMap(visit);
      const plain = choices.findLast((part) => part.type === "text/plain");
      const html = choices.findLast((part) => part.type === "text/html");
      return [plain, html].filter((part): part is DisplayPart => !!part);
    }
    // mixed/related: the first usable body subtree is the display body.
    for (const child of node.children) {
      const selected = visit(child);
      if (selected.length) return selected;
    }
    return [];
  }
  return visit(root);
}

export function attachmentMetadata(root: RemoteMimePart | null | undefined) {
  const found: {
    filename: string | null;
    type: string;
    size: string | null;
  }[] = [];
  function visit(node: RemoteMimePart) {
    if (node.disposition === "attachment" || node.filename) {
      found.push({ filename: node.filename, type: node.type, size: node.size });
      return;
    }
    node.children.forEach(visit);
  }
  if (root) visit(root);
  return found;
}
