import type { RemoteMimePart } from "../../accounts/domain/mail-provider";

export {
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
} from "../../../shared/application/attachment-limits";
export type AttachmentView = {
  id: string;
  filename: string | null;
  type: string;
  size: string | null;
  inline: boolean;
  visible: boolean;
  status: string;
  error: string | null;
};
export function safeFilename(value: string | null | undefined) {
  const name = (value ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 180);
  return name && !/^\.+$/.test(name) ? name : "Attachment";
}
export function safeContentType(value: string | null | undefined) {
  return value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
    ? value.toLowerCase()
    : "application/octet-stream";
}
export function downloadDisposition(filename: string | null) {
  const name = safeFilename(filename);
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name.toWellFormed()).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function discoverAttachments(root: RemoteMimePart | null | undefined) {
  const found: {
    partId: string;
    filename: string | null;
    contentType: string;
    disposition: string | null;
    contentId: string | null;
    inline: boolean;
    visible: boolean;
    declaredSize: bigint | null;
  }[] = [];
  function visit(node: RemoteMimePart, isRoot = false) {
    const type = node.type?.toLowerCase() ?? "";
    const disposition = node.disposition?.toLowerCase() ?? null;
    const explicit = disposition === "attachment" || !!node.filename;
    const resource = !!node.contentId || disposition === "inline";
    const body = (type === "text/plain" || type === "text/html") && !explicit;
    const partId = node.part ?? (isRoot && !node.children.length ? "1" : null);
    if (
      !type.startsWith("multipart/") &&
      (explicit ||
        (resource && !body) ||
        (!body &&
          !node.children.length &&
          type.includes("/") &&
          safeContentType(type) === type))
    ) {
      if (partId && /^(?:[1-9]\d*)(?:\.[1-9]\d*)*$/.test(partId)) {
        found.push({
          partId,
          filename: node.filename || null,
          contentType: safeContentType(type),
          disposition,
          contentId: node.contentId || null,
          inline: disposition === "inline" || (!!node.contentId && !explicit),
          visible:
            disposition === "attachment" ||
            (!!node.filename && disposition !== "inline") ||
            (!resource && !body),
          declaredSize:
            node.size && /^\d{1,18}$/.test(node.size)
              ? BigInt(node.size)
              : null,
        });
      }
      return; // Attached message/rfc822 is one downloadable object, not its body children.
    }
    node.children.forEach((child) => visit(child));
  }
  if (root) visit(root, true);
  return found;
}
