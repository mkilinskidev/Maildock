"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";
const choices: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", icon: Sun },
  { value: "dark", label: "Dark theme", icon: Moon },
  { value: "system", label: "System theme", icon: Monitor },
];
function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}
function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== "maildock-theme") return;
    const value = event.newValue;
    document.documentElement.dataset.theme =
      value === "light" || value === "dark" ? value : "system";
    onChange();
  };
  window.addEventListener("maildock-theme-change", onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("maildock-theme-change", onChange);
    window.removeEventListener("storage", onStorage);
  };
}
function changeTheme(value: Theme) {
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem("maildock-theme", value);
  } catch {
    /* Storage may be unavailable. */
  }
  window.dispatchEvent(new Event("maildock-theme-change"));
}

export function ThemeControl() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "system");
  return (
    <div className="theme-control" role="group" aria-label="Appearance">
      {choices.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={theme === value ? "active" : ""}
          onClick={() => changeTheme(value)}
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
        >
          <Icon size={15} strokeWidth={1.8} />
        </button>
      ))}
    </div>
  );
}
