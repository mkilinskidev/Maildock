// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopNotifications } from "@/components/desktop-notifications";
import { NotificationSettings } from "@/components/notification-settings";
import {
  defaultNotificationPreferences,
  matchesNotificationPreferences,
} from "@/modules/mail/domain/notifications";
import {
  enableNotificationPermission,
  notificationHref,
  shouldShowDesktopNotification,
  showDesktopNotification,
} from "@/modules/mail/domain/desktop-notifications";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";

const arrival = {
  id: "12",
  accountId: "00000000-0000-4000-8000-000000000001",
  mailboxId: "00000000-0000-4000-8000-000000000002",
  messageId: "00000000-0000-4000-8000-000000000003",
  sender: "Alice",
  subject: "New message",
  accountName: "Personal",
};
const preferences = { ...defaultNotificationPreferences, enabled: true };
const constructed: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(
    async () => "granted" as NotificationPermission,
  );
  onclick?: (event: Event) => void;
  onclose?: () => void;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    constructed.push(this);
  }
}
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("isSecureContext", true);
  FakeNotification.permission = "granted";
  FakeNotification.requestPermission.mockReset().mockResolvedValue("granted");
  constructed.length = 0;
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(element: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}
it.each(["denied", "granted", "default"] as const)(
  "handles %s permission without retrying denial",
  async (permission) => {
    FakeNotification.permission = permission;
    const result = await enableNotificationPermission();
    expect(result).toBe(permission === "default" ? "granted" : permission);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(
      permission === "default" ? 1 : 0,
    );
  },
);
it("handles unsupported and insecure browsers without a permission request", async () => {
  vi.stubGlobal("Notification", undefined);
  expect(await enableNotificationPermission()).toBe("unsupported");
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("isSecureContext", false);
  expect(await enableNotificationPermission()).toBe("unsupported");
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
});
it("only suppresses background-only delivery when the tab is both visible and focused", () => {
  vi.mocked(document.hasFocus).mockReturnValue(true);
  expect(shouldShowDesktopNotification(preferences)).toBe(false);
  expect(
    shouldShowDesktopNotification({ ...preferences, backgroundOnly: false }),
  ).toBe(true);
  vi.mocked(document.hasFocus).mockReturnValue(false);
  expect(shouldShowDesktopNotification(preferences)).toBe(true);
  vi.mocked(document.hasFocus).mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  expect(shouldShowDesktopNotification(preferences)).toBe(true);
  FakeNotification.permission = "denied";
  expect(shouldShowDesktopNotification(preferences)).toBe(false);
  FakeNotification.permission = "granted";
  expect(shouldShowDesktopNotification(defaultNotificationPreferences)).toBe(
    false,
  );
});
it("keeps account and folder filtering independent", () => {
  expect(
    matchesNotificationPreferences(preferences, arrival.accountId, true),
  ).toBe(true);
  expect(
    matchesNotificationPreferences(preferences, arrival.accountId, false),
  ).toBe(false);
  expect(
    matchesNotificationPreferences(
      { ...preferences, folders: "all" },
      arrival.accountId,
      false,
    ),
  ).toBe(true);
  expect(
    matchesNotificationPreferences(
      { ...preferences, accountIds: [] },
      arrival.accountId,
      true,
    ),
  ).toBe(false);
  expect(
    matchesNotificationPreferences(
      { ...preferences, accountIds: [arrival.accountId] },
      "other",
      true,
    ),
  ).toBe(false);
});
it("uses only sender, subject and account context, focuses and opens the original tab's exact placement", () => {
  const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
  const openTab = vi.spyOn(window, "open");
  const open = vi.fn();
  showDesktopNotification(arrival, open);
  expect(constructed[0].title).toBe("Alice");
  expect(constructed[0].options).toEqual({
    body: "New message\nPersonal",
    tag: "maildock-arrival-12",
  });
  const click = new Event("click", { cancelable: true });
  constructed[0].onclick!(click);
  expect(click.defaultPrevented).toBe(true);
  expect(focus).toHaveBeenCalledOnce();
  expect(openTab).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(arrival);
  expect(constructed[0].close).toHaveBeenCalledOnce();
  expect(notificationHref(arrival)).toBe(
    `/?account=${arrival.accountId}&mailbox=${arrival.mailboxId}&message=${arrival.messageId}`,
  );
});
it("starts at the durable baseline, avoids overlapping polls and duplicate responses, and starts fresh on reload", async () => {
  vi.useFakeTimers();
  let consumed = false;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { action } = JSON.parse(init.body as string);
    if (action === "start") return Response.json({ preferences, events: [] });
    if (consumed) return Response.json({ preferences, events: [] });
    consumed = true;
    return Response.json({ preferences, events: [arrival, arrival] });
  });
  vi.stubGlobal("fetch", fetcher);
  const open = vi.fn();
  await mount(<DesktopNotifications onOpen={open} />);
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual({
    action: "start",
  });
  expect(constructed).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(constructed).toHaveLength(1);
  await act(async () => root!.unmount());
  root = undefined;
  await mount(<DesktopNotifications onOpen={open} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(constructed).toHaveLength(1);
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
});
it("consumes foreground events without replaying them after focus is lost", async () => {
  vi.useFakeTimers();
  vi.mocked(document.hasFocus).mockReturnValue(true);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ preferences, events: [] }))
    .mockResolvedValueOnce(Response.json({ preferences, events: [arrival] }))
    .mockResolvedValue(Response.json({ preferences, events: [] }));
  vi.stubGlobal("fetch", fetcher);
  await mount(<DesktopNotifications onOpen={vi.fn()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(constructed).toHaveLength(0);
});
const accounts = [
  {
    id: arrival.accountId,
    enabled: true,
    displayName: "Personal",
    email: "owner@example.test",
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    enabled: false,
    displayName: "Disabled",
  },
] as MailAccountView[];
it("shows defaults, requests permission through an explicit enable gesture and persists account/folder/background settings", async () => {
  FakeNotification.permission = "default";
  const fetcher = vi
    .fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValue(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await mount(<NotificationSettings accounts={accounts} />);
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>("input")];
  expect(inputs().map((i) => i.checked)).toEqual([
    false,
    true,
    false,
    true,
    true,
  ]);
  expect(host.textContent).not.toContain("Disabled");
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  await act(async () => inputs()[0].click());
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual(
    preferences,
  );
  await act(async () => inputs()[2].click());
  await act(async () => inputs()[3].click());
  await act(async () => inputs()[4].click());
  expect(JSON.parse(fetcher.mock.lastCall![1].body as string)).toEqual({
    ...preferences,
    folders: "all",
    accountIds: [],
    backgroundOnly: false,
  });
});
it("keeps preferences disabled after denial and clearly explains how to unblock delivery", async () => {
  FakeNotification.permission = "default";
  FakeNotification.requestPermission.mockResolvedValue("denied");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await mount(<NotificationSettings accounts={accounts} />);
  const enable = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => enable.click());
  expect(enable.checked).toBe(false);
  expect(enable.disabled).toBe(true);
  await act(async () => enable.click());
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Notifications are blocked");
});
it("clearly disables unsupported delivery without requesting permission or saving enablement", async () => {
  vi.stubGlobal("Notification", undefined);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await mount(<NotificationSettings accounts={accounts} />);
  expect(host.textContent).toContain("unsupported");
  expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not overlap polling requests or deliver after unmount", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  await mount(<DesktopNotifications onOpen={vi.fn()} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () =>
    finish(Response.json({ preferences, events: [arrival] })),
  );
  expect(constructed).toHaveLength(0);
});
