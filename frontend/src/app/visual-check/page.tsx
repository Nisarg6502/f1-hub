"use client";

/**
 * `/visual-check` — the harness for chat visuals.
 *
 * Same reasoning as `/agent-check`: "the component compiles" is not "the
 * feature works", and the states that matter here are precisely the ones a
 * live model will not produce on demand. Code that throws, code that never
 * returns, data that is empty, data carrying `</script>` — each is one click
 * away here and reachable with the backend switched off entirely.
 *
 * It also carries the isolation probe, which is the only way the central claim
 * of `CHAT-VISUALS-CONTRACT.md` §1 ("cannot reach the parent DOM, cookies,
 * storage, or the network") gets checked rather than asserted. That fixture
 * runs the attempts from inside a frame and prints what happened; if a row ever
 * reads REACHED, the sandbox is broken and the feature must not ship.
 *
 * Unlinked and left in the tree deliberately, exactly as `/agent-check` is —
 * the next person to touch `visual-frame.tsx` should not have to rebuild this.
 *
 * NOTE for verification: do not drive this through the Claude_Browser preview
 * pane. Its tabs are permanently `document.hidden`, `requestAnimationFrame`
 * never fires there, and anything gated on a frame looks permanently stuck.
 * Real headless Chrome over CDP shows the truth.
 */

import { useState, useSyncExternalStore } from "react";
import VisualFrame from "@/components/visual-frame";
import { VISUAL_FIXTURES } from "@/lib/visual-fixtures";

/** Panel width (480px) vs the wider chat page — the two real layouts. */
const WIDTHS = [
  { label: "panel · 480", px: 480 },
  { label: "page · 760", px: 760 },
  { label: "full", px: 0 },
];

/**
 * `?only=vis_3` / `?skip=vis_3` — comma-separated fixture ids.
 *
 * Not a convenience. The infinite-loop fixture starves the **whole renderer**,
 * not just its own frame: Chrome keeps an `about:srcdoc` child in the parent's
 * process, so a `while (true)` in model code freezes the tab, every sibling
 * frame, and the parent's own watchdog timer until the browser gives up on the
 * script. That makes the page unusable for looking at any other state, and it
 * makes automated screenshots of the other states impossible while it is on
 * the page. Being able to leave it out is what lets the rest be verified — and
 * being able to run it ALONE is what lets its cost be measured.
 */
function readFilter(): string {
  if (typeof window === "undefined") return "";
  return window.location.search;
}
function subscribeNever(): () => void {
  return () => {};
}

export default function VisualCheckPage() {
  const search = useSyncExternalStore(subscribeNever, readFilter, () => "");
  const params = new URLSearchParams(search);
  const only = (params.get("only") ?? "").split(",").filter(Boolean);
  const skip = (params.get("skip") ?? "").split(",").filter(Boolean);
  const fixtures = VISUAL_FIXTURES.filter(
    (v) =>
      (only.length === 0 || only.includes(v.visual_id)) &&
      !skip.includes(v.visual_id)
  );

  const [width, setWidth] = useState(480);
  // Remounting is how a fixture is re-run: the frame's whole point is that it
  // is a separate document, so "run it again" means "build a new one".
  const [nonce, setNonce] = useState(0);

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-headline text-2xl font-bold text-warm-100">
          Chat visuals — state harness
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-on-surface-variant)]">
          Every state of <code className="text-warm-200">VisualFrame</code>, from
          hand-written <code className="text-warm-200">visual</code> payloads. No
          agent, no model, no network.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {WIDTHS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => setWidth(w.px)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                width === w.px
                  ? "border-[var(--color-primary)] bg-[rgb(var(--rgb-primary)/0.14)] text-[var(--color-primary)]"
                  : "border-white/10 bg-surface-container-low/50 text-warm-200 hover:bg-surface-container-low/80"
              }`}
            >
              {w.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setNonce((n) => n + 1)}
            className="rounded-lg border border-white/10 bg-surface-container-low/50 px-3 py-1.5 text-xs font-medium text-warm-200 transition-colors hover:bg-surface-container-low/80"
          >
            Re-run all
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-8">
        {fixtures.map((visual, i) => (
          <section
            key={`${visual.visual_id}-${nonce}`}
            data-fixture={visual.visual_id}
            className="flex flex-col gap-2"
          >
            <h2 className="font-mono text-[11px] tracking-wide text-warm-500">
              {i + 1}. {visual.visual_id} · {visual.evidence_id}
            </h2>
            <div style={{ width: width === 0 ? "100%" : `${width}px`, maxWidth: "100%" }}>
              {/* The bubble the frame lives in is `max-w-[85%]`, so the
                  harness reproduces that container rather than the frame
                  alone — 480px of panel is not 480px of chart. */}
              <VisualFrame visual={visual} />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
