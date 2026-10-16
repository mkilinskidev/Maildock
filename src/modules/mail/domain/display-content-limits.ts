/** Complete selected display group, excluding all attachment parts. */
export const DISPLAY_CONTENT_BYTES = 5 * 1024 * 1024;
/** JSON escaping, sanitized markup, derived search text and compact evidence. */
export const CONTENT_PUBLICATION_BYTES = 64 * 1024 * 1024;
/** Headers, MIME discovery and framing across at most 162 partial FETCHes. */
export const CONTENT_PROTOCOL_BYTES = 256 * 1024;

export class DisplayContentLimitError extends Error {
  constructor(limit = DISPLAY_CONTENT_BYTES, message?: string) {
    super(
      message ??
        `Message display content exceeds the encoded or decoded limit (${limit} bytes; maximum 5 MiB).`,
    );
    this.name = "DisplayContentLimitError";
  }
}
