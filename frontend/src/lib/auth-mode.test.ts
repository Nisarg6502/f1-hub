import { describe, expect, it } from "vitest";
import {
  authModeHref,
  isOriginRejection,
  nextTabIndex,
  originRejectionMessage,
  parseAuthMode,
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
