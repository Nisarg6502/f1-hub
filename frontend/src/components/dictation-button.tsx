"use client";

/**
 * The mic button for the assistant composer — CP77.
 *
 * Presentational only: it owns no recognizer. The panel holds `useDictation`
 * (it needs `stop()` on send and on New chat), and hands this component the two
 * things a button needs — whether it is listening, and how to flip that.
 *
 * State is legible without motion. While listening, the mic glyph is replaced
 * by the same two-dot mark `race-week-glimpse.tsx` uses for a live session: an
 * outer ring that pings under `motion-safe:` and a steady inner dot that stays
 * visible when `prefers-reduced-motion` turns the ping off. Colour changes too
 * (primary fill, not a bare tint), so the state does not rest on animation
 * alone.
 *
 * Focus ring is `outline`, not Tailwind `ring` — the button sits inside
 * `.apex-glass-strong`, and `globals.css` documents at length why `ring`
 * (which compiles to `box-shadow`) silently vanishes on glass surfaces.
 */

export default function DictationButton({
  listening,
  onToggle,
  disabled = false,
}: {
  listening: boolean;
  onToggle: () => void;
  /** True while a turn is in flight — the composer is inert then, and so is this. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={listening ? "Stop dictation" : "Start dictation"}
      aria-pressed={listening}
      title={listening ? "Stop dictation" : "Dictate your question"}
      className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg border transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40 ${
        listening
          ? "border-[var(--color-primary)]/60 bg-[var(--color-primary)]/18 text-[var(--color-primary)]"
          : "border-white/10 bg-surface-container-low/50 text-warm-200 hover:border-white/20 hover:text-[var(--color-on-surface)]"
      }`}
    >
      {listening ? (
        <span className="relative flex h-2.5 w-2.5 flex-none" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-primary)] opacity-75 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-primary)]" />
        </span>
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

function MicIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
    </svg>
  );
}
