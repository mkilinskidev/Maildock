// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AttachmentList } from "@/components/attachment-list";
import type { AttachmentView } from "@/modules/mail/domain/attachments";

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const attachment = (id: string, status: string) =>
  ({
    id,
    filename: `${id}.pdf`,
    type: "application/pdf",
    size: "43008",
    status,
    error: null,
    visible: true,
  }) as unknown as AttachmentView;
async function render(attachments: AttachmentView[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<AttachmentList attachments={attachments} />),
  );
  return host;
}

it("renders each attachment as one download badge without type or Download text", async () => {
  const host = await render([attachment("invoice", "ready")]);
  const badges = host.querySelectorAll(".mail-attachment");
  expect(badges).toHaveLength(1);
  const link = badges[0] as HTMLAnchorElement;
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("/api/attachments/invoice/download");
  expect(link.hasAttribute("download")).toBe(true);
  expect(link.textContent).toBe("invoice.pdf · 42 KB");
  expect(host.textContent).not.toContain("application/pdf");
  expect(host.textContent).not.toContain("Download");
});

it("prepares an unfetched attachment when its badge is clicked", async () => {
  const fetch = vi.fn(async () => Response.json({}, { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  const host = await render([attachment("receipt", "not_fetched")]);
  const badge = host.querySelector<HTMLButtonElement>(
    "button.mail-attachment",
  )!;
  expect(badge.textContent).toBe("receipt.pdf · 42 KB");
  await act(async () => badge.click());
  expect(fetch).toHaveBeenCalledWith("/api/attachments/receipt", {
    method: "POST",
  });
  expect(badge.disabled).toBe(true);
  expect(badge.classList.contains("preparing")).toBe(true);
  expect(badge.getAttribute("aria-busy")).toBe("true");
  expect(badge.textContent).toBe("receipt.pdf · 42 KB");
});
