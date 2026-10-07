import { describe, expect, it } from "vitest";
import { messageDate } from "@/shared/application/message-date";
describe("local message dates", () => {
  const now = new Date(2026, 9, 4, 18, 0);
  it("shows time today and full local date/time in title", () => {
    const date = new Date(2026, 9, 4, 15, 42);
    const result = messageDate(date.toISOString(), now, "en-GB");
    expect(result.text).toBe("15:42");
    expect(result.title).toContain("2026");
    expect(result.title).toContain("15:42");
  });
  it("omits current year and includes previous years", () => {
    expect(
      messageDate(new Date(2026, 9, 3).toISOString(), now, "en-GB").text,
    ).toBe("3 Oct");
    expect(
      messageDate(new Date(2024, 9, 4).toISOString(), now, "en-GB").text,
    ).toBe("4 Oct 2024");
  });
  it("uses local calendar boundaries and locale", () => {
    const jan = new Date(2027, 0, 1, 0, 5);
    expect(
      messageDate(new Date(2026, 11, 31, 23, 59).toISOString(), jan, "en-GB")
        .text,
    ).toBe("31 Dec 2026");
    expect(
      messageDate(new Date(2027, 0, 1, 0, 1).toISOString(), jan, "en-GB").text,
    ).toBe("00:01");
    expect(
      messageDate(new Date(2026, 9, 3).toISOString(), now, "de-DE").text,
    ).toBe(
      new Intl.DateTimeFormat("de-DE", {
        day: "numeric",
        month: "short",
      }).format(new Date(2026, 9, 3)),
    );
  });
});
