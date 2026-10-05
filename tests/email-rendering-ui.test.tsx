// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageReader, type MessageDetail } from "@/components/message-reader";
import { RemoteContentSettings } from "@/components/remote-content-settings";

const detail: MessageDetail = {
  id: "message-a",
  seen: false,
  flagged: false,
  subject: "Test",
  date: "2026-10-04",
  sentAt: null,
  from: [{ name: "Microsoft Support", address: "evil@example.test" }],
  to: [],
  cc: [],
  replyTo: [],
  attachments: [],
  content: {
    status: "ready",
    plainText: "Plain fallback",
    sanitizedHtml: "<p>Rich body</p>",
    remoteContentBlocked: true,
    error: null,
  },
};
let root: Root | undefined;
let host: HTMLDivElement;
function Reader({ value = detail }: { value?: MessageDetail }) {
  return (
    <MessageReader
      selectedId={value.id}
      detail={value}
      renderUrl={`/message/${value.id}/render`}
      loadingDetail={false}
      preparing={false}
      prepareError=""
      retrying={false}
      prepare={async () => {}}
      act={async () => {}}
      moveAvailable={() => true}
      retryContent={async () => {}}
    />
  );
}
async function mount(element: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}
async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === label)!
      .click(),
  );
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
describe("received email reader", () => {
  it("gives both inline status notices the same reader spacing class", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          document: "<p>HTML</p>",
          blocked: false,
          pending: true,
          inlineFailures: 1,
        }),
      ),
    );
    await mount(<Reader />);
    const notices = [...host.querySelectorAll(".reader-inline-status")];
    expect(notices.map((notice) => notice.textContent)).toEqual([
      "Preparing inline images…",
      "Some inline images are unavailable.",
    ]);
    expect(
      notices.every((notice) => notice.getAttribute("role") === "status"),
    ).toBe(true);
  });
  it("prefers rich HTML over plain alternative and maintains iframe boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          document: "<p>Rich body</p>",
          blocked: true,
          sender: "evil@example.test",
          pending: false,
          inlineFailures: 0,
        }),
      ),
    );
    await mount(<Reader />);
    const frame = host.querySelector("iframe")!;
    expect(frame.srcdoc).toContain("Rich body");
    expect(host.textContent).not.toContain("Rich body");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-popups allow-popups-to-escape-sandbox",
    );
    expect(frame.getAttribute("sandbox")).not.toMatch(
      /allow-scripts|allow-same-origin|allow-top-navigation/,
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(host.textContent).toContain("Remote images are blocked");
    expect(host.querySelector("pre")).toBeNull();
  });
  it.each([null, "", "   "])(
    "plain text fallback for absent/empty HTML %s",
    async (html) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await mount(
        <Reader
          value={{
            ...detail,
            content: { ...detail.content, sanitizedHtml: html },
          }}
        />,
      );
      expect(host.querySelector("pre")?.textContent).toBe("Plain fallback");
      expect(fetch).not.toHaveBeenCalled();
      expect(host.textContent).not.toContain("Remote images are blocked");
    },
  );
  it("Load images is scoped to current message and never persists sender trust", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string);
      return Response.json({
        document: "<p>HTML</p>",
        blocked: !input.loadImages,
        sender: "evil@example.test",
        pending: false,
        inlineFailures: 0,
      });
    });
    vi.stubGlobal("fetch", fetch);
    await mount(<Reader />);
    await click("Load images");
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body as string)).toEqual({
      loadImages: true,
      trustSender: false,
    });
    expect(host.textContent).not.toContain("Remote images are blocked");
    await act(async () =>
      root!.render(<Reader value={{ ...detail, id: "message-b" }} />),
    );
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body as string)).toEqual({
      loadImages: false,
      trustSender: false,
    });
    expect(host.textContent).toContain("Remote images are blocked");
  });
  it("Always load requests sender trust without submitting display-name identity", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(init.body as string);
      return Response.json({
        document: "<p>HTML</p>",
        blocked: !input.trustSender,
        sender: "evil@example.test",
        pending: false,
        inlineFailures: 0,
      });
    });
    vi.stubGlobal("fetch", fetch);
    await mount(<Reader />);
    await click("Always load from this sender");
    expect(JSON.parse(fetch.mock.calls.at(-1)![1].body as string)).toEqual({
      loadImages: false,
      trustSender: true,
    });
  });
  it("failed rendering remains plain text and missing CID is unobtrusive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await mount(<Reader />);
    expect(host.querySelector("pre")?.textContent).toBe("Plain fallback");
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("HTML could not be displayed");
  });
  it("sender removal is available in settings", async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => Response.json({ removed: true }),
    );
    vi.stubGlobal("fetch", fetch);
    await mount(
      <RemoteContentSettings
        initialSenders={[{ address: "evil@example.test" }]}
      />,
    );
    expect(host.querySelector("table")?.getAttribute("aria-labelledby")).toBe(
      "trusted-senders-title",
    );
    expect(
      [...host.querySelectorAll("th")].map((cell) => cell.textContent),
    ).toEqual(["Email address", "Action"]);
    expect(host.querySelector("tbody tr td")?.textContent).toBe(
      "evil@example.test",
    );
    expect(host.querySelector("tbody button")?.getAttribute("aria-label")).toBe(
      "Remove evil@example.test",
    );
    await click("Remove");
    expect(host.textContent).toContain("No trusted senders");
    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelector(".trusted-senders-empty")?.textContent).toContain(
      "Remote images remain blocked by default.",
    );
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      address: "evil@example.test",
    });
  });
  it("preserves long addresses and aligned row actions when removal fails", async () => {
    const longAddress =
      "windowsinsiderprogram-with-a-long-local-part@e-mails.microsoft.com";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    await mount(
      <RemoteContentSettings
        initialSenders={[
          { address: longAddress },
          { address: "hello@mkilinski.dev" },
        ]}
      />,
    );
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.querySelector("tbody td")?.textContent).toBe(longAddress);
    expect(host.querySelectorAll("tbody tr td:last-child button")).toHaveLength(
      2,
    );
    await click("Remove");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Sender permission could not be removed.",
    );
  });
});
