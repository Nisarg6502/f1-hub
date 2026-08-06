"use client";

/**
 * Renders a `[ev_N]` citation marker (rewritten by `rewriteCitations` into a
 * `#cite-ev_N` markdown link) as a numbered, clickable pill that scrolls to
 * and briefly highlights its matching `SourceCard`. Registered as the `a`
 * component override for `react-markdown` — an ordinary markdown link
 * (anything not matching the `#cite-ev_` href shape) renders as a normal
 * link, unchanged, so this component is safe to register globally on every
 * answer even for messages containing a genuine external link.
 */
export default function CitationPill({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const match = href?.match(/^#cite-(ev_\d+)$/);
  if (!match) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    );
  }
  const evidenceId = match[1];
  return (
    <button
      type="button"
      onClick={() => {
        const target = document.getElementById(`source-${evidenceId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: "smooth", block: "nearest" });
        target.classList.add("apex-citation-flash");
        window.setTimeout(() => target.classList.remove("apex-citation-flash"), 1200);
      }}
      className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-primary)]/20 px-1 text-[10px] font-semibold text-[var(--color-primary)] align-super transition-[background-color,transform] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] hover:bg-[var(--color-primary)]/35 active:scale-95"
      aria-label={`Jump to source ${children}`}
    >
      {children}
    </button>
  );
}
