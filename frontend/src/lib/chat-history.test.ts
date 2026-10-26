import { describe, expect, it } from "vitest";
import { groupConversations, type ConversationSummary } from "./chat-history";

/** A local-time instant, so the tests mean the same thing in any timezone. */
function local(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function row(id: string, ms: number | null): ConversationSummary {
  return {
    id,
    title: id,
    created_at: null,
    updated_at: ms === null ? null : new Date(ms).toISOString(),
    message_count: 2,
  };
}

const NOW = local(2026, 10, 26, 9, 30);

describe("groupConversations", () => {
  it("buckets by calendar day, not by rolling 24 hours", () => {
    const groups = groupConversations(
      [
        row("this-morning", local(2026, 10, 26, 0, 5)),
        row("last-night", local(2026, 10, 25, 23, 0)),
        row("yesterday-early", local(2026, 10, 25, 0, 0)),
      ],
      NOW
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["this-morning"]],
      ["Yesterday", ["last-night", "yesterday-early"]],
    ]);
  });

  it("puts the six days before yesterday in Previous 7 days and the rest in Older", () => {
    const groups = groupConversations(
      [
        row("two-days", local(2026, 10, 24)),
        row("week-edge", local(2026, 10, 19, 0, 0)),
        row("eight-days", local(2026, 10, 18, 23, 59)),
        row("last-year", local(2025, 3, 1)),
      ],
      NOW
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Previous 7 days", ["two-days", "week-edge"]],
      ["Older", ["eight-days", "last-year"]],
    ]);
  });

  it("keeps the API's order within a group and drops empty groups", () => {
    const groups = groupConversations(
      [row("b", local(2026, 10, 26, 9)), row("a", local(2026, 10, 26, 8))],
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("files a row with no timestamp under Older instead of losing it", () => {
    expect(groupConversations([row("mystery", null)], NOW)[0].label).toBe("Older");
  });

  it("returns nothing for no conversations", () => {
    expect(groupConversations([], NOW)).toEqual([]);
  });
});
