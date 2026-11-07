import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Google One Tap needs four CSP directives. Missing any of them fails
 * silently: the prompt never appears and nothing logs outside the console's
 * CSP report, which looks exactly like Google's own dismissal cooldown.
 */
async function csp(): Promise<Map<string, string>> {
  const groups = await nextConfig.headers!();
  const value = groups
    .flatMap((group) => group.headers)
    .find((entry) => entry.key === "Content-Security-Policy")!.value;
  return new Map(
    value.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name, rest.join(" ")] as const;
    }),
  );
}

describe("Content-Security-Policy: Google Identity Services", () => {
  it("allows the GIS client script, frame, calls and stylesheet", async () => {
    const policy = await csp();
    expect(policy.get("script-src")).toContain("https://accounts.google.com/gsi/client");
    expect(policy.get("frame-src")).toContain("https://accounts.google.com/gsi/");
    expect(policy.get("connect-src")).toContain("https://accounts.google.com/gsi/");
    expect(policy.get("style-src")).toContain("https://accounts.google.com/gsi/style");
  });

  it("scopes Google to /gsi/ rather than the whole accounts origin", async () => {
    const policy = await csp();
    for (const directive of ["script-src", "frame-src", "connect-src", "style-src"]) {
      expect(policy.get(directive)).not.toMatch(/https:\/\/accounts\.google\.com(\s|$)/);
    }
  });
});
