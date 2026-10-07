"use client";
import { useEffect, useRef } from "react";
import type {
  ArrivalNotification,
  NotificationPreferences,
} from "@/modules/mail/domain/notifications";
import {
  shouldShowDesktopNotification,
  showDesktopNotification,
} from "@/modules/mail/domain/desktop-notifications";

export function DesktopNotifications({
  onOpen,
}: {
  onOpen: (event: ArrivalNotification) => void;
}) {
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);
  useEffect(() => {
    let cancelled = false,
      busy = false,
      started = false;
    const active = new Set<Notification>();
    const seen = new Set<string>();
    async function poll() {
      if (busy || cancelled) return;
      busy = true;
      try {
        const response = await fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: started ? "poll" : "start" }),
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const result = (await response.json()) as {
          preferences: NotificationPreferences;
          events: ArrivalNotification[];
        };
        if (cancelled) return;
        started = true;
        for (const event of result.events) {
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          if (seen.size > 500) seen.delete(seen.values().next().value!);
          if (!shouldShowDesktopNotification(result.preferences)) continue;
          try {
            const notification = showDesktopNotification(event, (arrival) => {
              openRef.current(arrival);
            });
            active.add(notification);
            notification.onclose = () => active.delete(notification);
          } catch {
            /* Some browsers expose permission but cannot construct desktop notifications. */
          }
        }
      } catch {
        /* A failed request retries without a permission prompt. */
      } finally {
        busy = false;
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const notification of active) notification.close();
    };
  }, []);
  return null;
}
