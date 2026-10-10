// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentList } from "@/components/attachment-list";
import { RichEmailBody } from "@/components/rich-email-body";
import type { AttachmentView } from "@/modules/mail/domain/attachments";

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
}
it("makes the complete attachment chip a download link with a readable filename and size", async () => {
  mount();
  const filename = "long-document-".repeat(20) + ".pdf";
  await act(async () =>
    root!.render(
      <AttachmentList
        attachments={
          [
            {
              id: "file",
              filename,
              size: "1536",
              type: "application/pdf",
              status: "ready",
              visible: true,
              error: null,
            },
            { id: "inline", visible: false },
          ] as AttachmentView[]
        }
      />,
    ),
  );
  const link = host.querySelector<HTMLAnchorElement>("a")!;
  expect(link.classList.contains("mail-attachment")).toBe(true);
  expect(link.getAttribute("href")).toBe("/api/attachments/file/download");
  expect(link.hasAttribute("download")).toBe(true);
  expect(link.tabIndex).toBe(0);
  expect(link.textContent).toContain(filename);
  expect(link.textContent).toContain("2 KB");
  expect(host.textContent).not.toMatch(/application\/pdf|Download/);
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelectorAll("a")).toHaveLength(1);
});
it("prepares uncached attachments and automatically downloads through the authorized endpoint", async () => {
  vi.useFakeTimers();
  mount();
  const fetcher = vi.fn(async () =>
    Response.json({ status: "ready", error: null }),
  );
  vi.stubGlobal("fetch", fetcher);
  const downloaded: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloaded.push(this.getAttribute("href")!);
  });
  await act(async () =>
    root!.render(
      <AttachmentList
        attachments={
          [
            {
              id: "file",
              filename: "report.pdf",
              size: "1048576",
              type: "application/pdf",
              status: "not_fetched",
              visible: true,
              error: null,
            },
          ] as AttachmentView[]
        }
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>("button")!;
  expect(button.textContent).toContain("report.pdf");
  expect(button.textContent).toContain("1.0 MB");
  expect(button.tabIndex).toBe(0);
  await act(async () => button.click());
  expect(fetcher).toHaveBeenCalledWith("/api/attachments/file", {
    method: "POST",
  });
  expect(button.disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(downloaded).toEqual(["/api/attachments/file/download"]);
  expect(host.querySelector("a")?.textContent).toContain("report.pdf");
});
it("keeps the actual email iframe light, sandboxed and isolated from the app theme", async () => {
  mount();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        document: "<p>Fixture</p>",
        blocked: false,
        trusted: false,
        sender: null,
        pending: false,
        inlineFailures: 0,
      }),
    ),
  );
  await act(async () =>
    root!.render(<RichEmailBody url="/fixture/render" plainText={null} />),
  );
  const iframe = host.querySelector("iframe")!;
  expect(iframe.style.colorScheme).toBe("only light");
  expect(iframe.getAttribute("sandbox")).toBe(
    "allow-popups allow-popups-to-escape-sandbox",
  );
  expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
});
