// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LogoutButton } from "@/components/logout-button";
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
let root: Root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function click(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<LogoutButton />));
  await act(async () => host.querySelector("button")!.click());
  return host;
}
it("redirects and refreshes after confirmed logout", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true }));
  const host = await click(fetcher);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/sign-out",
    expect.objectContaining({ method: "POST" }),
  );
  expect(router.replace).toHaveBeenCalledWith("/login");
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it.each(["server", "network"])(
  "shows uncertain revocation without redirecting on %s failure",
  async (mode) => {
    const fetcher =
      mode === "server"
        ? vi
            .fn()
            .mockResolvedValue(
              Response.json({ error: "failure" }, { status: 500 }),
            )
        : vi.fn().mockRejectedValue(new Error("network failure"));
    const host = await click(fetcher);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Sign out could not be confirmed. Your session may still be active.",
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(host.querySelector("button")!.disabled).toBe(false);
  },
);
