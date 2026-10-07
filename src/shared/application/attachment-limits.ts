export const DEFAULT_ATTACHMENT_LIMITS = Object.freeze({
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxOutgoingAttachmentBytes: 18 * 1024 * 1024,
  maxOutgoingMimeBytes: 25 * 1024 * 1024,
});
export type AttachmentLimits = typeof DEFAULT_ATTACHMENT_LIMITS;
