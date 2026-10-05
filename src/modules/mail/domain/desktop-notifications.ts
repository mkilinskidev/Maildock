import type {
  ArrivalNotification,
  NotificationPreferences,
} from "./notifications";

export function notificationPermission():
  NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}
export async function enableNotificationPermission() {
  const permission = notificationPermission();
  // Only the Settings user gesture can call this function. Denial is never retried.
  return permission === "default"
    ? Notification.requestPermission()
    : permission;
}
export function shouldShowDesktopNotification(
  preferences: NotificationPreferences,
) {
  return (
    preferences.enabled &&
    notificationPermission() === "granted" &&
    (!preferences.backgroundOnly ||
      document.visibilityState !== "visible" ||
      !document.hasFocus())
  );
}
export function notificationHref(event: ArrivalNotification) {
  return `/?account=${encodeURIComponent(event.accountId)}&mailbox=${encodeURIComponent(event.mailboxId)}&message=${encodeURIComponent(event.messageId)}`;
}
export function showDesktopNotification(
  event: ArrivalNotification,
  open: (event: ArrivalNotification) => void,
) {
  const notification = new Notification(event.sender, {
    body: `${event.subject}\n${event.accountName}`,
    tag: `maildock-arrival-${event.id}`,
  });
  notification.onclick = (click) => {
    click.preventDefault();
    window.focus();
    open(event);
    notification.close();
  };
  return notification;
}
