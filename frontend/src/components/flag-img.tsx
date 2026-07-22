"use client";

import { useState } from "react";
import Image from "next/image";

interface FlagImgProps {
  src: string | null;
  alt: string;
  width: number;
  height: number;
  className?: string;
}

/**
 * Country flag that quietly disappears if its asset is missing, leaving the
 * surrounding chip's neutral background rather than a broken-image glyph.
 */
export default function FlagImg({
  src,
  alt,
  width,
  height,
  className,
}: FlagImgProps) {
  const [ok, setOk] = useState(Boolean(src));
  if (!ok || !src) return null;
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={() => setOk(false)}
    />
  );
}
