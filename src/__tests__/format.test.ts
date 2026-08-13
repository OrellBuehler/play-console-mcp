import { describe, it, expect } from "vitest";
import { ok, err, resolvePackage } from "../play/format.js";

describe("format helpers", () => {
  it("ok passes strings through unquoted and stringifies objects", () => {
    expect(ok("plain text").content[0].text).toBe("plain text");
    expect(ok({ a: 1 }).content[0].text).toBe('{"a":1}');
  });

  it("err marks the response as an error", () => {
    const res = err(new Error("boom"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("boom");
  });

  it("resolvePackage prefers the explicit argument over the default", () => {
    expect(resolvePackage("com.acme.app", "com.default.app")).toBe("com.acme.app");
    expect(resolvePackage(undefined, "com.default.app")).toBe("com.default.app");
    expect(resolvePackage("  ", "com.default.app")).toBe("com.default.app");
  });

  it("resolvePackage throws when neither is set", () => {
    expect(() => resolvePackage(undefined, undefined)).toThrow("No package name given");
  });
});
