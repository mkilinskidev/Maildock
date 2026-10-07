import pino from "pino";

import type { AppConfig } from "../config/config.js";

export function createLogger(
  config: Pick<AppConfig, "logLevel">,
  destination?: pino.DestinationStream,
) {
  const options = {
    level: config.logLevel,
    redact: {
      paths: [
        "password",
        "*.password",
        "**.password",
        "auth.pass",
        "*.auth.pass",
        "**.auth.pass",
        "secret",
        "token",
        "accessToken",
        "*.accessToken",
        "**.accessToken",
        "refreshToken",
        "*.refreshToken",
        "**.refreshToken",
        "clientSecret",
        "*.clientSecret",
        "**.clientSecret",
        "code",
        "*.code",
        "**.code",
        "authorization",
        "cookie",
        "req.headers.authorization",
        "req.headers.cookie",
        "databaseUrl",
        "authSecret",
        "credentialsEncryptionKey",
        "credentialsEncryption",
      ],
      censor: "[REDACTED]",
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
