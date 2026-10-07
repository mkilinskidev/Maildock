import { z } from "zod";

export const passwordMinLength = 12;
export const passwordMaxLength = 128;
export const ownerPasswordSchema = z
  .string()
  .min(passwordMinLength)
  .max(passwordMaxLength);
