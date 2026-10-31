"use client";

import { useSpoilers } from "@/lib/spoilers-client";

/**
 * The one control on a spoiler placeholder: "I've watched it".
 *
 * Its own client island so `SpoilerShield` itself can stay a plain component
 * that renders on the server. That matters for more than bundle size: if the
 * shield were a client component, a server page passing it `children` would
 * serialise those children into the payload even while the shield declined to
 * draw them.
 */
export default function SpoilerRevealButton({
  raceKeys,
  label,
  size = "md",
}: {
  raceKeys: string[];
  label?: string;
  size?: "md" | "sm";
}) {
  const { revealMany, pending } = useSpoilers();
  const text = label ?? "I’ve watched it — show results";

  return (
    <button
      type="button"
      onClick={() => revealMany(raceKeys)}
      disabled={pending || raceKeys.length === 0}
      aria-busy={pending || undefined}
      className={`relative inline-flex items-center justify-center gap-2 rounded-control font-bold text-[#1a1210] transition-[transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-60 disabled:cursor-wait whitespace-nowrap ${
        size === "sm" ? "h-9 px-4 text-[11px] before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']" : "h-11 px-5 text-xs"
      }`}
      style={{
        background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))",
      }}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        visibility
      </span>
      {pending ? "Revealing…" : text}
    </button>
  );
}
