"use client";

import LocalDateTime from "./local-datetime";
import type { AgentSource } from "@/lib/agent-api";

const KIND_ICON: Record<AgentSource["kind"], string> = {
  data: "database",
  web: "public",
  wikipedia: "menu_book",
};

/**
 * One retrieved source, rendered as a real card rather than a bare chip —
 * CP68's fix for `BATCH-19-PLAN.md` §3's citation defects: a human `title`
 * instead of a raw `mongo:collection/id` string, a real relative timestamp
 * instead of a raw ISO string in a tooltip, and (for `kind !== "data"`, which
 * has no public address per `agent/tools/base.py`'s `mongo_source` docstring)
 * a genuine clickable link.
 */
export default function SourceCard({ source }: { source: AgentSource }) {
  const asOfMs = source.as_of ? new Date(source.as_of).getTime() : null;
  const body = (
    <>
      <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">
        {KIND_ICON[source.kind]}
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
      id={`source-${source.id}`}
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
