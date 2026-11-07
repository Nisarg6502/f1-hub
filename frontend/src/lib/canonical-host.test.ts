import { describe, expect, it } from "vitest";
import { canonicalRedirectUrl, isExemptPath } from "./canonical-host";

const CANONICAL = "https://f1-frontend-1076575666662.asia-south1.run.app";
const OTHER = "f1-frontend-2w5wydk2ca-el.a.run.app";

describe("canonicalRedirectUrl", () => {
  it("sends the other Cloud Run hostname to the canonical one, keeping path and query", () => {
    expect(canonicalRedirectUrl(OTHER, "/signin?mode=signup&next=%2Fteams", CANONICAL)).toBe(
      `${CANONICAL}/signin?mode=signup&next=%2Fteams`,
    );
  });

  it("works in either direction, driven only by the configured URL", () => {
    expect(
      canonicalRedirectUrl(
        "f1-frontend-1076575666662.asia-south1.run.app",
        "/",
        `https://${OTHER}`,
      ),
    ).toBe(`https://${OTHER}/`);
  });

  it("leaves the canonical host alone, case and port aside", () => {
    expect(canonicalRedirectUrl(new URL(CANONICAL).host, "/signin", CANONICAL)).toBeNull();
    expect(
      canonicalRedirectUrl(new URL(CANONICAL).host.toUpperCase() + ":443", "/", CANONICAL),
    ).toBeNull();
  });

  it("never redirects local or non-Cloud-Run hosts", () => {
    expect(canonicalRedirectUrl("localhost:3105", "/signin", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl("127.0.0.1:3000", "/", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl("apex.example.com", "/", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl("run.app.example.com", "/", CANONICAL)).toBeNull();
  });

  it("does nothing without a usable BETTER_AUTH_URL", () => {
    expect(canonicalRedirectUrl(OTHER, "/", undefined)).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/", "")).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/", "not a url")).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/", "javascript:alert(1)")).toBeNull();
    expect(canonicalRedirectUrl(null, "/", CANONICAL)).toBeNull();
  });

  it("exempts machine endpoints under /api", () => {
    expect(canonicalRedirectUrl(OTHER, "/api/reminders/dispatch", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/api/calendar/feed.ics?t=x", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/api/auth/sign-in/social", CANONICAL)).toBeNull();
    expect(canonicalRedirectUrl(OTHER, "/apiary", CANONICAL)).toBe(`${CANONICAL}/apiary`);
  });

  it("cannot be steered to another host by a protocol-relative path", () => {
    expect(canonicalRedirectUrl(OTHER, "//evil.example/x", CANONICAL)).toBe(`${CANONICAL}/evil.example/x`);
  });

  it("ignores a path on BETTER_AUTH_URL and uses only its origin", () => {
    expect(canonicalRedirectUrl(OTHER, "/teams", `${CANONICAL}/`)).toBe(`${CANONICAL}/teams`);
  });
});

describe("isExemptPath", () => {
  it("matches /api and below only", () => {
    expect(isExemptPath("/api")).toBe(true);
    expect(isExemptPath("/api/me")).toBe(true);
    expect(isExemptPath("/apiary")).toBe(false);
    expect(isExemptPath("/signin")).toBe(false);
  });
});
