import { describe, expect, it } from "vitest";
import { resolveApiOrigin } from "../config/api-origin";

describe("public API origin", () => {
  it.each([undefined, null, ""])(
    "keeps missing development configuration relative (%s)",
    (value) => expect(resolveApiOrigin(value, false)).toBe(""),
  );

  it.each([undefined, null, ""])(
    "rejects missing production configuration (%s)",
    (value) => expect(() => resolveApiOrigin(value, true)).toThrow(),
  );

  it.each([
    "https://api.opsgrid.hacmieu.com",
    "https://api.opsgrid.hacmieu.com/",
    "https://API.OPSGRID.HACMIEU.COM:443/",
  ])("normalizes a valid HTTPS origin (%s)", (value) => {
    expect(resolveApiOrigin(value, true)).toBe(
      "https://api.opsgrid.hacmieu.com",
    );
    expect(resolveApiOrigin(value, false)).toBe(
      "https://api.opsgrid.hacmieu.com",
    );
  });

  it.each([
    1,
    {},
    [],
    " ",
    " https://api.opsgrid.hacmieu.com",
    "https://api.opsgrid.hacmieu.com ",
    "https://api.\nopsgrid.hacmieu.com",
    "http://api.opsgrid.hacmieu.com",
    "//api.opsgrid.hacmieu.com",
    "/api/v1",
    "https://user:secret@api.opsgrid.hacmieu.com",
    "https://@api.opsgrid.hacmieu.com",
    "https://api.opsgrid.hacmieu.com/api/v1",
    "https://api.opsgrid.hacmieu.com//",
    "https://api.opsgrid.hacmieu.com/.",
    "https://api.opsgrid.hacmieu.com/path/..",
    "https://api.opsgrid.hacmieu.com?",
    "https://api.opsgrid.hacmieu.com?token=secret",
    "https://api.opsgrid.hacmieu.com/#",
    "https://api.opsgrid.hacmieu.com/#fragment",
    "https://api.opsgrid.hacmieu.com\\",
    "https://",
    "https://api.opsgrid.hacmieu.com:invalid",
  ])("rejects malformed or unsafe configuration (%s)", (value) => {
    expect(() => resolveApiOrigin(value, false)).toThrow();
    expect(() => resolveApiOrigin(value, true)).toThrow();
  });

  it("does not leak supplied credential material in configuration errors", () => {
    expect(() =>
      resolveApiOrigin("https://user:do-not-log-me@api.opsgrid.hacmieu.com", true),
    ).toThrow(/^VITE_API_URL must be an HTTPS origin$/);
  });
});
