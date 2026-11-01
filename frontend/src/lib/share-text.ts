/**
 * Text handling for share cards: turning an answer's markdown into prose a
 * card can print, and fitting prose into a fixed box.
 *
 * Pure, and measured through an injected function rather than a canvas, so
 * the wrapping rules are tested in node with a fake ruler and run in the
 * browser with `CanvasRenderingContext2D.measureText`. The same split
 * `analytics.ts` makes with its storage argument.
 */

import { CITATION_MARKER_SOURCE } from "./agent-api";

/** Width of `text` in the units the caller lays out in (CSS px on a canvas). */
export type MeasureText = (text: string) => number;

/** The truncation mark, and the honest footer an answer card carries when it fires. */
export const ELLIPSIS = "…";
export const CONTINUED_ON_APEX = `${ELLIPSIS}continued on APEX`;

/**
 * Markdown to card prose.
 *
 * An answer arrives as GitHub-flavoured markdown with `[ev_N]` citation
 * markers. On a card none of that syntax means anything — there is no link to
 * follow and no popover to open — and printed raw it reads as noise:
 * `**Russell** won [ev_1]`. So:
 *
 *   - citation markers go, with the whitespace before them (the
 *     `answer-anchors.ts` rule: `"won [ev_1]."` becomes `"won."`);
 *   - emphasis, inline code, headings and quotes keep their words and lose
 *     their punctuation;
 *   - links keep their text, images disappear (the model is told never to
 *     emit them; the panel suppresses them too);
 *   - list items become `•` lines, so a list still reads as a list;
 *   - table rows become `a · b · c` lines and the `|---|` rule goes, so a
 *     table degrades into readable rows rather than a wall of pipes;
 *   - fenced code keeps its content and loses its fences.
 *
 * Paragraph breaks survive as a blank line; every other run of blank lines
 * collapses to one.
 *
 * Underscore emphasis is only stripped at word boundaries. `ev_1`,
 * `max_verstappen` and `DRS_zone` are words, and an intraword `_` rule turns
 * them into `ev1`.
 */
export function stripMarkdownForCard(markdown: string): string {
  if (!markdown) return "";
  const marker = new RegExp(`[ \\t]*${CITATION_MARKER_SOURCE}`, "g");

  const out: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    let line = rawLine;

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line.replace(marker, "").trimEnd());
      continue;
    }

    // Horizontal rules, and the alignment row under a table header.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;

    line = line.replace(marker, "");

    // Table rows: cells joined, outer pipes dropped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" · ");
    }

    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, "$1• ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
      .replace(/[ \t]+$/g, "");

    out.push(line);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Greedy word wrap into lines no wider than `maxWidth`.
 *
 * `\n` is a hard break and a blank line is kept as `""` so a paragraph gap
 * survives into the layout. A single word wider than the box (a URL, a
 * sixty-character hashtag) is broken by character rather than allowed to run
 * off the card — the one place overflow would be worse than a mid-word break.
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (measure(word) <= maxWidth) {
        current = word;
        continue;
      }
      // Break an over-long word into the widest pieces that fit.
      let piece = "";
      for (const ch of Array.from(word)) {
        if (piece && measure(piece + ch) > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      current = piece;
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * Shorten `line` until `line + suffix` fits, cutting at a word boundary where
 * one exists in the last third and at a character otherwise.
 *
 * Trailing punctuation and spaces are trimmed before the suffix goes on, so
 * the result is `"won the race…"`, not `"won the race, …"`.
 */
export function ellipsize(line: string, maxWidth: number, measure: MeasureText, suffix = ELLIPSIS): string {
  if (measure(line + suffix) <= maxWidth) return trimForSuffix(line) + suffix;
  const chars = Array.from(line);
  let end = chars.length;
  while (end > 0 && measure(chars.slice(0, end).join("") + suffix) > maxWidth) end -= 1;
  let cut = chars.slice(0, end).join("");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > cut.length * 0.66) cut = cut.slice(0, lastSpace);
  return trimForSuffix(cut) + suffix;
}

function trimForSuffix(text: string): string {
  return text.replace(/[\s,;:.\-–—]+$/u, "");
}

export interface FittedText {
  lines: string[];
  /** Whether anything was cut. The card prints `CONTINUED_ON_APEX` when it was. */
  truncated: boolean;
}

/**
 * Wrap, then cap at `maxLines`.
 *
 * When text is cut, the last kept line ends in an ellipsis, and a cut that
 * lands on a paragraph gap drops the dangling blank line rather than ending
 * the box on nothing. Blank lines at the very end are removed either way.
 */
export function fitText(
  text: string,
  { maxWidth, maxLines, measure }: { maxWidth: number; maxLines: number; measure: MeasureText }
): FittedText {
  const all = wrapText(text, maxWidth, measure);
  while (all.length && all[all.length - 1] === "") all.pop();
  if (all.length <= maxLines) return { lines: all, truncated: false };

  const kept = all.slice(0, Math.max(1, maxLines));
  while (kept.length > 1 && kept[kept.length - 1] === "") kept.pop();
  kept[kept.length - 1] = ellipsize(kept[kept.length - 1], maxWidth, measure);
  return { lines: kept, truncated: true };
}

/**
 * Up to two initials, from the first and last words: `"Andrea Kimi
 * Antonelli"` → `"AA"`, `"Nico Hülkenberg"` → `"NH"`, `"Ferrari"` → `"F"`.
 *
 * Stands in for a portrait the asset set does not have (2018's grid, a
 * mid-season debutant). Uppercased with the locale-independent rule so `"ı"`
 * cannot become something unexpected on a Turkish-locale server.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * A font size at which `text` should fit `maxWidth`, for the server cards.
 *
 * Satori exposes no measuring API, so this estimates with an average glyph
 * width in ems — 0.56 is measured from Bricolage Grotesque ExtraBold over
 * driver and team names, and errs wide. The card still sets
 * `text-overflow: ellipsis` underneath it, so an estimate that is wrong costs
 * an ellipsis, never an overflow. Shrinks no further than `minSize`: a name
 * at 18px on a 1200px card is unreadable in a chat thumbnail, and an
 * ellipsis there is the more honest failure.
 */
export function fitFontSize(
  text: string,
  { maxWidth, maxSize, minSize, emPerChar = 0.56 }: { maxWidth: number; maxSize: number; minSize: number; emPerChar?: number }
): number {
  const length = Array.from(text).length;
  if (length === 0) return maxSize;
  const ideal = Math.floor(maxWidth / (length * emPerChar));
  return Math.max(minSize, Math.min(maxSize, ideal));
}
