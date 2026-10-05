import { z } from "zod";

export const eventLevels = ["info", "warning", "error"] as const;
export const eventAreas = [
  "system",
  "account",
  "sync",
  "imap",
  "smtp",
  "jobs",
] as const;
export const eventDefinitions = {
  "account.connected": {
    level: "info",
    area: "account",
    message: "Account connection verified",
  },
  "account.connection_failed": {
    level: "error",
    area: "account",
    message: "Account connection failed",
  },
  "mail.recent_sync_completed": {
    level: "info",
    area: "sync",
    message: "Recent mailbox synchronization completed",
  },
  "mail.recent_sync_failed": {
    level: "error",
    area: "sync",
    message: "Recent mailbox synchronization failed",
  },
  "mail.sync_failed": {
    level: "error",
    area: "sync",
    message: "Mailbox synchronization failed",
  },
  "mail.epoch_reset": {
    level: "warning",
    area: "imap",
    message: "Mailbox UIDVALIDITY changed; resynchronization required",
  },
  "mail.sent": {
    level: "info",
    area: "smtp",
    message: "Outgoing message sent",
  },
  "mail.send_failed": {
    level: "error",
    area: "smtp",
    message: "Outgoing message permanently failed",
  },
  "mail.send_uncertain": {
    level: "warning",
    area: "smtp",
    message: "Outgoing delivery is uncertain; check the server before retrying",
  },
} as const;
export type ApplicationEventName = keyof typeof eventDefinitions;
// Explicit allowlist: unknown keys and exception objects never reach storage or UI.
export const diagnosticDetailsSchema = z
  .object({
    category: z
      .enum([
        "dns_or_host_unreachable",
        "connection_timeout",
        "tls_certificate_failure",
        "authentication_rejected",
        "starttls_unavailable",
        "verification_failed",
        "internal_error",
      ])
      .optional(),
    mailboxPath: z.string().max(512).optional(),
    uidValidity: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
  })
  .strip();
export type DiagnosticDetails = z.infer<typeof diagnosticDetailsSchema>;
export function safeDiagnosticDetails(input: unknown): DiagnosticDetails {
  const parsed = diagnosticDetailsSchema.safeParse(input);
  return parsed.success ? parsed.data : {};
}
export const eventQuerySchema = z.object({
  level: z.enum(eventLevels).optional(),
  area: z.enum(eventAreas).optional(),
  accountId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type EventQuery = z.infer<typeof eventQuerySchema>;
export type ApplicationEventView = {
  id: string;
  createdAt: string;
  level: (typeof eventLevels)[number];
  area: (typeof eventAreas)[number];
  event: ApplicationEventName;
  message: string;
  accountId: string | null;
  mailboxId: string | null;
  accountName: string | null;
  mailboxPath: string | null;
  details: DiagnosticDetails;
};
export type ApplicationEventPage = {
  events: ApplicationEventView[];
  nextCursor: string | null;
};
