import { z } from "zod";

export const transportSecuritySchema = z.enum(["tls", "starttls"]);
export type TransportSecurity = z.infer<typeof transportSecuritySchema>;
export const sentCopyPolicySchema = z.enum(["server", "maildock"]);
export type SentCopyPolicy = z.infer<typeof sentCopyPolicySchema>;
export const sentCopyPolicyUpdateSchema = z
  .object({ sentCopyPolicy: sentCopyPolicySchema })
  .strict();

const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), "Invalid host.");
const usernameSchema = z.string().trim().min(1).max(320);
const passwordSchema = z.string().min(1).max(4096);
export const senderDisplayNameSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Invalid sender name.",
  );
export const accountIdentitySchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    senderDisplayName: senderDisplayNameSchema,
    email: z.email().max(320),
  })
  .strict();

export const connectionSettingsSchema = z.object({
  host: hostSchema,
  port: z.coerce.number().int().min(1).max(65535),
  security: transportSecuritySchema,
  username: usernameSchema,
});

export const createAccountInputSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(100),
    senderDisplayName: senderDisplayNameSchema.optional(),
    email: z.email().max(320),
    enabled: z.boolean().default(true),
    sentCopyPolicy: sentCopyPolicySchema.optional(),
    providerType: z.literal("imap_smtp").default("imap_smtp"),
    imap: connectionSettingsSchema.extend({ password: passwordSchema }),
    smtp: connectionSettingsSchema.omit({ username: true }).extend({
      useImapCredentials: z.boolean().default(true),
      username: z.string().trim().max(320).optional(),
      password: passwordSchema.optional(),
    }),
  })
  .superRefine((value, context) => {
    if (!value.smtp.useImapCredentials && !value.smtp.username) {
      context.addIssue({
        code: "custom",
        path: ["smtp", "username"],
        message: "SMTP username is required.",
      });
    }
    if (!value.smtp.useImapCredentials && !value.smtp.password) {
      context.addIssue({
        code: "custom",
        path: ["smtp", "password"],
        message: "SMTP password is required.",
      });
    }
  });

export const updateAccountInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    senderDisplayName: senderDisplayNameSchema.optional(),
    email: z.email().max(320),
    enabled: z.boolean(),
    sentCopyPolicy: sentCopyPolicySchema.optional(),
    providerType: z.literal("imap_smtp"),
    imap: connectionSettingsSchema.extend({
      password: passwordSchema.optional(),
    }),
    smtp: connectionSettingsSchema.omit({ username: true }).extend({
      useImapCredentials: z.boolean(),
      username: z.string().trim().max(320).optional(),
      password: passwordSchema.optional(),
    }),
  })
  .superRefine((value, context) => {
    if (!value.smtp.useImapCredentials && !value.smtp.username) {
      context.addIssue({
        code: "custom",
        path: ["smtp", "username"],
        message: "SMTP username is required.",
      });
    }
  });

export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;

export const accountCredentialContext = (
  accountId: string,
  purpose: "imap" | "smtp" | "oauth-cache",
) => `maildock:account-credential:v1:${accountId}:${purpose}`;
