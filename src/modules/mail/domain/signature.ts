import {
  richElement,
  validateRichDocument,
  type RichDocument,
  type RichNode,
} from "./rich-document";

// Canonical exact structural comparison, independent of JSON property order.
export function signatureContent(node: RichNode): string {
  const normalized = validateRichDocument({
    version: 1,
    editor: { root: richElement("root", node.children ?? []) },
  });
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(
    canonical({
      children: normalized.editor.root.children,
      format: node.format ?? "",
      direction: node.direction ?? null,
      indent: node.indent ?? 0,
    }),
  );
}
export async function signatureFingerprint(node: RichNode): Promise<string> {
  const bytes = new TextEncoder().encode(signatureContent(node));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function automaticSignature(
  id: string,
  document: RichDocument,
): Promise<RichNode> {
  const node = richElement(
    "maildock-signature",
    structuredClone(validateRichDocument(document).editor.root.children!),
    { signatureId: id },
  );
  node.fingerprint = await signatureFingerprint(node);
  return node;
}
export type SignatureChoice = { id: string; name: string };
export type SignatureDefaults = {
  new: string | null;
  reply: string | null;
  forward: string | null;
};
export type SignatureCatalog = {
  signatures: SignatureChoice[];
  defaults: Record<string, SignatureDefaults>;
};
