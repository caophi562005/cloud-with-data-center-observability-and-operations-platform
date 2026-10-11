import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLastSeen } from "../src/features/vms/lib/vm-utils";

const NativeDateTimeFormat = Intl.DateTimeFormat;

// Simulate the browser's default timezone while retaining real Intl conversion.
function useBrowserTimeZone(timeZone: string) {
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    return new NativeDateTimeFormat(locales ?? "en-US", { timeZone, ...options });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("browser-local timestamps", () => {
  it("shows Vietnam time instead of forcing UTC", () => {
    useBrowserTimeZone("Asia/Ho_Chi_Minh");
    expect(formatLastSeen("2026-10-04T07:42:00Z")).toBe("Oct 4, 2:42 PM");
  });

  it("changes the calendar day when the browser timezone crosses midnight", () => {
    useBrowserTimeZone("Asia/Tokyo");
    expect(formatLastSeen("2026-10-04T20:42:00Z")).toBe("Oct 5, 5:42 AM");
  });

  it("uses the timestamp's daylight-saving offset rather than a fixed UTC offset", () => {
    useBrowserTimeZone("America/New_York");
    expect(formatLastSeen("2026-01-04T12:00:00Z")).toBe("Jan 4, 7:00 AM");
    expect(formatLastSeen("2026-07-04T12:00:00Z")).toBe("Jul 4, 8:00 AM");
  });

  it("retains the missing-heartbeat state", () => {
    expect(formatLastSeen(null)).toBe("No heartbeat recorded");
  });
});
