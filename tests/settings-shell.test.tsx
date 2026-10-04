// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsShell } from "@/components/settings-shell";
import type { MailAccountView } from "@/modules/accounts/application/accounts-service";
import type { MailboxView } from "@/modules/mail/application/mailbox-service";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/rich-composer", () => ({
  RichComposer: () => <div>Signature editor</div>,
}));
vi.mock("@/components/message-list", () => ({ MessageList: () => null }));
const accounts = ["a", "b"].map((id) => ({
  id,
  displayName: id === "a" ? "DPoczta" : "Microsoft",
  senderDisplayName: id === "a" ? "Mateusz Kiliński" : "Other Sender",
  email: `${id}@example.com`,
  enabled: true,
  providerType: "imap_smtp",
  authMethod: id === "a" ? "password" : "oauth2",
  oauthStatus: id === "a" ? null : "reconnect_required",
  sentCopyPolicy: "server",
  imap: {
    host: "imap.example.com",
    port: 993,
    security: "tls",
    username: id,
    hasStoredPassword: true,
  },
  smtp: {
    host: "smtp.example.com",
    port: 465,
    security: "tls",
    useImapCredentials: true,
    hasStoredPassword: false,
  },
  connectionStatus: "verified",
  imapResult: { status: "success" },
  smtpResult: { status: "success" },
  lastSuccessfulConnectionTestAt: null,
  mailboxDiscovery: {
    status: "success",
    error: null,
    capabilities: ["MOVE"],
    lastSuccessfulAt: null,
  },
})) as unknown as MailAccountView[];
const catalog = {
  signatures: [{ id: "signature-a", name: "Work" }],
  defaults: { a: { new: "signature-a", reply: null, forward: null } },
};
let root: Root, host: HTMLDivElement;
let fetcher: ReturnType<typeof vi.fn>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(initialAddAccount = false, oauthConfigured = true) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetcher = vi.fn(async (url: string) =>
    url === "/api/signatures"
      ? Response.json(catalog)
      : Response.json({
          account: accounts[0],
          result: { imap: { success: true }, smtp: { success: true } },
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <SettingsShell
        accounts={accounts}
        mailboxesByAccount={{
          a: [
            {
              id: "folder-a",
              name: "Sent A",
              selectable: true,
              lifecycleStatus: "active",
              recentSync: {
                status: "success",
                lastSuccessfulAt: "2026-10-04T10:00:00Z",
              },
              deltaSync: { status: "success", lastSuccessfulAt: null },
              backfill: { status: "complete" },
              attributes: [],
              specialUse: [],
            } as unknown as MailboxView,
          ],
          b: [],
        }}
        rolesByAccount={{ a: [], b: [] }}
        signatureCatalog={catalog}
        conversationEnabled={true}
        trustedSenders={[{ address: "trusted@example.com" }]}
        oauthConfigured={oauthConfigured}
        initialAddAccount={initialAddAccount}
        oauthResult={{}}
      />,
    ),
  );
}
async function click(text: string, scope: ParentNode = host) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent?.trim() === text ||
      b.querySelector("span")?.textContent === text,
  )!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function input(name: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(label: string, value: string) {
  const field = host.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )!;
  await act(async () => {
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("navigates existing preferences with a persistent grouped rail", async () => {
  await mount();
  expect(
    host.querySelector('[aria-label="Settings navigation"]')?.textContent,
  ).toContain("General");
  expect(
    [...host.querySelectorAll("nav button")].find(
      (b) => b.textContent === "+ Add account",
    )?.textContent,
  ).toBe("+ Add account");
  const dark = host.querySelector<HTMLButtonElement>(
    '[aria-label="Dark theme"]',
  )!;
  await act(async () => dark.click());
  expect(document.documentElement.dataset.theme).toBe("dark");
  await click("Mail");
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Conversation view"]')
      ?.checked,
  ).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLInputElement>('[aria-label="Conversation view"]')!
      .click(),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/settings/conversation-view",
    expect.objectContaining({ body: JSON.stringify({ enabled: false }) }),
  );
  await click("Remote images");
  expect(host.textContent).toContain("trusted@example.com");
  await click("Remove");
  expect(host.textContent).not.toContain("trusted@example.com");
  await click("Signatures");
  expect(host.textContent).toContain("Work");
  expect(host.querySelector('[aria-label="Settings navigation"]')).toBeTruthy();
});
it("separates identity, saves folder mappings and signature defaults to the selected account", async () => {
  await mount();
  await click("DPoczta");
  expect(
    host.querySelector<HTMLInputElement>('[name="displayName"]')?.value,
  ).toBe("DPoczta");
  expect(
    host.querySelector<HTMLInputElement>('[name="senderDisplayName"]')?.value,
  ).toBe("Mateusz Kiliński");
  await input("senderDisplayName", "New Sender");
  await choose("Sent mailbox", "folder-a");
  await choose("Replies signature", "signature-a");
  const form = host.querySelector<HTMLFormElement>("#panel-General form")!;
  await act(async () =>
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/accounts/a/settings",
    expect.objectContaining({
      body: JSON.stringify({
        identity: {
          displayName: "DPoczta",
          senderDisplayName: "New Sender",
          email: "a@example.com",
        },
        folders: { sent: "folder-a" },
        signatures: { new: "signature-a", reply: "signature-a", forward: null },
      }),
    }),
  );
  await click("Microsoft");
  expect(
    host.querySelector<HTMLInputElement>('[name="senderDisplayName"]')?.value,
  ).toBe("Other Sender");
  expect(
    host.querySelector('[aria-label="Sent mailbox"]')?.textContent,
  ).not.toContain("Sent A");
});
it("retains edits across tabs and protects section, account and link navigation", async () => {
  await mount();
  await click("DPoczta");
  await input("displayName", "Edited");
  await click("IMAP");
  await input("imapHost", "new.example.com");
  await click("General");
  expect(
    host.querySelector<HTMLInputElement>('[name="displayName"]')?.value,
  ).toBe("Edited");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("Microsoft");
  expect(confirm).toHaveBeenCalled();
  expect(
    host.querySelector<HTMLInputElement>('[name="displayName"]')?.value,
  ).toBe("Edited");
  await click("Appearance");
  expect(host.querySelector("#panel-General")).toBeTruthy();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const restore = vi.spyOn(window.history, "pushState");
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(restore).toHaveBeenCalled();
  const leave = new MouseEvent("click", { bubbles: true, cancelable: true });
  host.querySelector('[href="/"]')!.dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  await click("IMAP");
  expect(host.querySelector<HTMLInputElement>('[name="imapHost"]')?.value).toBe(
    "new.example.com",
  );
  confirm.mockReturnValue(true);
  await click("Microsoft");
  expect(
    host.querySelector<HTMLInputElement>('[name="displayName"]')?.value,
  ).toBe("Microsoft");
});
it("shows password replacement only, supports tests, and presents OAuth without password fields", async () => {
  await mount();
  await click("DPoczta");
  await click("IMAP");
  expect(
    host.querySelector<HTMLInputElement>('[name="imapPassword"]')?.value,
  ).toBe("");
  await click("Test connection", host.querySelector("#panel-IMAP")!);
  const call = fetcher.mock.calls.find(
    ([url]) => url === "/api/accounts/a/test",
  )!;
  expect(JSON.parse(call[1].body).imap).not.toHaveProperty("password");
  await click("Diagnostics");
  expect(host.querySelector("#panel-Diagnostics")?.textContent).toContain(
    "MOVE",
  );
  expect(host.querySelector("#panel-Diagnostics")?.textContent).toContain(
    "Last successful sync",
  );
  await click("Microsoft");
  await click("IMAP");
  expect(host.querySelector("#panel-IMAP")?.textContent).toContain(
    "Reconnect required",
  );
  expect(host.querySelector('#panel-IMAP input[type="password"]')).toBeNull();
  expect(
    host.querySelector('[href="/api/oauth/microsoft/start?accountId=b"]'),
  ).toBeTruthy();
  expect(host.querySelector<HTMLInputElement>('[name="email"]')?.readOnly).toBe(
    true,
  );
});
it("protects an active signature editor when switching settings", async () => {
  await mount();
  await click("Signatures");
  await click("+ Add signature");
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("Mail");
  expect(host.textContent).toContain("Signature editor");
});

it("keeps one Add action and only configured accounts under Accounts; providers live in the content pane", async () => {
  await mount();
  const group = [...host.querySelectorAll(".settings-nav-group")].find(
    (g) => g.querySelector("h2")?.textContent === "Accounts",
  )!;
  expect(
    [...group.querySelectorAll("button")].map(
      (b) => b.querySelector("span")?.textContent ?? b.textContent,
    ),
  ).toEqual(["DPoczta", "Microsoft", "+ Add account"]);
  expect(group.querySelectorAll("a")).toHaveLength(0);
  expect(host.textContent).not.toContain("Connect Microsoft account");
  await click("+ Add account");
  const pane = host.querySelector(".settings-pane")!;
  expect(pane.querySelector("h2")?.textContent).toBe("Add email account");
  const list = pane.querySelector(".account-provider-list")!;
  expect(
    [...list.children].map((row) => row.querySelector("strong")?.textContent),
  ).toEqual(["Microsoft", "Google", "Other email"]);
  expect(list.querySelector("a")?.getAttribute("href")).toBe(
    "/api/oauth/microsoft/start",
  );
  const google = list.children[1] as HTMLButtonElement;
  expect(google.disabled).toBe(true);
  expect(google.textContent).toContain("Coming soon");
  await act(async () => google.click());
  expect(pane.querySelector(".account-provider-list")).toBeTruthy();
  await act(async () => (list.children[2] as HTMLButtonElement).click());
  expect(pane.querySelector("form")).toBeTruthy();
  expect(host.querySelector(".settings-nav")).toBeTruthy();
  await click("Back");
  expect(pane.querySelector(".account-provider-list")).toBeTruthy();
});

it("opens deep-linked onboarding and displays unconfigured Microsoft without starting OAuth", async () => {
  await mount(true, false);
  const rows = host.querySelector(".account-provider-list")!.children;
  expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
  expect(rows[0].textContent).toContain("Not configured");
  expect(host.querySelector('[href="/api/oauth/microsoft/start"]')).toBeNull();
});

async function openCreate() {
  await click("+ Add account");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        ".account-provider-list button:last-child",
      )!
      .click(),
  );
}
async function fillCreate() {
  for (const [name, value] of Object.entries({
    displayName: "New mail",
    senderDisplayName: "Sender",
    email: "new@example.com",
    imapHost: "imap.example.com",
    imapUsername: "new",
    imapPassword: "private-password",
    smtpHost: "smtp.example.com",
  }))
    await input(name, value);
}

it("shares create/edit identity and connection controls, tests without persisting, and opens the created account", async () => {
  await mount();
  await click("DPoczta");
  const identityNames = [
    ...host.querySelectorAll("#panel-General input[name]"),
  ].map((e) => e.getAttribute("name"));
  await click("IMAP");
  const connectionNames = [
    ...host.querySelectorAll(
      "#panel-IMAP .settings-connection-fields input[name], #panel-IMAP .settings-connection-fields select[name]",
    ),
  ]
    .map((e) => e.getAttribute("name"))
    .filter((name) => name !== "sentCopyPolicy");
  await openCreate();
  expect(
    [
      ...host.querySelectorAll(".settings-create-form .settings-fields input"),
    ].map((e) => e.getAttribute("name")),
  ).toEqual(identityNames);
  expect(
    [
      ...host.querySelectorAll(
        ".settings-create-form .settings-connection-fields input[name], .settings-create-form .settings-connection-fields select[name]",
      ),
    ].map((e) => e.getAttribute("name")),
  ).toEqual(connectionNames);
  expect(
    host.querySelector<HTMLInputElement>('[name="imapPassword"]')!.required,
  ).toBe(true);
  await fillCreate();
  await click("Test connection");
  expect(host.textContent).toContain("IMAP connection successful");
  expect(fetcher.mock.calls.some(([url]) => url === "/api/accounts")).toBe(
    false,
  );
  const created = {
    ...accounts[0],
    id: "new-id",
    displayName: "New mail",
    email: "new@example.com",
  };
  fetcher.mockResolvedValueOnce(
    Response.json({ account: created }, { status: 201 }),
  );
  await click("Create account");
  const call = fetcher.mock.calls.find(([url]) => url === "/api/accounts")!;
  expect(call[1].method).toBe("POST");
  expect(JSON.parse(call[1].body)).toMatchObject({
    displayName: "New mail",
    senderDisplayName: "Sender",
    email: "new@example.com",
    imap: { password: "private-password" },
    smtp: { useImapCredentials: true },
  });
  expect(router.replace).toHaveBeenCalledWith("/accounts?account=new-id");
  expect(host.querySelector(".settings-pane h2")?.textContent).toBe("New mail");
  expect(
    host.querySelector('nav [aria-current="page"]')?.textContent,
  ).toContain("New mail");
  await click("IMAP");
  expect(
    host.querySelector<HTMLInputElement>('[name="imapPassword"]')!.value,
  ).toBe("");
  expect(host.innerHTML).not.toContain("private-password");
});

it("protects dirty onboarding and recovers from failed requests without losing credentials", async () => {
  await mount();
  await openCreate();
  await fillCreate();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("Back");
  expect(confirm).toHaveBeenCalled();
  expect(host.querySelector(".settings-create-form")).toBeTruthy();
  fetcher.mockRejectedValueOnce(new Error("private-password"));
  await click("Test connection");
  expect(host.textContent).toContain("Check your connection");
  expect(host.textContent).not.toContain("private-password");
  expect(
    host.querySelector<HTMLInputElement>('[name="imapPassword"]')!.value,
  ).toBe("private-password");
  confirm.mockReturnValue(true);
  await click("Back");
  expect(host.querySelector(".account-provider-list")).toBeTruthy();
});
