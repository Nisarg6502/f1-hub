"use client";

import LocalDateTime from "./local-datetime";
import { citationAnchorId, type AgentSource } from "@/lib/agent-api";
import { sourceKindStyle } from "@/lib/source-kind";

/**
 * One retrieved source, rendered as a real card rather than a bare chip —
 * CP68's fix for `BATCH-19-PLAN.md` §3's citation defects: a human `title`
 * instead of a raw `mongo:collection/id` string, a real relative timestamp
 * instead of a raw ISO string in a tooltip, and (for `kind !== "data"`, which
 * has no public address per `agent/tools/base.py`'s `mongo_source` docstring)
 * a genuine clickable link.
 *
 * CP71 changes two things:
 * - **The DOM id is namespaced by `messageId`.** Evidence ids restart at
 *   `ev_1` on every turn, so `id="source-ev_1"` collided across answers and
 *   `getElementById` resolved a citation in answer 3 to answer 1's card.
 * - **`position` is the number shown**, i.e. this card's 1-based place in its
 *   message's source list, so the card list reads 1, 2, 3 instead of repeating
 *   a ledger counter. The *pill* keeps the evidence's own number — a genuinely
 *   repeated citation of the same evidence should keep showing the same
 *   number, which was never the bug.
 * - Icon/accent come from the shared `source-kind` module rather than a local
 *   map, so pill, card and popover cannot drift apart.
 */
export default function SourceCard({
  source,
  messageId,
  position,
}: {
  source: AgentSource;
  messageId: string;
  position: number;
}) {
  const asOfMs = source.as_of ? new Date(source.as_of).getTime() : null;
  const kind = sourceKindStyle(source.kind);
  const body = (
    <>
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold"
        style={{ color: kind.accent, backgroundColor: kind.tint }}
        aria-hidden
      >
        {position}
      </span>
      <span
        className="material-symbols-outlined text-[14px]"
        style={{ color: kind.accent }}
        title={kind.description}
      >
        {kind.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-[var(--color-on-surface)]">
          {source.title}
        </span>
        {asOfMs && (
          <span className="block text-[10px] text-[var(--color-on-surface-variant)]">
            <LocalDateTime timestampMs={asOfMs} options={{ dateStyle: "medium", timeStyle: "short" }} />
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      id={citationAnchorId(messageId, source.id)}
      className="flex items-center gap-2 rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-2.5 py-2 transition-[background-color,box-shadow] duration-300"
    >
      {source.kind === "data" ? (
        body
      ) : (
        <a
          href={source.url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          {body}
        </a>
      )}
    </div>
  );
}
