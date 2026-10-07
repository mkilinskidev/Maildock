// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentCopySettings } from "@/components/sent-copy-settings";
import type { MailboxRoleView } from "@/modules/mail/application/mailbox-role-service";
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
describe("account Sent policy", () => {
  let root: Root | undefined;
  let host: HTMLDivElement;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    refresh.mockClear();
  });
  async function render(policy: "server" | "maildock", role?: MailboxRoleView) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <SentCopySettings
          accountId="account"
          initialPolicy={policy}
          sentRole={role}
        />,
      ),
    );
  }
  it("lets the owner explicitly choose Maildock using the existing account PUT API", async () => {
    const fetch = vi.fn(async () => Response.json({ account: {} }));
    vi.stubGlobal("fetch", fetch);
    await render("server");
    expect(
      host.querySelector<HTMLInputElement>('[value="server"]')!.checked,
    ).toBe(true);
    await act(async () =>
      host.querySelector<HTMLInputElement>('[value="maildock"]')!.click(),
    );
    expect(host.textContent).toContain("Sent mailbox unavailable");
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/accounts/account", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentCopyPolicy: "maildock" }),
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it.each(["manual", "special_use"] as const)(
    "displays the %s semantic destination without a second selector",
    async (source) => {
      await render("maildock", {
        role: "sent",
        mailboxId: "mapped",
        mailboxName: "Custom output",
        source,
        available: true,
      });
      expect(host.textContent).toContain("Custom output");
      expect(host.textContent).toContain(
        source === "manual" ? "Manual" : "Auto",
      );
      expect(host.querySelector("select")).toBeNull();
    },
  );
  it("keeps an unavailable mapping visible without resetting Maildock policy", async () => {
    await render("maildock", {
      role: "sent",
      mailboxId: "missing",
      mailboxName: "Unavailable",
      source: "manual",
      available: false,
    });
    expect(
      host.querySelector<HTMLInputElement>('[value="maildock"]')!.checked,
    ).toBe(true);
    expect(host.textContent).toContain("System folders → Sent");
  });
});
