/**
 * CP74 — turning CP72's draft offsets into markdown that still renders.
 *
 * This is the hardest part of "the fact is the citation", and it is isolated
 * here on purpose: it is pure string work with no React in it, so it can be
 * reasoned about (and, later, tested) without mounting a panel.
 *
 * ## The problem
 *
 * An `AgentAnchor` names a half-open span `[start, end)` of the **raw draft** —
 * the answer exactly as it streamed, `[ev_N]` markers and all. The panel does
 * not render the raw draft: it hands markdown to `ReactMarkdown`, which parses
 * emphasis, tables, code and links away. So a draft offset does not address
 * anything in the DOM, and there is no offset map to consult.
 *
 * Two routes were available. Walk the mdast and slice text nodes by offset —
 * correct in principle, but it means owning a remark plugin, and a span that
 * straddles two text nodes (half inside `**bold**`) still has no answer.
 * Or rewrite the draft *before* parsing, so the marks become ordinary markdown
 * links and the parser does the rest. This takes the second route, which is
 * also the one CP71 already established for citation markers.
 *
 * ## The discipline
 *
 * The backend's token matching is heuristic — CP72's own report says it will
 * need tuning against real model output — so the governing rule here is that
 * **a bad anchor costs a mark, never a word of the answer**. Every anchor is
 * checked against the draft it claims to index, and anything that cannot be
 * wrapped without risking the markdown is dropped silently. An answer with
 * zero surviving anchors renders as plain prose, which is exactly what an
 * answer rendered before CP72 existed looked like.
 *
 * The checks, in order, and why each one exists:
 *
 * 1. **The span must still say what the anchor says it says.** `draft.slice`
 *    is compared to `anchor.text`. This alone catches every off-by-N, every
 *    stale anchor against re-generated text, and every unicode surprise.
 * 2. **The token must be markdown-inert.** A token containing `[`, `]`, `(`,
 *    `)`, a backtick, `*`, `_`, `\`, `|`, `<` or a newline could not be
 *    wrapped in `[…](…)` without changing how the surrounding text parses.
 * 3. **The span must not touch a protected region** — a fenced or inline code
 *    span, an existing markdown link or image, an HTML tag, or a `[ev_N]`
 *    marker. Marking inside a code fence would print link syntax as code;
 *    marking inside an existing link would nest links, which is invalid.
 * 4. **Spans must not overlap each other.** The backend already dedupes by
 *    span per evidence entry, but two *different* entries can anchor
 *    overlapping tokens, and nesting the second inside the first would again
 *    produce nested links.
 *
 * Markers are stripped unconditionally, anchors or not: CP74 removes numbered
 * pills entirely, so a literal `[ev_3]` left in the prose would be the exact
 * academic-footnote artefact this direction exists to delete.
 */

import { anchorHref, CITATION_MARKER_SOURCE, type AgentAnchor } from "./agent-api";

/** One `[start, end)` edit against the raw draft. Never overlaps another. */
interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * A citation marker, plus any horizontal whitespace immediately before it.
 *
 * Swallowing the leading space is what keeps `"Russell won [ev_1]."` from
 * becoming `"Russell won ."`. Only spaces and tabs are eaten — a newline
 * before a marker is structural (a list item, a table row) and removing it
 * would join two blocks.
 *
 * Bracket variants come from {@link CITATION_MARKER_SOURCE}, which mirrors the
 * backend's own parser — a full-width `【ev_2】` the verifier now understands
 * must not survive into the prose as raw text here.
 *
 * Built fresh per call rather than kept as a module constant: a `/g` regex
 * carries `lastIndex` between uses, and one shared instance driving both a
 * `.replace` and an `.exec` loop is a stateful-global bug waiting to happen.
 */
const markerRe = () => new RegExp(`[ \\t]*${CITATION_MARKER_SOURCE}`, "g");

/** Letters and digits in any script — Räikkönen and 4.812 both count. */
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * What a stripped marker leaves behind: usually nothing, sometimes a space.
 *
 * Deleting a marker outright is right when it was preceded by whitespace the
 * match already ate (`"won [ev_1]."` → `"won."`). It is wrong when the model
 * wrote no space at all — a real production draft read `"Russell won【ev_2】and
 * set…"`, and deleting that marker produced `"wonand"`. Two words fused into a
 * non-word is a worse artefact than the marker was, and it is invisible to any
 * test that only asserts the marker is gone.
 *
 * So: if a word character sits on both sides of the removed text, the marker
 * was doing a separator's job and one space takes over. Otherwise nothing.
 */
function markerReplacement(source: string, start: number, length: number): string {
  if (/[ \t]/.test(source[start] ?? "")) return "";
  const before = source[start - 1];
  const after = source[start + length];
  return before && after && WORDISH.test(before) && WORDISH.test(after) ? " " : "";
}

/** The draft as the reader sees it: markers gone, every word still separate. */
function stripMarkers(source: string): string {
  return source.replace(markerRe(), (match, _n: string, offset: number) =>
    markerReplacement(source, offset, match.length)
  );
}

/** Characters that would make `[token](href)` reparse as something else. */
const HOSTILE_TOKEN_RE = /[[\]()`*_\\|<>\n\r]/;

/**
 * Regions of the draft no mark may touch: fenced code, inline code, links,
 * images, HTML tags, and the citation markers themselves.
 *
 * One combined pass with alternation rather than four passes, so a `` ` ``
 * inside a fenced block cannot be mistaken for the start of an inline span.
 * Order matters: fenced blocks are tried before inline code for that reason.
 */
const protectedRe = () =>
  new RegExp(
    [
      "```[\\s\\S]*?```",
      "~~~[\\s\\S]*?~~~",
      "`[^`\\n]*`",
      "!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)",
      "<[^>\\n]*>",
      CITATION_MARKER_SOURCE,
    ].join("|"),
    "g"
  );

function protectedRanges(draft: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = protectedRe();
  for (let m = re.exec(draft); m; m = re.exec(draft)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function overlaps(
  start: number,
  end: number,
  ranges: readonly [number, number][]
): boolean {
  return ranges.some(([from, to]) => start < to && from < end);
}

export interface AnchoredMarkdown {
  /**
   * The draft with markers stripped and every surviving anchor rewritten into
   * a `[token](#anchor-…)` link. Safe to hand straight to `ReactMarkdown`.
   */
  markdown: string;
  /**
   * The anchors that actually made it into {@link markdown}, in the order
   * their hrefs index. `AnchorMark` looks itself up here by index, so this
   * list and the hrefs cannot drift.
   */
  resolved: AgentAnchor[];
  /** The draft with markers stripped and nothing marked — plain prose. */
  plainText: string;
}

/**
 * Prepare one message's answer for rendering.
 *
 * Total: it never throws and never drops answer text. In the worst case —
 * every anchor unresolvable — the result is the draft minus its citation
 * markers, which is a complete, readable answer.
 */
export function buildAnchoredMarkdown(
  draft: string,
  anchors: readonly AgentAnchor[] | null | undefined,
  messageId: string
): AnchoredMarkdown {
  const source = draft ?? "";
  const plainText = stripMarkers(source);
  if (!source) return { markdown: "", resolved: [], plainText: "" };

  const edits: Edit[] = [];
  const marker = markerRe();
  for (let m = marker.exec(source); m; m = marker.exec(source)) {
    edits.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: markerReplacement(source, m.index, m[0].length),
    });
  }

  const resolved: AgentAnchor[] = [];
  if (anchors && anchors.length > 0) {
    const protectedRegions = protectedRanges(source);
    const taken: [number, number][] = [];
    // Draft order, so an anchor's index in `resolved` is also its reading
    // order — which is what makes the marks tab in the order they are read.
    const ordered = [...anchors].sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0));

    for (const anchor of ordered) {
      const start = anchor?.start;
      const end = anchor?.end;
      const text = anchor?.text;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        typeof text !== "string" ||
        text.length === 0
      ) {
        continue;
      }
      if (start < 0 || end > source.length || start >= end) continue;
      // Check 1: the span must still say what the anchor claims.
      if (source.slice(start, end) !== text) continue;
      if (text.trim() !== text) continue;
      // Check 2: the token must survive being wrapped in link syntax.
      if (HOSTILE_TOKEN_RE.test(text)) continue;
      // Checks 3 and 4.
      if (overlaps(start, end, protectedRegions)) continue;
      if (overlaps(start, end, taken)) continue;

      taken.push([start, end]);
      edits.push({
        start,
        end,
        replacement: `[${text}](${anchorHref(messageId, resolved.length)})`,
      });
      resolved.push(anchor);
    }
  }

  // Applied back-to-front so each edit's offsets are still valid when it runs.
  edits.sort((a, b) => b.start - a.start);
  let markdown = source;
  for (const edit of edits) {
    markdown =
      markdown.slice(0, edit.start) + edit.replacement + markdown.slice(edit.end);
  }

  return { markdown, resolved, plainText };
}
