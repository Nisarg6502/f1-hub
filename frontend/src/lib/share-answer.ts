/**
 * Layout for the Pitwall answer card, as numbers.
 *
 * The answer card is the one share card drawn in the browser (on a canvas)
 * rather than by `next/og`: an answer has no URL to render from — there is
 * no chat history yet — and its chart lives inside a sandboxed frame only the
 * browser can run. See `components/share/visual-snapshot.ts`.
 *
 * Everything that decides *where things go and how much text fits* is here,
 * pure, and measured through injected rulers, so it is tested in node with a
 * fake ruler; `components/share/answer-card.ts` only paints the plan.
 */

import { SHARE_FORMATS, type ShareFormat } from "./share";
import { fitText, stripMarkdownForCard, type FittedText, type MeasureText } from "./share-text";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnswerCardMetrics {
  padX: number;
  padTop: number;
  padBottom: number;
  /** Where the question starts, below the header. */
  contentTop: number;
  questionSize: number;
  questionLine: number;
  answerSize: number;
  answerLine: number;
  labelSize: number;
  footerSize: number;
  /** Gap between the question and the answer, and between text and chart. */
  gap: number;
}

export function answerCardMetrics(format: ShareFormat): AnswerCardMetrics {
  return format === "landscape"
    ? { padX: 56, padTop: 40, padBottom: 30, contentTop: 104, questionSize: 30, questionLine: 36, answerSize: 19, answerLine: 28, labelSize: 13, footerSize: 15, gap: 18 }
    : { padX: 64, padTop: 60, padBottom: 44, contentTop: 150, questionSize: 44, questionLine: 52, answerSize: 27, answerLine: 40, labelSize: 18, footerSize: 19, gap: 26 };
}

/**
 * The chart panel: where it sits, and the inner box the chart image is fitted
 * into (below the panel's title line).
 *
 * Exported separately because the snapshot frame has to be told the chart's
 * width *before* the card is laid out — the model's code reflows for
 * whatever width it is given, so the chart is drawn for this box rather than
 * scaled into it after the fact.
 */
export function answerChartPanel(format: ShareFormat): { panel: Box; inner: Box; titleY: number } {
  const { width, height } = SHARE_FORMATS[format];
  const m = answerCardMetrics(format);
  const footerTop = height - m.padBottom - m.footerSize - 18;
  const pad = format === "landscape" ? 18 : 24;
  const titleH = format === "landscape" ? 26 : 34;
  const panel =
    format === "landscape"
      ? { x: 588, y: m.contentTop - 4, w: width - 588 - m.padX, h: footerTop - (m.contentTop - 4) }
      : { x: m.padX, y: footerTop - 560, w: width - m.padX * 2, h: 560 };
  return {
    panel,
    titleY: panel.y + pad,
    inner: { x: panel.x + pad, y: panel.y + pad + titleH, w: panel.w - pad * 2, h: panel.h - pad * 2 - titleH },
  };
}

export interface AnswerCardPlan {
  format: ShareFormat;
  width: number;
  height: number;
  metrics: AnswerCardMetrics;
  question: FittedText;
  questionY: number;
  answer: FittedText;
  answerY: number;
  textX: number;
  textW: number;
  /** Set when the answer was cut; the card prints `CONTINUED_ON_APEX` here. */
  continuedY: number | null;
  chart: ReturnType<typeof answerChartPanel> | null;
  footerY: number;
}

/**
 * Lay out one answer card.
 *
 * `answerMarkdown` is the answer as the panel holds it (markers already
 * stripped by `answer-anchors.ts` where the caller has that); it is reduced
 * to card prose here with `stripMarkdownForCard`, which also removes any
 * citation marker that survived.
 *
 * The question gets at most three lines and the answer whatever height is
 * left. When the answer is cut, one answer line is given up for the honest
 * "…continued on APEX" — the card never ends mid-sentence without saying so.
 */
export function planAnswerCard({
  format,
  question,
  answerMarkdown,
  hasChart,
  measureQuestion,
  measureAnswer,
}: {
  format: ShareFormat;
  question: string;
  answerMarkdown: string;
  hasChart: boolean;
  measureQuestion: MeasureText;
  measureAnswer: MeasureText;
}): AnswerCardPlan {
  const { width, height } = SHARE_FORMATS[format];
  const m = answerCardMetrics(format);
  const chart = hasChart ? answerChartPanel(format) : null;
  const footerY = height - m.padBottom;

  const textX = m.padX;
  const textW = chart && format === "landscape" ? chart.panel.x - m.padX - 32 : width - m.padX * 2;

  const labelH = m.labelSize + 10;
  const questionY = m.contentTop + labelH;
  const fittedQuestion = fitText(question.replace(/\s+/g, " ").trim(), {
    maxWidth: textW,
    maxLines: 3,
    measure: measureQuestion,
  });

  const answerY = questionY + fittedQuestion.lines.length * m.questionLine + m.gap + labelH;
  const answerBottom =
    chart && format === "portrait" ? chart.panel.y - m.gap : footerY - m.footerSize - 18 - m.gap;
  const available = Math.max(0, Math.floor((answerBottom - answerY) / m.answerLine));

  const prose = stripMarkdownForCard(answerMarkdown);
  let answer = fitText(prose, { maxWidth: textW, maxLines: Math.max(1, available), measure: measureAnswer });
  if (answer.truncated && available > 1) {
    // Give one line back for the "continued" footer.
    answer = fitText(prose, { maxWidth: textW, maxLines: available - 1, measure: measureAnswer });
  }
  const continuedY = answer.truncated ? answerY + answer.lines.length * m.answerLine : null;

  return {
    format,
    width,
    height,
    metrics: m,
    question: fittedQuestion,
    questionY,
    answer,
    answerY,
    textX,
    textW,
    continuedY,
    chart,
    footerY,
  };
}

/**
 * Fit a `w × h` image inside `box`, preserving aspect ratio, top-centred.
 *
 * Top rather than middle: a chart's title and legend live at its top, and a
 * short chart floating in the middle of a tall panel reads as a layout bug.
 */
export function containBox(w: number, h: number, box: Box): Box {
  if (w <= 0 || h <= 0) return { x: box.x, y: box.y, w: 0, h: 0 };
  const scale = Math.min(box.w / w, box.h / h);
  const dw = Math.round(w * scale * 10) / 10;
  const dh = Math.round(h * scale * 10) / 10;
  return { x: Math.round((box.x + (box.w - dw) / 2) * 10) / 10, y: box.y, w: dw, h: dh };
}
