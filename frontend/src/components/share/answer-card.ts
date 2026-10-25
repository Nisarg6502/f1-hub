"use client";

import type { AgentVisual } from "@/lib/agent-api";
import type { ShareFormat } from "@/lib/share";
import { answerChartPanel, containBox, planAnswerCard, type Box } from "@/lib/share-answer";
import { CONTINUED_ON_APEX, ellipsize } from "@/lib/share-text";
import { snapshotVisual, type VisualSnapshot } from "./visual-snapshot";

/**
 * Paint a Pitwall answer card onto a canvas and return it as a PNG.
 *
 * The plan (what goes where, how many lines fit) is `planAnswerCard`; this
 * file only draws it. The palette matches the server cards in
 * `app/api/share/_lib/frame.tsx` so the four card types read as one set.
 *
 * Fonts are the page's own `next/font` faces, read through the
 * `--font-headline` / `--font-body` variables the root layout sets and
 * loaded explicitly with `document.fonts.load` before measuring — a canvas
 * does not wait for webfonts, and text measured in the fallback face and
 * drawn in the real one overflows its box.
 */

const C = {
  bg: "#0a0908",
  panel: "rgba(40,32,26,0.55)",
  border: "rgba(255,255,255,0.08)",
  borderFlame: "rgba(255,138,61,0.42)",
  text: "#f6f1ea",
  sub: "#c9c0b4",
  muted: "#a89e90",
  dim: "#8f867a",
  flame: "#FF5A1F",
  flameMid: "#FF7A3D",
  flameLight: "#FFAE6A",
};

function cssFamily(variable: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.body).getPropertyValue(variable).trim();
  return value ? `${value}, ${fallback}` : fallback;
}

/** The chart widths the snapshot frame is asked to draw at, per format. */
export function chartWidthFor(format: ShareFormat): number {
  return Math.round(answerChartPanel(format).inner.w);
}

/**
 * Snapshots are format-dependent (the chart reflows for the width), so they
 * are cached per visual and width. A visual object is stable for the life of
 * its message, which makes it a safe WeakMap key.
 */
const snapshotCache = new WeakMap<AgentVisual, Map<number, Promise<VisualSnapshot | null>>>();

function cachedSnapshot(visual: AgentVisual, width: number): Promise<VisualSnapshot | null> {
  let byWidth = snapshotCache.get(visual);
  if (!byWidth) {
    byWidth = new Map();
    snapshotCache.set(visual, byWidth);
  }
  let p = byWidth.get(width);
  if (!p) {
    p = snapshotVisual(visual, width);
    byWidth.set(width, p);
  }
  return p;
}

function loadImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("chart image failed to decode"));
    // A data: URL rather than a blob: URL — both are allowed by `img-src`,
    // and data: is the form engines treat most consistently as untainted.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Draw `svg` at `w × h` onto a scratch canvas and prove it is still
 * readable. A tainted scratch canvas is thrown away, so the card's own
 * canvas is never tainted and `toBlob` always works.
 */
async function rasterise(svg: string, w: number, h: number, scale: number): Promise<HTMLCanvasElement | null> {
  try {
    const img = await loadImage(svg);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.getImageData(0, 0, 1, 1); // throws SecurityError if tainted
    return canvas;
  } catch {
    return null;
  }
}

/**
 * What happened to the chart: drawn faithfully, drawn as the SVG-only
 * fallback, failed (the card says so), or there was no chart to draw.
 */
export type ChartOutcome = "drawn-html" | "drawn-svg" | "failed" | "none";

function roundRect(ctx: CanvasRenderingContext2D, b: Box, r: number) {
  ctx.beginPath();
  ctx.moveTo(b.x + r, b.y);
  ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, r);
  ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, r);
  ctx.arcTo(b.x, b.y + b.h, b.x, b.y, r);
  ctx.arcTo(b.x, b.y, b.x + b.w, b.y, r);
  ctx.closePath();
}

export async function renderAnswerCard({
  question,
  answerMarkdown,
  visuals,
  format,
}: {
  question: string;
  answerMarkdown: string;
  visuals: readonly AgentVisual[];
  format: ShareFormat;
}): Promise<{ blob: Blob; chart: ChartOutcome }> {
  const head = cssFamily("--font-headline", "system-ui, sans-serif");
  const body = cssFamily("--font-body", "system-ui, sans-serif");
  await Promise.all(
    [`800 40px ${head}`, `700 40px ${head}`, `500 20px ${body}`, `700 20px ${body}`, `800 20px ${body}`].map((f) =>
      document.fonts.load(f).catch(() => [])
    )
  );

  // First visual only: a card has room for one chart, and it says so below
  // when there were more.
  const visual = visuals[0] ?? null;
  const snapshot = visual ? await cachedSnapshot(visual, chartWidthFor(format)) : null;

  const canvas = document.createElement("canvas");
  const ctxMaybe = canvas.getContext("2d");
  if (!ctxMaybe) throw new Error("Canvas is unavailable in this browser.");
  const ctx: CanvasRenderingContext2D = ctxMaybe;

  const measureWith = (font: string) => (text: string) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };

  // Metrics are needed before the plan exists to build the rulers; take them
  // from a throwaway plan, which costs nothing.
  const probe = planAnswerCard({
    format,
    question: "",
    answerMarkdown: "",
    hasChart: false,
    measureQuestion: () => 0,
    measureAnswer: () => 0,
  }).metrics;
  const qFont = `700 ${probe.questionSize}px ${head}`;
  const aFont = `500 ${probe.answerSize}px ${body}`;

  const plan = planAnswerCard({
    format,
    question,
    answerMarkdown,
    hasChart: Boolean(visual),
    measureQuestion: measureWith(qFont),
    measureAnswer: measureWith(aFont),
  });
  const m = plan.metrics;
  canvas.width = plan.width;
  canvas.height = plan.height;

  // Ground and glow — the same radial flame the server cards use.
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, plan.width, plan.height);
  const glow = ctx.createRadialGradient(plan.width * 0.92, -plan.height * 0.08, 0, plan.width * 0.92, -plan.height * 0.08, plan.width * 0.62);
  glow.addColorStop(0, "rgba(255,90,31,0.30)");
  glow.addColorStop(0.5, "rgba(226,58,14,0.10)");
  glow.addColorStop(1, "rgba(10,9,8,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, plan.width, plan.height);

  ctx.textBaseline = "alphabetic";

  // Header: brand mark left, eyebrow pill right.
  const brandSize = m.labelSize + 11;
  const headerMid = m.padTop + brandSize * 0.55;
  const dot = ctx.createLinearGradient(m.padX, headerMid - 9, m.padX + 18, headerMid + 9);
  dot.addColorStop(0, C.flameLight);
  dot.addColorStop(1, C.flame);
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(m.padX + 9, headerMid, (m.labelSize + 5) / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.text;
  ctx.font = `800 ${brandSize}px ${head}`;
  ctx.fillText("APEX", m.padX + m.labelSize + 16, headerMid + brandSize * 0.36);

  const eyebrow = "PITWALL · AI ANSWER";
  ctx.font = `800 ${m.labelSize + 1}px ${body}`;
  const pillW = ctx.measureText(eyebrow).width + eyebrow.length * 2 + 30;
  const pill = { x: plan.width - m.padX - pillW, y: headerMid - (m.labelSize + 16) / 2, w: pillW, h: m.labelSize + 16 };
  roundRect(ctx, pill, pill.h / 2);
  ctx.fillStyle = "rgba(255,90,31,0.08)";
  ctx.fill();
  ctx.strokeStyle = C.borderFlame;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.flameMid;
  drawSpaced(ctx, eyebrow, pill.x + 15, pill.y + pill.h / 2 + (m.labelSize + 1) * 0.36, 2);

  // Question.
  ctx.font = `800 ${m.labelSize}px ${body}`;
  ctx.fillStyle = C.flameMid;
  drawSpaced(ctx, "QUESTION", plan.textX, m.contentTop + m.labelSize, 2.2);
  ctx.font = qFont;
  ctx.fillStyle = C.text;
  plan.question.lines.forEach((line, i) => {
    ctx.fillText(line, plan.textX, plan.questionY + (i + 1) * m.questionLine - m.questionLine * 0.24);
  });

  // Answer.
  const answerLabelY = plan.answerY - 10;
  ctx.font = `800 ${m.labelSize}px ${body}`;
  ctx.fillStyle = C.flameMid;
  drawSpaced(ctx, "ANSWER", plan.textX, answerLabelY, 2.2);
  ctx.font = aFont;
  ctx.fillStyle = C.sub;
  plan.answer.lines.forEach((line, i) => {
    ctx.fillText(line, plan.textX, plan.answerY + (i + 1) * m.answerLine - m.answerLine * 0.3);
  });
  if (plan.continuedY !== null) {
    ctx.font = `700 ${m.answerSize}px ${body}`;
    ctx.fillStyle = C.flameLight;
    ctx.fillText(CONTINUED_ON_APEX, plan.textX, plan.continuedY + m.answerLine - m.answerLine * 0.3);
  }

  // Chart.
  let chartOutcome: ChartOutcome = "none";
  if (plan.chart && visual) {
    const { panel, inner, titleY } = plan.chart;
    roundRect(ctx, panel, format === "landscape" ? 20 : 24);
    ctx.fillStyle = C.panel;
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.stroke();

    const titleSize = format === "landscape" ? 15 : 21;
    ctx.font = `700 ${titleSize}px ${body}`;
    ctx.fillStyle = C.text;
    const count = visuals.length > 1 ? `  ·  1 of ${visuals.length} charts` : "";
    const room = inner.w - ctx.measureText(count).width;
    const rawTitle = visual.title || "Chart";
    const fullTitle =
      ctx.measureText(rawTitle).width <= room ? rawTitle : ellipsize(rawTitle, room, (t) => ctx.measureText(t).width);
    ctx.fillText(fullTitle, inner.x, titleY + titleSize);
    if (count) {
      ctx.fillStyle = C.dim;
      ctx.fillText(count, inner.x + ctx.measureText(fullTitle).width, titleY + titleSize);
    }

    const drawn = await drawChart(ctx, snapshot, inner);
    chartOutcome = drawn;
    if (drawn === "failed") {
      // Honest about it, rather than an empty panel that looks like a bug.
      ctx.font = `500 ${titleSize + 1}px ${body}`;
      ctx.fillStyle = C.muted;
      ctx.textAlign = "center";
      ctx.fillText("This chart couldn't be included —", inner.x + inner.w / 2, inner.y + inner.h / 2 - titleSize * 0.4);
      ctx.fillText("see it with the answer on APEX.", inner.x + inner.w / 2, inner.y + inner.h / 2 + titleSize * 1.1);
      ctx.textAlign = "left";
    }
  }

  // Footer.
  ctx.font = `500 ${m.footerSize}px ${body}`;
  ctx.fillStyle = C.dim;
  ctx.fillText(typeof location !== "undefined" ? location.host : "APEX", m.padX, plan.footerY);
  const disclaimer = "AI-generated · check the sources on APEX";
  ctx.textAlign = "right";
  ctx.fillText(disclaimer, plan.width - m.padX, plan.footerY);
  ctx.textAlign = "left";

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))), "image/png");
  });
  return { blob, chart: chartOutcome };
}

async function drawChart(ctx: CanvasRenderingContext2D, snapshot: VisualSnapshot | null, inner: Box): Promise<ChartOutcome> {
  if (!snapshot) return "failed";
  // 2× the drawn size: the card itself is 1×, but a chart rasterised at 1×
  // and then scaled down by `containBox` loses its hairlines.
  const attempts: Array<{ svg: string | null; w: number; h: number; outcome: ChartOutcome }> = [
    { svg: snapshot.html, w: snapshot.width, h: snapshot.height, outcome: "drawn-html" },
    { svg: snapshot.svg, w: snapshot.svgWidth, h: snapshot.svgHeight, outcome: "drawn-svg" },
  ];
  for (const attempt of attempts) {
    if (!attempt.svg || !attempt.w || !attempt.h) continue;
    const box = containBox(attempt.w, attempt.h, inner);
    const raster = await rasterise(attempt.svg, box.w, box.h, 2);
    if (!raster) continue;
    ctx.drawImage(raster, box.x, box.y, box.w, box.h);
    return attempt.outcome;
  }
  return "failed";
}

/** `fillText` with tracking, which canvas only gained recently (`letterSpacing`). */
function drawSpaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  let cursor = x;
  for (const ch of Array.from(text)) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
}
