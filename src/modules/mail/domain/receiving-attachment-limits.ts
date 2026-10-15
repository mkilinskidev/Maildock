/** Incoming retrieval only; upload/outgoing and display-content policies are independent. */
export const RECEIVING_ATTACHMENT_BYTES = 100 * 1024 * 1024;
// QP can expand every byte to =XX plus soft wrapping. Reject excessive whitespace.
export const RECEIVING_ATTACHMENT_ENCODED_BYTES =
  4 * RECEIVING_ATTACHMENT_BYTES;
export const RECEIVING_ATTACHMENT_LIFETIME_MS = 15 * 60 * 1000;
export const RECEIVING_ATTACHMENT_CHUNK = 32 * 1024;
