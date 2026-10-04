import { z } from "zod";

export const autoReadSchema = z.object({
  mode: z.enum(["immediately", "after", "manually"]),
  seconds: z.number().int().min(1).max(3600),
});
export type AutoReadPreference = z.infer<typeof autoReadSchema>;
export const defaultAutoRead: AutoReadPreference = {
  mode: "after",
  seconds: 2,
};

export function editingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-lexical-editor]',
      ),
    )
  );
}

export function autoReadDelay(preference: AutoReadPreference): number | null {
  return preference.mode === "manually"
    ? null
    : preference.mode === "immediately"
      ? 0
      : preference.seconds * 1000;
}
