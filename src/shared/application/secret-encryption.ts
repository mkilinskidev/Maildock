export type EncryptedEnvelope = Readonly<{
  version: 1;
  algorithm: "AES-256-GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}>;

export interface SecretEncryption {
  encrypt(plaintext: string, context: string): EncryptedEnvelope;
  decrypt(envelope: unknown, context: string): string;
}

export class CredentialUnavailableError extends Error {
  constructor() {
    super("The stored credential could not be used.");
    this.name = "CredentialUnavailableError";
  }
}
