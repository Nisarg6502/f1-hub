"use client";

import { useState } from "react";
import Image from "next/image";

interface TrackMapProps {
  src: string | null;
  alt: string;
  /** classes for the outer box (size, rounding, absolute positioning) */
  containerClassName?: string;
  /** classes for the <Image> (fit, padding, opacity) */
  imgClassName?: string;
  labelClassName?: string;
  label?: string;
  sizes?: string;
}

/**
 * Circuit outline image with a graceful fallback: if the asset is missing
 * (e.g. the CDN asset base isn't configured), it drops back to the APEX hatch
 * placeholder instead of a broken image. The hatch is a fallback-only texture
 * now — applying it under a loaded image made every circuit's transparent
 * PNG/AVIF sit on top of a dark diagonal-stripe pattern, which is what made
 * the artwork look faded and "wrong" even when it had loaded correctly.
 */
export default function TrackMap({
  src,
  alt,
  containerClassName = "",
  imgClassName = "object-contain",
  labelClassName = "font-semibold text-[9px] tracking-[0.1em] text-warm-600",
  label = "// TRACK MAP",
  sizes = "(max-width: 768px) 100vw, 400px",
}: TrackMapProps) {
  const [ok, setOk] = useState(Boolean(src));

  // Only default to `relative` when the caller hasn't specified their own
  // position utility (e.g. the featured circuit card passes `absolute
  // inset-0` to fill its parent). Including both unconditionally used to
  // silently break that case: Tailwind's stylesheet puts `.relative` after
  // `.absolute`, so at equal specificity `relative` always won regardless of
  // class order here, leaving the fill image with no sized ancestor to fill
  // and collapsing it to zero height.
  const hasPositionOverride = /\b(absolute|fixed|sticky|static)\b/.test(
    containerClassName
  );

  return (
    <div
      className={`overflow-hidden flex items-center justify-center ${
        hasPositionOverride ? "" : "relative"
      } ${ok && src ? "bg-[rgba(245,235,222,0.035)]" : "apex-hatch"} ${containerClassName}`}
    >
      {ok && src ? (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          className={imgClassName}
          onError={() => setOk(false)}
        />
      ) : (
        <span className={labelClassName}>{label}</span>
      )}
    </div>
  );
}
