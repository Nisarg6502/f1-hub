import { describe, expect, it } from "vitest";
import robots from "@/app/robots";

type Rule = { allow?: string | string[]; disallow?: string | string[] };

const toList = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value : value ? [value] : [];

/** RFC 9309: the longest matching rule wins, and an allow wins a tie. */
function allowed(path: string, rule: Rule): boolean {
  const matches = [
    ...toList(rule.allow).map((prefix) => ({ prefix, allow: true })),
    ...toList(rule.disallow).map((prefix) => ({ prefix, allow: false })),
  ].filter((m) => path.startsWith(m.prefix));
  if (matches.length === 0) return true;
  matches.sort((a, b) => b.prefix.length - a.prefix.length || (a.allow ? -1 : 1));
  return matches[0].allow;
}

function starRule(): Rule {
  const rules = robots().rules;
  const list = Array.isArray(rules) ? rules : [rules];
  const rule = list.find((r) => r.userAgent === "*");
  if (!rule) throw new Error("no rule for *");
  return rule as Rule;
}

describe("robots.txt", () => {
  it("lets crawlers fetch the link-preview images", () => {
    // Twitterbot and LinkedInBot honour robots.txt for image URLs, and every
    // result, standings and replay card is served from /api/share/.
    const rule = starRule();

    expect(allowed("/api/share/race/2026/20?session=race&format=landscape", rule)).toBe(true);
    expect(allowed("/api/share/standings?season=2026&kind=drivers&format=landscape", rule)).toBe(true);
    expect(allowed("/api/share/watch/2026/20", rule)).toBe(true);
  });

  it("still keeps the rest of the API and the debugging pages out of search", () => {
    const rule = starRule();

    expect(allowed("/api/me/preferences", rule)).toBe(false);
    expect(allowed("/api/agent-token", rule)).toBe(false);
    expect(allowed("/api/calendar/apex-f1.ics", rule)).toBe(false);
    expect(allowed("/agent-check", rule)).toBe(false);
    expect(allowed("/pitwall-chat", rule)).toBe(false);
  });

  it("allows the pages themselves", () => {
    const rule = starRule();

    expect(allowed("/", rule)).toBe(true);
    expect(allowed("/standings", rule)).toBe(true);
    expect(allowed("/watch/2026-20", rule)).toBe(true);
  });
});
