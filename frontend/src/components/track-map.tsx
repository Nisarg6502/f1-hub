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
 * placeholder instead of a broken image. The hatch is always the box's
 * background, so the fallback needs no extra markup.
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

  return (
    <div
      className={`relative overflow-hidden apex-hatch flex items-center justify-center ${containerClassName}`}
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
