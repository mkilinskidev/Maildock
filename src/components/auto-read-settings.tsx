"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  autoReadSchema,
  defaultAutoRead,
  type AutoReadPreference,
} from "@/modules/mail/domain/mail-interactions";

export function AutoReadSettings({
  initialValue = defaultAutoRead,
}: {
  initialValue?: AutoReadPreference;
}) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initialValue);
  const [seconds, setSeconds] = useState(String(initialValue.seconds));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function cancelSave() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }
  function validated(next: AutoReadPreference) {
    if (autoReadSchema.safeParse(next).success) return true;
    setError("Enter a whole number of seconds from 1 to 3600.");
    setStatus("");
    return false;
  }
  async function save(next: AutoReadPreference) {
    cancelSave();
    if (!validated(next)) return;
    setValue(next);
    setPending(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/settings/auto-read", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok)
        throw Error("Automatic read preference could not be saved.");
      setStatus("Saved");
      router.refresh();
    } catch {
      setError("Automatic read preference could not be saved.");
    } finally {
      setPending(false);
    }
  }
  function choose(mode: AutoReadPreference["mode"]) {
    cancelSave();
    const enteredSeconds = Number(seconds);
    const validSeconds = autoReadSchema.safeParse({
      ...value,
      seconds: enteredSeconds,
    }).success;
    const next = {
      ...value,
      mode,
      seconds:
        mode === "after" || validSeconds ? enteredSeconds : value.seconds,
    };
    setValue({ ...value, mode });
    if (mode !== "after") setSeconds(String(next.seconds));
    void save(next);
  }
  function changeSeconds(text: string) {
    cancelSave();
    setSeconds(text);
    const next = { ...value, seconds: Number(text) };
    if (!validated(next)) return;
    setError("");
    setStatus("Saving…");
    // Let a complete number be entered before saving. Blur flushes it immediately.
    timer.current = setTimeout(() => void save(next), 400);
  }
  const choice = (mode: AutoReadPreference["mode"], label: string) => (
    <label className="mail-preference-option">
      <input
        type="radio"
        name={`${id}-mode`}
        value={mode}
        checked={value.mode === mode}
        disabled={pending}
        onChange={() => choose(mode)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <section className="mail-preferences" aria-labelledby={`${id}-heading`}>
      <div className="mail-preferences-heading">
        <h2 id={`${id}-heading`}>Automatically mark as read</h2>
      </div>
      <p className="mail-preference-description" id={`${id}-description`}>
        Choose when an opened message should be marked as read.
      </p>
      <fieldset
        className="mail-preference-options"
        aria-labelledby={`${id}-heading`}
        aria-describedby={`${id}-description`}
      >
        {choice("immediately", "Immediately")}
        <div className="auto-read-after">
          {choice("after", "After")}
          <input
            type="number"
            className="auto-read-seconds"
            aria-label="Auto-read seconds"
            min={1}
            max={3600}
            step={1}
            required
            value={seconds}
            disabled={value.mode !== "after" || pending}
            aria-invalid={
              !autoReadSchema.safeParse({ ...value, seconds: Number(seconds) })
                .success
            }
            onChange={(event) => changeSeconds(event.target.value)}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof HTMLInputElement &&
                event.relatedTarget.type === "radio" &&
                event.relatedTarget.name === `${id}-mode`
              ) {
                cancelSave();
                return;
              }
              if (timer.current)
                void save({ ...value, seconds: Number(seconds) });
            }}
          />
          <span>seconds</span>
        </div>
        {choice("manually", "Never automatically")}
      </fieldset>
      <p className="preference-save-status" role="status">
        {pending ? "Saving…" : status}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
