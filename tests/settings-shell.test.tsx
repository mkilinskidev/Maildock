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
  oauthProviderId: id === "a" ? null : "microsoft",
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
        oauthProviders={[
          {
            id: "microsoft",
            name: "Microsoft",
            description: "Outlook, Hotmail, Microsoft 365",
            authorizationPath: "/api/oauth/microsoft/start",
            callbackPath: "/api/oauth/microsoft/callback",
            configured: oauthConfigured,
          },
          {
            id: "google",
            name: "Google",
            description: "Gmail / Google Workspace",
            authorizationPath: "/api/oauth/google/start",
            callbackPath: "/api/oauth/google/callback",
            configured: oauthConfigured,
          },
        ]}
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
  const google = list.children[1] as HTMLAnchorElement;
  expect(google.getAttribute("href")).toBe("/api/oauth/google/start");
  expect(google.textContent).toContain("Continue with Google");
  expect(google.textContent).not.toContain("Coming soon");
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
  expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
  expect(host.querySelector('[href="/api/oauth/google/start"]')).toBeNull();
  expect(host.textContent).toContain("Google OAuth is not configured.");
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

it("Phase 3F preserves health and protocol diagnostics while removing message inspection", async () => {
  await mount();
  await click("DPoczta");
  await click("Diagnostics");
  const panel = host.querySelector("#panel-Diagnostics")!;
  expect(panel.textContent).toContain("Last successful sync");
  expect(panel.textContent).toContain("UIDVALIDITY");
  expect(panel.textContent).toContain("UIDNEXT");
  expect(panel.textContent).toContain("HIGHESTMODSEQ");
  expect(panel.textContent).not.toContain("Inspect");
  expect(panel.textContent).not.toContain("message inspection");
  expect(
    panel.querySelector(
      'a[href="/accounts?section=application-logs&account=a"]',
    )?.textContent,
  ).toBe("View related application logs");
  expect(host.querySelector(".settings-nav")?.textContent).toContain(
    "Diagnostics",
  );
});

it("shows OAuth configuration under Integrations and saves a write-only blank secret", async () => {
  await mount(true, false);
  const group = [...host.querySelectorAll(".settings-nav-group")].find(
    (g) => g.querySelector("h2")?.textContent === "Integrations",
  )!;
  expect(group.textContent).toContain("OAuth providers");
  const provider = {
    id: "microsoft",
    name: "Microsoft",
    description: "Outlook / Microsoft 365",
    clientId: "client",
    hasClientSecret: true,
    enabled: true,
    configured: true,
    redirectUri: "https://mail.example.com/api/oauth/microsoft/callback",
  };
  fetcher.mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === "PUT"
      ? Response.json(provider)
      : Response.json({ providers: [provider] }),
  );
  await click("Configure OAuth providers");
  expect(host.textContent).toContain("Configured");
  expect(host.querySelector(".oauth-provider-list")).toBeTruthy();
  expect(host.querySelector("form")).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".oauth-provider-row")!.click(),
  );
  const secret = host.querySelector<HTMLInputElement>(
    'input[name="clientSecret"]',
  )!;
  expect(secret.type).toBe("password");
  expect(secret.value).toBe("");
  expect(host.textContent).toContain("Leave blank to keep it");
  const redirect = [...host.querySelectorAll<HTMLInputElement>("input")].find(
    (i) => i.readOnly,
  )!;
  expect(redirect.value).toBe(provider.redirectUri);
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const call = fetcher.mock.calls.find((c) => c[1]?.method === "PUT")!;
  expect(JSON.parse(call[1].body as string)).toMatchObject({
    providerId: "microsoft",
    clientSecret: "",
  });
  expect(secret.value).toBe("");
  expect(router.refresh).toHaveBeenCalled();
});

const oauthProviderFixture = {
  id: "microsoft",
  name: "Microsoft",
  description: "Outlook / Microsoft 365",
  clientId: "client",
  hasClientSecret: true,
  enabled: true,
  configured: true,
  redirectUri: "https://mail.example.com/api/oauth/microsoft/callback",
};
it("opens Google from the API enumeration in the same generic configuration form", async () => {
  const google = {
    ...oauthProviderFixture,
    id: "google",
    name: "Google",
    description: "Gmail / Google Workspace",
    redirectUri: "https://mail.example.com/api/oauth/google/callback",
  };
  await openOAuthProviders([oauthProviderFixture, google]);
  expect(host.querySelectorAll(".oauth-provider-row")).toHaveLength(2);
  await selectOAuthProvider(1);
  expect(host.querySelector(".settings-pane h2")?.textContent).toBe("Google");
  expect(
    host.querySelector<HTMLInputElement>('[name="clientSecret"]')!.value,
  ).toBe("");
  expect(host.querySelector(".oauth-provider-form")).toBeTruthy();
});
async function openOAuthProviders(providers = [oauthProviderFixture]) {
  await mount();
  fetcher.mockResolvedValue(Response.json({ providers }));
  await click("OAuth providers", host.querySelector(".settings-nav")!);
}
async function selectOAuthProvider(index = 0) {
  await act(async () =>
    host
      .querySelectorAll<HTMLButtonElement>(".oauth-provider-row")
      [index].click(),
  );
}
it("lists every API provider and opens only the selected provider detail", async () => {
  const contributed = {
    ...oauthProviderFixture,
    id: "contributed",
    name: "Contributed provider",
    description: "Test-only provider",
    configured: false,
    enabled: false,
    hasClientSecret: false,
    clientId: "",
    redirectUri: "https://mail.example.com/api/oauth/contributed/callback",
  };
  await openOAuthProviders([oauthProviderFixture, contributed]);
  const rows = host.querySelectorAll(".oauth-provider-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Microsoft");
  expect(rows[1].textContent).toContain("Contributed provider");
  expect(rows[1].textContent).toContain("Not configured");
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector('[name="clientSecret"]')).toBeNull();
  await selectOAuthProvider(1);
  expect(host.querySelector(".settings-pane h2")?.textContent).toBe(
    "Contributed provider",
  );
  expect(
    host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked,
  ).toBe(false);
  expect(
    host.querySelector<HTMLInputElement>('[name="clientSecret"]')!.value,
  ).toBe("");
  expect(host.textContent).toContain("Enter the application client secret.");
  await click("OAuth providers", host.querySelector(".settings-pane")!);
  expect(host.querySelectorAll(".oauth-provider-row")).toHaveLength(2);
});
it("guards leaving edited OAuth details and clears discarded secret input", async () => {
  await openOAuthProviders();
  await selectOAuthProvider();
  await input("clientSecret", "unsaved-private-secret");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await click("OAuth providers", host.querySelector(".settings-pane")!);
  expect(confirm).toHaveBeenCalledWith("Discard unsaved settings changes?");
  expect(
    host.querySelector<HTMLInputElement>('[name="clientSecret"]')!.value,
  ).toBe("unsaved-private-secret");
  await click("Mail", host.querySelector(".settings-nav")!);
  expect(host.querySelector(".oauth-provider-form")).toBeTruthy();
  confirm.mockReturnValue(true);
  await click("OAuth providers", host.querySelector(".settings-pane")!);
  await selectOAuthProvider();
  expect(
    host.querySelector<HTMLInputElement>('[name="clientSecret"]')!.value,
  ).toBe("");
  confirm.mockClear();
  await click("OAuth providers", host.querySelector(".settings-pane")!);
  expect(confirm).not.toHaveBeenCalled();
});
it("disables detail navigation while saving and updates list status from the saved API view", async () => {
  await openOAuthProviders();
  await selectOAuthProvider();
  await act(async () =>
    host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click(),
  );
  let finish!: (response: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  const back = [
    ...host.querySelectorAll<HTMLButtonElement>(".settings-pane button"),
  ].find((b) => b.textContent?.trim() === "OAuth providers")!;
  expect(back.disabled).toBe(true);
  await act(async () => back.click());
  expect(host.querySelector(".oauth-provider-form")).toBeTruthy();
  await act(async () =>
    finish(
      Response.json({
        ...oauthProviderFixture,
        enabled: false,
        configured: false,
      }),
    ),
  );
  expect(back.disabled).toBe(false);
  await click("OAuth providers", host.querySelector(".settings-pane")!);
  expect(host.querySelector(".oauth-provider-row")?.textContent).toContain(
    "Not configured",
  );
  await selectOAuthProvider();
  expect(
    host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked,
  ).toBe(false);
  expect(
    host.querySelector<HTMLInputElement>('[name="clientSecret"]')!.value,
  ).toBe("");
});
