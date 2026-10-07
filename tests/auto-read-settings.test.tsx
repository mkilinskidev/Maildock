// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AutoReadSettings } from "@/components/auto-read-settings";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetcher = vi.fn().mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<AutoReadSettings />));
}
const secondsInput = () =>
  host.querySelector<HTMLInputElement>('[aria-label="Auto-read seconds"]')!;
const radio = (mode: string) =>
  host.querySelector<HTMLInputElement>(`input[value="${mode}"]`)!;
async function enter(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(secondsInput(), text);
    secondsInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("shows native radio choices and automatically saves the same preference model", async () => {
  await mount();
  expect(radio("after").checked).toBe(true);
  expect(secondsInput().value).toBe("2");
  expect(secondsInput().disabled).toBe(false);
  expect(host.querySelector("select")).toBeNull();
  expect(host.querySelector("button")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => radio("manually").click());
  expect(secondsInput().disabled).toBe(true);
  expect(host.textContent).toContain("Never automatically");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/settings/auto-read",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ mode: "manually", seconds: 2 }),
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Saved");
  await act(async () => radio("immediately").click());
  expect(secondsInput().disabled).toBe(true);
  await act(async () => radio("after").click());
  expect(secondsInput().disabled).toBe(false);
});
it("lets a complete number be typed then automatically saves it", async () => {
  vi.useFakeTimers();
  await mount();
  await enter("1");
  await enter("15");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(399);
  });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].body).toBe(
    JSON.stringify({ mode: "after", seconds: 15 }),
  );
});
it.each(["", "0", "3601", "1.5"])(
  "preserves validation and does not save invalid seconds (%s)",
  async (text) => {
    vi.useFakeTimers();
    await mount();
    await enter(text);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(secondsInput().getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "whole number",
    );
  },
);
it("flushes a valid delay on blur", async () => {
  vi.useFakeTimers();
  await mount();
  await enter("8");
  await act(async () =>
    secondsInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].body).toBe(
    JSON.stringify({ mode: "after", seconds: 8 }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it("switches mode during delay editing with one save containing the latest valid delay", async () => {
  vi.useFakeTimers();
  await mount();
  await enter("9");
  await act(async () =>
    secondsInput().dispatchEvent(
      new FocusEvent("focusout", {
        bubbles: true,
        relatedTarget: radio("manually"),
      }),
    ),
  );
  await act(async () => radio("manually").click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].body).toBe(
    JSON.stringify({ mode: "manually", seconds: 9 }),
  );
});
it("keeps failed automatic saves visible and allows another choice to retry", async () => {
  await mount();
  fetcher.mockRejectedValueOnce(Error("Network"));
  await act(async () => radio("immediately").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "could not be saved",
  );
  expect(radio("immediately").disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => radio("after").click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});
