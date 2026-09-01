import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Regression guard for the team-radio `media-src` directive.
 *
 * This is not a test of a `lib/` function, and it is here anyway, because the
 * bug it covers had no runtime code to test. Team radio shipped completely
 * silent: the CSP carried no `media-src`, `<audio>` fell through to
 * `default-src 'self'`, and every clip on F1's CDN was refused by the browser
 * before a single byte was requested. Both players were dead — the Pitwall feed
 * and the watch-mode popup — and both looked healthy from the outside.
 *
 * The reason this is worth a test rather than a comment is how badly the
 * failure hides. There is no exception, no log line, and no failed request in
 * the network panel; `.play()` rejects with `NotSupportedError`, which reads as
 * a broken URL, and `curl` on the same URL answers 200 `audio/mpeg`. Nothing
 * points at the CSP except a `securitypolicyviolation` event nobody is
 * listening for. A silent directive that a later tidy-up could delete with no
 * visible consequence is exactly the thing to pin down here.
 *
 * The host is asserted literally on purpose. `next.config.ts` derives
 * `connect-src` from `NEXT_PUBLIC_*` values, but clip URLs are built
 * server-side in `backend/app/radio_clips.py` (`LIVETIMING_BASE`) and reach the
 * client inside the API payload, so no environment variable knows about this
 * origin. Changing that constant has to change this line too, and this test is
 * what says so out loud.
 */
async function cspFor(path: string): Promise<string> {
  const groups = await nextConfig.headers!();
  const header = groups
    .flatMap((group) => group.headers)
    .find((entry) => entry.key === "Content-Security-Policy");
  expect(header, `no CSP header covering ${path}`).toBeDefined();
  return header!.value;
}

describe("Content-Security-Policy: media-src", () => {
  it("allows team-radio audio from F1's live timing CDN", async () => {
    const csp = await cspFor("/schedule/2026/12/pitwall");
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("media-src"));

    expect(directive, "media-src is missing — team radio plays nothing").toBeDefined();
    expect(directive).toContain("https://livetiming.formula1.com");
  });

  it("still restricts default-src, so media-src is doing real work", async () => {
    // The trap that produced the bug: `default-src 'self'` looks like it covers
    // everything, and for media it does — it covers it by *denying* it. If a
    // future change widened `default-src`, the test above would keep passing
    // while meaning nothing, so pin the narrow default too.
    const csp = await cspFor("/schedule/2026/12/pitwall");
    expect(csp).toContain("default-src 'self'");
  });
});
