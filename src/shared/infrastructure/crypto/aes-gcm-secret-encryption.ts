import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  CredentialUnavailableError,
  type EncryptedEnvelope,
  type SecretEncryption,
} from "../../application/secret-encryption";

const ALGORITHM = "aes-256-gcm";
const AUTH_TAG_LENGTH = 16;
const IV_LENGTH = 12;

function canonicalBase64(length?: number) {
  return z.string().refine((value) => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    ) {
      return false;
    }
    const decoded = Buffer.from(value, "base64");
    return (
      decoded.toString("base64") === value &&
      (length === undefined || decoded.byteLength === length)
    );
  }, "Invalid encoded encryption data.");
}

export const encryptedEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    keyId: z.string().regex(/^v[1-9][0-9]*$/),
    iv: canonicalBase64(IV_LENGTH),
    ciphertext: canonicalBase64(),
    authTag: canonicalBase64(AUTH_TAG_LENGTH),
  })
  .strict();

export class AesGcmSecretEncryption implements SecretEncryption {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    private readonly activeKeyId: string,
    configuredKeys: Readonly<Record<string, string>>,
  ) {
    this.keys = new Map(
      Object.entries(configuredKeys).map(([id, value]) => [
        id,
        Buffer.from(value, "base64"),
      ]),
    );
    if (!this.keys.has(activeKeyId)) {
      throw new Error("The active credential encryption key is unavailable.");
    }
  }

  encrypt(plaintext: string, context: string): EncryptedEnvelope {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new CredentialUnavailableError();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: this.activeKeyId,
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(envelope: unknown, context: string): string {
    try {
      const parsed = encryptedEnvelopeSchema.parse(envelope);
      const key = this.keys.get(parsed.keyId);
      if (!key) throw new Error("Unknown encryption key.");
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(parsed.iv, "base64"),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(parsed.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new CredentialUnavailableError();
    }
  }
}
