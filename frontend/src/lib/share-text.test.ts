import { describe, expect, it } from "vitest";
import {
  CONTINUED_ON_APEX,
  ellipsize,
  fitFontSize,
  fitText,
  initials,
  stripMarkdownForCard,
  wrapText,
} from "./share-text";

/** A monospace ruler: every character is 10 units wide. */
const mono = (text: string) => Array.from(text).length * 10;

describe("stripMarkdownForCard", () => {
  it("removes citation markers with the space before them", () => {
    expect(stripMarkdownForCard("Russell won [ev_1].")).toBe("Russell won.");
    expect(stripMarkdownForCard("Russell won [ev_1] and set [ev_12] the lap.")).toBe(
      "Russell won and set the lap."
    );
  });

  it("removes the full-width marker variants the verifier understands", () => {
    expect(stripMarkdownForCard("Won 【ev_2】 and ［ev_3］ led.")).toBe("Won and led.");
  });

  it("keeps the words of emphasis and drops the punctuation", () => {
    expect(stripMarkdownForCard("**Russell** won *easily* and ~~barely~~ __clearly__ _quickly_.")).toBe(
      "Russell won easily and barely clearly quickly."
    );
  });

  it("leaves intraword underscores alone", () => {
    expect(stripMarkdownForCard("driver_id is max_verstappen")).toBe("driver_id is max_verstappen");
  });

  it("keeps link text and drops images", () => {
    expect(stripMarkdownForCard("See [the results](https://x.test) ![chart](/x.png)here")).toBe(
      "See the results here"
    );
  });

  it("strips headings and quotes, and turns bullets into •", () => {
    expect(stripMarkdownForCard("## Summary\n> Quoted\n- one\n* two\n+ three\n1. first")).toBe(
      "Summary\nQuoted\n• one\n• two\n• three\n1. first"
    );
  });

  it("turns a table into readable rows and drops the alignment rule", () => {
    const table = "| Driver | Pts |\n|:---|---:|\n| Russell | 25 |\n| Antonelli | 18 |";
    expect(stripMarkdownForCard(table)).toBe("Driver · Pts\nRussell · 25\nAntonelli · 18");
  });

  it("keeps fenced code content without the fences", () => {
    expect(stripMarkdownForCard("Before\n```js\nconst x = 1;\n```\nAfter")).toBe("Before\nconst x = 1;\nAfter");
  });

  it("removes inline code ticks and HTML tags", () => {
    expect(stripMarkdownForCard("Use `apex.bars` <b>now</b><br/>")).toBe("Use apex.bars now");
  });

  it("collapses runs of blank lines to one paragraph break", () => {
    expect(stripMarkdownForCard("One\n\n\n\nTwo\r\n\r\nThree")).toBe("One\n\nTwo\n\nThree");
  });

  it("drops horizontal rules", () => {
    expect(stripMarkdownForCard("Above\n\n---\n\nBelow\n***")).toBe("Above\n\nBelow");
  });

  it("is total on empty input", () => {
    expect(stripMarkdownForCard("")).toBe("");
  });

  it("keeps diacritics", () => {
    expect(stripMarkdownForCard("**Hülkenberg** beat *Pérez*")).toBe("Hülkenberg beat Pérez");
  });
});

describe("wrapText", () => {
  it("wraps greedily at the width", () => {
    expect(wrapText("aaa bbb ccc", 70, mono)).toEqual(["aaa bbb", "ccc"]);
  });

  it("keeps hard breaks and blank lines", () => {
    expect(wrapText("one\n\ntwo", 100, mono)).toEqual(["one", "", "two"]);
  });

  it("breaks a word longer than the box by character", () => {
    expect(wrapText("abcdefghij", 40, mono)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never returns a line wider than the box", () => {
    const lines = wrapText("The quick brown fox jumps over the extraordinarily lazy dog", 120, mono);
    for (const line of lines) expect(mono(line)).toBeLessThanOrEqual(120);
  });
});

describe("ellipsize", () => {
  it("appends the ellipsis when it fits", () => {
    expect(ellipsize("short", 100, mono)).toBe("short…");
  });

  it("cuts to fit, preferring a word boundary near the end", () => {
    const out = ellipsize("the race was won by", 150, mono);
    expect(mono(out)).toBeLessThanOrEqual(150);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("the race was…");
  });

  it("trims trailing punctuation before the ellipsis", () => {
    expect(ellipsize("won the race,", 200, mono)).toBe("won the race…");
  });
});

describe("fitText", () => {
  it("reports no truncation when everything fits", () => {
    expect(fitText("one two", { maxWidth: 100, maxLines: 3, measure: mono })).toEqual({
      lines: ["one two"],
      truncated: false,
    });
  });

  it("caps at maxLines and ends the last line with an ellipsis", () => {
    const fitted = fitText("aaa bbb ccc ddd eee fff", { maxWidth: 70, maxLines: 2, measure: mono });
    expect(fitted.truncated).toBe(true);
    expect(fitted.lines).toHaveLength(2);
    expect(fitted.lines[1].endsWith("…")).toBe(true);
    for (const line of fitted.lines) expect(mono(line)).toBeLessThanOrEqual(70);
  });

  it("does not end a truncated box on a blank paragraph gap", () => {
    const fitted = fitText("aaa\n\nbbb\n\nccc", { maxWidth: 100, maxLines: 2, measure: mono });
    expect(fitted.lines).toEqual(["aaa…"]);
    expect(fitted.truncated).toBe(true);
  });

  it("drops trailing blank lines without calling it a truncation", () => {
    expect(fitText("aaa\n\n", { maxWidth: 100, maxLines: 1, measure: mono })).toEqual({
      lines: ["aaa"],
      truncated: false,
    });
  });

  it("handles a very long answer in bounded output", () => {
    const long = "Lorem ipsum dolor sit amet. ".repeat(400);
    const fitted = fitText(long, { maxWidth: 500, maxLines: 9, measure: mono });
    expect(fitted.lines).toHaveLength(9);
    expect(fitted.truncated).toBe(true);
  });

  it("exposes the honest footer copy", () => {
    expect(CONTINUED_ON_APEX).toBe("…continued on APEX");
  });
});

describe("initials", () => {
  it("uses the first and last words", () => {
    expect(initials("Andrea Kimi Antonelli")).toBe("AA");
    expect(initials("Nico Hülkenberg")).toBe("NH");
    expect(initials("Ferrari")).toBe("F");
    expect(initials("  ")).toBe("");
  });

  it("uppercases accented initials", () => {
    expect(initials("érik ölander")).toBe("ÉÖ");
  });
});

describe("fitFontSize", () => {
  it("returns the max size for short text", () => {
    expect(fitFontSize("Norris", { maxWidth: 400, maxSize: 40, minSize: 20 })).toBe(40);
  });

  it("shrinks long text but never below the minimum", () => {
    const size = fitFontSize("Andrea Kimi Antonelli", { maxWidth: 300, maxSize: 40, minSize: 20 });
    expect(size).toBeLessThan(40);
    expect(size).toBeGreaterThanOrEqual(20);
    expect(fitFontSize("x".repeat(200), { maxWidth: 300, maxSize: 40, minSize: 20 })).toBe(20);
  });

  it("is total on empty text", () => {
    expect(fitFontSize("", { maxWidth: 100, maxSize: 30, minSize: 10 })).toBe(30);
  });
});
