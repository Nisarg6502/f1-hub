import { describe, expect, it } from "vitest";
import { answerChartPanel, containBox, planAnswerCard } from "./share-answer";
import { SHARE_FORMATS } from "./share";

/** Proportional-ish fake ruler: 0.5em per character. */
const ruler = (size: number) => (text: string) => Array.from(text).length * size * 0.5;

function plan(over: Partial<Parameters<typeof planAnswerCard>[0]> = {}) {
  const format = over.format ?? "landscape";
  const sizes = format === "landscape" ? [30, 19] : [44, 27];
  return planAnswerCard({
    format,
    question: "Who won the 2026 Canadian Grand Prix?",
    answerMarkdown: "**George Russell** won [ev_1], ahead of Antonelli [ev_2].",
    hasChart: false,
    measureQuestion: ruler(sizes[0]),
    measureAnswer: ruler(sizes[1]),
    ...over,
  });
}

const LONG = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} explains the stint in detail [ev_${i}].`).join("\n\n");

describe("planAnswerCard", () => {
  it("strips markdown and citation markers from the answer", () => {
    expect(plan().answer.lines.join(" ")).toBe("George Russell won, ahead of Antonelli.");
  });

  it("fits a short answer with no truncation and no continuation line", () => {
    const p = plan();
    expect(p.answer.truncated).toBe(false);
    expect(p.continuedY).toBeNull();
  });

  it.each(["landscape", "portrait"] as const)("truncates a very long answer honestly (%s)", (format) => {
    const p = plan({ format, answerMarkdown: LONG });
    expect(p.answer.truncated).toBe(true);
    expect(p.answer.lines[p.answer.lines.length - 1].endsWith("…")).toBe(true);
    expect(p.continuedY).not.toBeNull();
    // The continuation line still sits above the footer.
    expect(p.continuedY! + p.metrics.answerLine).toBeLessThanOrEqual(p.footerY - p.metrics.footerSize);
  });

  it.each(["landscape", "portrait"] as const)("keeps every text line inside its column (%s)", (format) => {
    const p = plan({ format, answerMarkdown: LONG, hasChart: true });
    const measure = ruler(p.metrics.answerSize);
    for (const line of p.answer.lines) expect(measure(line)).toBeLessThanOrEqual(p.textW + 0.001);
    expect(p.textX + p.textW).toBeLessThanOrEqual(SHARE_FORMATS[format].width - p.metrics.padX);
  });

  it("puts the chart beside the text in landscape and below it in portrait", () => {
    const land = plan({ hasChart: true, answerMarkdown: LONG });
    expect(land.chart!.panel.x).toBeGreaterThan(land.textX + land.textW);
    const port = plan({ format: "portrait", hasChart: true, answerMarkdown: LONG });
    const lastLineBottom = port.answerY + (port.answer.lines.length + 1) * port.metrics.answerLine;
    expect(lastLineBottom).toBeLessThanOrEqual(port.chart!.panel.y);
  });

  it("gives the text the full width when there is no chart", () => {
    const p = plan({ hasChart: false });
    expect(p.chart).toBeNull();
    expect(p.textW).toBe(1200 - 56 * 2);
  });

  it("caps the question at three lines", () => {
    const p = plan({ question: "Why ".repeat(200) });
    expect(p.question.lines.length).toBe(3);
    expect(p.question.truncated).toBe(true);
  });

  it("collapses whitespace in the question", () => {
    expect(plan({ question: "  Who \n won   it? " }).question.lines).toEqual(["Who won it?"]);
  });

  it("is total on an empty answer", () => {
    const p = plan({ answerMarkdown: "" });
    expect(p.answer.lines).toEqual([]);
    expect(p.continuedY).toBeNull();
  });
});

describe("answerChartPanel", () => {
  it.each(["landscape", "portrait"] as const)("stays inside the card (%s)", (format) => {
    const { panel, inner } = answerChartPanel(format);
    const { width, height } = SHARE_FORMATS[format];
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.w).toBeLessThanOrEqual(width);
    expect(panel.y + panel.h).toBeLessThan(height);
    expect(inner.w).toBeGreaterThan(300);
    expect(inner.h).toBeGreaterThan(200);
  });
});

describe("containBox", () => {
  const box = { x: 10, y: 20, w: 400, h: 200 };

  it("fits a wide image to the width", () => {
    expect(containBox(800, 200, box)).toEqual({ x: 10, y: 20, w: 400, h: 100 });
  });

  it("fits a tall image to the height, centred horizontally, top-aligned", () => {
    expect(containBox(100, 400, box)).toEqual({ x: 185, y: 20, w: 50, h: 200 });
  });

  it("is total on a zero-size image", () => {
    expect(containBox(0, 100, box)).toEqual({ x: 10, y: 20, w: 0, h: 0 });
  });
});
