import type { AttachmentView } from "@/modules/mail/domain/attachments";

/** One upload operation for Compose and signature editing. */
export async function uploadComposeFile(
  file: File,
  inline: boolean,
  ownerId: string,
): Promise<AttachmentView> {
  const response = await fetch("/api/attachments/staged", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Attachment-Filename": encodeURIComponent(file.name),
      "X-Draft-Id": ownerId,
      "X-Attachment-Disposition": inline ? "inline" : "attachment",
    },
    body: file,
  });
  const result = (await response.json()) as AttachmentView;
  if (!response.ok) throw Error(result.error ?? "Attachment upload failed.");
  return { ...result, inline, visible: !inline };
}
