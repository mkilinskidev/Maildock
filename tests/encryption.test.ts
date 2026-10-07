import { describe, expect, it } from "vitest";

import { CredentialUnavailableError } from "@/shared/application/secret-encryption";
import { AesGcmSecretEncryption } from "@/shared/infrastructure/crypto/aes-gcm-secret-encryption";

const key = Buffer.alloc(32, 7).toString("base64");
const context =
  "maildock:account-credential:v1:00000000-0000-4000-8000-000000000001:imap";

describe("AES-GCM secret encryption", () => {
  it("round trips a secret and uses a fresh IV and ciphertext", () => {
    const encryption = new AesGcmSecretEncryption("v1", { v1: key });
    const first = encryption.encrypt("provider-password", context);
    const second = encryption.encrypt("provider-password", context);
    expect(encryption.decrypt(first, context)).toBe("provider-password");
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
  });

  it.each(["ciphertext", "authTag"] as const)(
    "fails closed when %s is modified",
    (field) => {
      const encryption = new AesGcmSecretEncryption("v1", { v1: key });
      const envelope = encryption.encrypt("provider-password", context);
      const bytes = Buffer.from(envelope[field], "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      expect(() =>
        encryption.decrypt(
          { ...envelope, [field]: bytes.toString("base64") },
          context,
        ),
      ).toThrow(CredentialUnavailableError);
    },
  );

  it("rejects the wrong key and the wrong AAD account context", () => {
    const encryption = new AesGcmSecretEncryption("v1", { v1: key });
    const envelope = encryption.encrypt("provider-password", context);
    const wrongKey = new AesGcmSecretEncryption("v1", {
      v1: Buffer.alloc(32, 8).toString("base64"),
    });
    expect(() => wrongKey.decrypt(envelope, context)).toThrow(
      CredentialUnavailableError,
    );
    expect(() => encryption.decrypt(envelope, `${context}-other`)).toThrow(
      CredentialUnavailableError,
    );
  });

  it("rejects malformed persisted envelopes", () => {
    const encryption = new AesGcmSecretEncryption("v1", { v1: key });
    expect(() =>
      encryption.decrypt({ version: 1, algorithm: "AES-256-GCM" }, context),
    ).toThrow(CredentialUnavailableError);
  });

  it("can decrypt a previous key while encrypting with the active key", () => {
    const oldEncryption = new AesGcmSecretEncryption("v1", { v1: key });
    const envelope = oldEncryption.encrypt("provider-password", context);
    const rotating = new AesGcmSecretEncryption("v2", {
      v1: key,
      v2: Buffer.alloc(32, 9).toString("base64"),
    });
    expect(rotating.decrypt(envelope, context)).toBe("provider-password");
    expect(rotating.encrypt("new", context).keyId).toBe("v2");
  });
});
