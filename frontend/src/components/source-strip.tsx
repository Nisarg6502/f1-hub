"use client";

import LocalDateTime from "./local-datetime";
import { citationAnchorId, type AgentSource } from "@/lib/agent-api";
import { sourceKindStyle } from "@/lib/source-kind";

/**
 * CP74 — the bibliography becomes a strip of records, not a numbered list.
 *
 * This replaces `SourceCard`. The stack of numbered cards was the below-answer
 * half of the reported "one citation inline, five listed below": the inline
 * markers came from whatever ids the model wrote, the cards came from every
 * entry the *tools* retrieved, and the two were derived independently. CP72
 * made both come from one anchor set — the backend no longer lists an entry
 * the answer did not lean on — so the counts can no longer disagree. What is
 * left to do here is stop *presenting* it as a bibliography.
 *
 * So: no numbers. A number on a card only ever existed to be matched against a
 * superscript, and there are no superscripts now. Each chip says which record
 * was used, how many facts in the answer rest on it, and how fresh it is. The
 * fact count is the honest replacement for the number — it is information the
 * reader can act on, and it comes straight from the anchors backing the
 * underlines above.
 *
 * The chip keeps `citationAnchorId`'s namespaced DOM id, because activating an
 * inline mark flashes its record here: that is the one thing the numbering did
 * usefully — tying a value in the prose to a record below — and a flash does it
 * without asking anyone to match digits.
 */
export default function SourceStrip({
  sources,
  messageId,
  resolved,
}: {
  sources: AgentSource[];
  messageId: string;
  /**
   * The anchors that actually became underlines in the prose above.
   *
   * Counting the *backend's* anchors here was the reported divergence coming
   * back in a new shape. The backend and the frontend dedupe overlapping spans
   * by different rules — the backend per evidence id, the frontend globally —
   * so a sentence citing two records that both contain the same value yields
   * two backend anchors on one span and only one surviving mark. The strip
   * would then advertise "Driver standings — 2 facts" while no underline in
   * the answer could ever open that record. Any other reason a mark is dropped
   * (a hostile token, a protected region) produced the same lie.
   *
   * So the count, and whether a record is listed at all, come from what the
   * reader can actually reach. That is what makes the design's "inline and
   * below-answer counts cannot diverge" true rather than merely intended.
   */
  resolved: readonly { evidence_id: string }[];
}) {
  const reachable = new Map<string, number>();
  for (const anchor of resolved) {
    reachable.set(anchor.evidence_id, (reachable.get(anchor.evidence_id) ?? 0) + 1);
  }
  // A record with no surviving mark is still shown — it *was* used, and hiding
  // it would understate the answer's evidence — but it is shown without a
  // count it cannot back up.
  const visible = sources;
  if (visible.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-[var(--color-on-surface-variant)] uppercase">
        {sources.length === 1 ? "Record used" : "Records used"}
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {visible.map((source) => (
          <SourceChip
            key={source.id}
            source={source}
            messageId={messageId}
            factCount={reachable.get(source.id) ?? 0}
          />
        ))}
      </ul>
    </div>
  );
}

function SourceChip({
  source,
  messageId,
  factCount,
}: {
  source: AgentSource;
  messageId: string;
  /** Marks the reader can actually reach — see `SourceStrip`'s `resolved`. */
  factCount: number;
}) {
  const kind = sourceKindStyle(source.kind);
  const asOfMs = source.as_of ? new Date(source.as_of).getTime() : null;
  // Internal data has no public address (`agent/tools/base.py`'s
  // `mongo_source`), so only web-ish records become links. A chip that looks
  // clickable and goes nowhere is worse than a chip that does not.
  const linkable = source.kind !== "data" && Boolean(source.url);

  const body = (
    <>
      <span
        className="material-symbols-outlined shrink-0 text-[13px] leading-none"
        style={{ color: kind.accent }}
        aria-hidden
      >
        {kind.icon}
      </span>
      <span className="min-w-0 truncate text-[11px] font-medium text-[var(--color-on-surface)]">
        {source.title}
      </span>
      {factCount > 0 && (
        <span className="shrink-0 text-[10px] text-[var(--color-on-surface-variant)]">
          {factCount === 1 ? "1 fact" : `${factCount} facts`}
        </span>
      )}
      {asOfMs && (
        <span className="shrink-0 text-[10px] text-[var(--color-on-surface-variant)]">
          <LocalDateTime timestampMs={asOfMs} options={{ dateStyle: "medium" }} />
        </span>
      )}
      {linkable && (
        <span className="material-symbols-outlined shrink-0 text-[12px] leading-none text-[var(--color-on-surface-variant)]" aria-hidden>
          open_in_new
        </span>
      )}
    </>
  );

  const shell =
    "flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-[var(--color-surface-container-low)] px-2.5 py-1 transition-[background-color,box-shadow,border-color] duration-300";

  // The shell stays on the `<li>` in both branches so `apex-citation-flash`
  // always has the chip's own background and border to ring — the flash is
  // how an inline mark points at its record, and a ring around an empty box
  // would be a worse affordance than no ring at all.
  return (
    <li
      id={citationAnchorId(messageId, source.id)}
      className={`${shell} max-w-full`}
      title={kind.description}
    >
      {linkable ? (
        <a
          href={source.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-1.5 transition-opacity duration-150 hover:opacity-80"
        >
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}
