"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";

/**
 * Mirrors `pitwall-assistant-panel.tsx`'s `ActivityEntry`. Declared (and
 * exported) here rather than imported because that panel keeps the type
 * private and this component is meant to be usable without pulling the whole
 * panel module in; Task 5 swaps the panel over to this definition.
 */
export type ActivityEntry = {
  label: string;
  state: "start" | "done";
  detail?: string | null;
  kind: "tool" | "agent" | "system";
};

/**
 * A completed step's marker, encoded redundantly by shape + color + size (not
 * size alone — at 10-11px text a 0.5px size delta doesn't reliably read) so
 * "agent" (a subagent delegation), "tool" (a single tool call) and "system"
 * (housekeeping) stay distinguishable without relying on color perception
 * alone: agent is a small rounded square in the secondary color, tool is the
 * plain round dot this timeline already used, system is the same dot dimmed
 * down so routine housekeeping recedes instead of competing for attention.
 *
 * CP71: moved here verbatim from `pitwall-assistant-panel.tsx` rather than
 * duplicated — one definition means the marker language CP70 established
 * cannot drift between the two call sites.
 */
export function ActivityMarker({ kind }: { kind: ActivityEntry["kind"] }) {
  if (kind === "agent") {
    return <span className="h-1.5 w-1.5 rounded-hairline bg-[var(--color-secondary)]" />;
  }
  if (kind === "system") {
    return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]/40" />;
  }
  return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]" />;
}

/** Steps that reached `done`, in arrival order. */
function doneEntries(activity: ActivityEntry[]): ActivityEntry[] {
  return activity.filter((entry) => entry.state === "done");
}

/**
 * Steps still in flight: a `start` with no matching later `done` for the same
 * label. Same reasoning as the timeline this replaces — a repaired draft can
 * legitimately re-run a step, so matching is by label *and* position.
 */
function activeEntries(activity: ActivityEntry[]): ActivityEntry[] {
  return activity.filter(
    (entry, index) =>
      entry.state === "start" &&
      !activity
        .slice(index + 1)
        .some((later) => later.label === entry.label && later.state === "done")
  );
}

function StepList({ activity }: { activity: ActivityEntry[] }) {
  const done = doneEntries(activity);
  const active = activeEntries(activity);

  return (
    <ul className="space-y-1 text-xs text-[var(--color-warm-500)]">
      {done.map((entry, index) => (
        <li key={`${entry.label}-${index}`} className="flex items-center gap-1.5">
          <ActivityMarker kind={entry.kind} />
          {entry.label}
          {entry.detail && (
            <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
          )}
        </li>
      ))}
      {active.map((entry, index) => (
        <li key={`active-${entry.label}-${index}`} className="flex items-center gap-1.5">
          <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--color-primary)]" />
          {entry.label}…
          {entry.detail && (
            <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The assistant's step timeline, in two states.
 *
 * **In flight** (`settled === false`): identical to the always-expanded
 * timeline this replaces. During a 30-60s answer the streaming steps are the
 * only evidence the thing is working, so nothing here is hidden or delayed —
 * no chevron, no collapse, no interaction required.
 *
 * **Settled** (`settled === true`): the steps have served their purpose and
 * the answer is now the point, so they fold into one summary row
 * ("Worked through 3 steps · 12s") with a chevron. Default collapsed; click
 * to re-read the full list.
 *
 * `emil-design-eng` on the motion:
 * - The collapse is *occasional* (once per answer), so it earns an animation —
 *   but it stays under 300ms. Expand 220ms, collapse 160ms: the exit is
 *   faster than the enter because the user is done reading and the system
 *   should get out of the way quickly.
 * - `cubic-bezier(0.23, 1, 0.32, 1)` — the strong ease-out this codebase
 *   already favours. Built-in `ease-out` is too weak here and `ease-in` would
 *   delay exactly the first frames the eye is watching.
 * - Height *and* opacity together, with opacity on a shorter window than the
 *   height so the text is gone before the box finishes closing — otherwise
 *   you watch legible text get guillotined by the clip edge.
 * - The chevron rotates 180° on the same curve/duration as the expand, so the
 *   affordance and the content read as one movement rather than two.
 * - `prefers-reduced-motion`: height/rotation animation is dropped entirely
 *   (durations collapse to 0) and only the opacity change survives, matching
 *   `globals.css`'s reduced-motion block and the `useReducedMotion` pattern
 *   used across this codebase's other motion components.
 */
export function ActivityAccordion({
  activity,
  settled,
  elapsedLabel,
}: {
  activity: ActivityEntry[];
  settled: boolean;
  elapsedLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const reduce = useReducedMotion();

  if (activity.length === 0) return null;

  if (!settled) {
    return <StepList activity={activity} />;
  }

  const stepCount = doneEntries(activity).length;
  const summary = [
    `Worked through ${stepCount} ${stepCount === 1 ? "step" : "steps"}`,
    elapsedLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  const ease = [0.23, 1, 0.32, 1] as const;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className="group flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-[var(--color-on-surface-variant)] transition-colors duration-150 hover:text-[var(--color-warm-500)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-primary)] active:scale-[0.98]"
      >
        <motion.span
          aria-hidden
          className="material-symbols-outlined text-[14px] leading-none"
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: reduce ? 0 : 0.22, ease }}
        >
          chevron_right
        </motion.span>
        {summary}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="steps"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{
              height: 0,
              opacity: 0,
              // Exit timing has to live on the variant, not the shared
              // `transition` prop: an exiting element keeps the props it had
              // while visible, so a ternary up there would always resolve to
              // the enter duration.
              transition: {
                height: { duration: reduce ? 0 : 0.16, ease },
                opacity: { duration: reduce ? 0 : 0.1, ease },
              },
            }}
            transition={{
              height: { duration: reduce ? 0 : 0.22, ease },
              opacity: { duration: reduce ? 0 : 0.12, ease },
            }}
            className="overflow-hidden"
          >
            <div className="pt-1 pl-1">
              <StepList activity={activity} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
