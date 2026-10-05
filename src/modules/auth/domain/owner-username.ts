import { z } from "zod";

export const ownerUsernameMinLength = 3;
export const ownerUsernameMaxLength = 64;

// Validate the actual identity; setup trims surrounding whitespace before parsing.
export const ownerUsernameSchema = z
  .string()
  .min(ownerUsernameMinLength)
  .max(ownerUsernameMaxLength)
  .regex(
    /^[a-zA-Z0-9_.-]+$/,
    "Use letters, numbers, dots, underscores, or hyphens.",
  );

export function isOwnerUsername(username: string): boolean {
  return ownerUsernameSchema.safeParse(username).success;
}

export function normalizeOwnerUsername(username: string): string {
  return username.toLowerCase();
}
