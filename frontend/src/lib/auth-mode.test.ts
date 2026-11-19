import { describe, expect, it } from "vitest";
import {
  authModeHref,
  isOriginRejection,
  nextTabIndex,
  originRejectionMessage,
  parseAuthMode,
  parseSignupReason,
  safeNextPath,
  SIGNUP_REASON_COPY,
} from "./auth-mode";

describe("parseAuthMode", () => {
  it("deep-links sign-up and defaults to sign-in", () => {
    expect(parseAuthMode("signup")).toBe("signup");
    expect(parseAuthMode(" SignUp ")).toBe("signup");
    expect(parseAuthMode(["signup", "signin"])).toBe("signup");
    expect(parseAuthMode("signin")).toBe("signin");
    expect(parseAuthMode("register")).toBe("signin");
    expect(parseAuthMode(undefined)).toBe("signin");
    expect(parseAuthMode(null)).toBe("signin");
  });
});

describe("authModeHref", () => {
  it("sets and clears mode, keeps next, drops a stale error", () => {
    expect(authModeHref("signup", "?next=%2Fteams&error=INVALID_TOKEN")).toBe(
      "/signin?next=%2Fteams&mode=signup",
    );
    expect(authModeHref("signin", "?next=%2Fteams&mode=signup")).toBe("/signin?next=%2Fteams");
    expect(authModeHref("signin", "")).toBe("/signin");
  });
});

describe("nextTabIndex", () => {
  it("wraps with arrows and jumps with Home/End", () => {
    expect(nextTabIndex("ArrowRight", 0, 2)).toBe(1);
    expect(nextTabIndex("ArrowRight", 1, 2)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 2)).toBe(1);
    expect(nextTabIndex("ArrowLeft", 1, 2)).toBe(0);
    expect(nextTabIndex("Home", 1, 2)).toBe(0);
    expect(nextTabIndex("End", 0, 2)).toBe(1);
  });

  it("ignores other keys and empty lists", () => {
    expect(nextTabIndex("Enter", 0, 2)).toBeNull();
    expect(nextTabIndex("ArrowDown", 0, 2)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("origin rejection", () => {
  it("recognises Better Auth's invalid-origin 403", () => {
    expect(isOriginRejection({ status: 403, message: "Invalid origin" })).toBe(true);
    expect(isOriginRejection({ status: 403, code: "INVALID_ORIGIN" })).toBe(true);
    expect(isOriginRejection({ status: 403 })).toBe(true);
    expect(isOriginRejection({ status: 403, message: "Email not verified" })).toBe(false);
    expect(isOriginRejection({ status: 400, message: "Invalid origin" })).toBe(false);
    expect(isOriginRejection(null)).toBe(false);
  });

  it("names the canonical host when it is known", () => {
    expect(originRejectionMessage("https://apex.example.run.app")).toContain("apex.example.run.app");
    expect(originRejectionMessage(undefined)).toMatch(/main address/);
    expect(originRejectionMessage("nope")).toMatch(/main address/);
  });
});

describe("parseSignupReason", () => {
  it("accepts the two reasons the site links with", () => {
    expect(parseSignupReason("reminders")).toBe("reminders");
    expect(parseSignupReason("spoilers")).toBe("spoilers");
  });

  it("takes the first of a repeated parameter", () => {
    expect(parseSignupReason(["spoilers", "reminders"])).toBe("spoilers");
  });

  it("is case-insensitive and trims, like the mode", () => {
    expect(parseSignupReason(" Reminders ")).toBe("reminders");
  });

  it.each([[undefined], [null], [""], ["other"], ["constructor"], ["__proto__"], ["reminders,spoilers"]])(
    "ignores anything else (%s)",
    (value) => {
      expect(parseSignupReason(value as string | null | undefined)).toBeNull();
    }
  );
});

describe("safeNextPath", () => {
  it.each([
    ["/"],
    ["/account#reminders"],
    ["/standings?season=2024"],
    ["/watch/2026-20"],
    ["/schedule/2026/5"],
  ])("keeps a same-site path (%s)", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash host, which browsers read as //host", "/\\evil.example"],
    ["an encoded backslash", "/%5Cevil.example"],
    ["an encoded backslash in lower case", "/%5cevil.example"],
    ["a slash then backslash", "/\\/evil.example"],
    ["a tab, which browsers strip to //host", "/\t/evil.example"],
    ["a newline", "/ok\nSet-Cookie: x=1"],
    ["a carriage return", "/ok\r"],
    ["an absolute URL", "https://evil.example"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a bare word", "evil"],
    ["an empty string", ""],
    ["the sign-in page itself", "/signin"],
    ["a sign-in URL with a query", "/signin?mode=signup"],
  ])("falls back to the home page for %s", (_label, value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("falls back for a missing value", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });

  it("takes the first of a repeated parameter", () => {
    expect(safeNextPath(["/standings", "//evil.example"])).toBe("/standings");
    expect(safeNextPath(["//evil.example", "/standings"])).toBe("/");
  });
});

describe("SIGNUP_REASON_COPY", () => {
  it("says what the account is for, in the visitor's terms", () => {
    expect(SIGNUP_REASON_COPY.reminders).toBe("Create a free account to get an email before every race.");
    expect(SIGNUP_REASON_COPY.spoilers).toBe("Create a free account to keep spoiler-free mode on all your devices.");
  });
});
