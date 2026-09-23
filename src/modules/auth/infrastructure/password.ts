import { hash, verify, type Options } from "@node-rs/argon2";

export const argon2idParameters = Object.freeze({
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
  algorithm: 2,
} satisfies Options);

export function hashPassword(password: string): Promise<string> {
  return hash(password, argon2idParameters);
}

export function verifyPassword(input: {
  password: string;
  hash: string;
}): Promise<boolean> {
  return verify(input.hash, input.password, argon2idParameters);
}
