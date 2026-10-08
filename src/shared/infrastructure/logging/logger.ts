import pino from "pino";

import type { AppConfig } from "../config/config";

export function createLogger(
  config: Pick<AppConfig, "logLevel">,
  destination?: pino.DestinationStream,
) {
  const options = {
    level: config.logLevel,
    redact: {
      // Fallback only: root/one-object-level fields and explicit req headers.
      // No recursive descent, array traversal or Error/free-text sanitization.
      // Callers must supply allowlisted diagnostics, never arbitrary objects.
      paths: [
        ...[
          "password",
          "Password",
          "secret",
          "proofCode",
          "totpURI",
          "recoveryCodes",
          "backupCodes",
          "replacementAuthority",
          "tokenDigest",
          "sessionToken",
          "token",
          "accessToken",
          "access_token",
          "refreshToken",
          "refresh_token",
          "clientSecret",
          "client_secret",
          "imapPassword",
          "smtpPassword",
          "code",
          "authorization",
          "Authorization",
          "cookie",
          "Cookie",
          "databaseUrl",
          "authSecret",
          "bootstrapSecret",
          "bootstrapSecretDigest",
          "credentialsEncryptionKey",
          "credentialsEncryption",
        ].flatMap((field) => [field, `*.${field}`]),
        "auth.pass",
        "*.auth.pass",
        "req.headers.authorization",
        "req.headers.Authorization",
        "req.headers.cookie",
        "req.headers.Cookie",
      ],
      censor: "[REDACTED]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
