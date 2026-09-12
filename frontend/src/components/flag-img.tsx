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
 * Countries whose three-letter code is not simply the first three letters of
 * their name. Only the ones that can actually reach this fallback need an
 * entry — a country with a flag asset never renders a code.
 */
const COUNTRY_CODES: Record<string, string> = {
  "Saudi Arabia": "KSA",
  "United States": "USA",
  "United Kingdom": "GBR",
  "Great Britain": "GBR",
  "South Africa": "RSA",
  "South Korea": "KOR",
  "New Zealand": "NZL",
  Switzerland: "SUI",
  Netherlands: "NED",
  Portugal: "POR",
  Germany: "GER",
  Malaysia: "MAS",
};

function countryCode(country: string): string {
  const trimmed = country.trim();
  return (
    COUNTRY_CODES[trimmed] ?? trimmed.slice(0, 3).toUpperCase()
  );
}

/**
 * Country flag, with a three-letter country code as its fallback.
 *
 * This used to render `null` when an asset was missing, which left the
 * surrounding chip as a bare grey rectangle — read as a broken image rather
 * than as missing data. Six countries can hit that today: the 2026 calendar's
 * Malaysian round, plus Bahrain, Portugal, Russia, Saudi Arabia and Turkey on
 * the seasons the year picker reaches back to. A code is not a flag, but it
 * names the country, which an empty box does not.
 *
 * The `onError` path matters as much as the `src == null` one: the assets are
 * served from a GCS bucket, so a flag can exist in the map and still 404.
 */
export default function FlagImg({
  src,
  alt,
  width,
  height,
  className,
}: FlagImgProps) {
  const [ok, setOk] = useState(Boolean(src));

  if (!ok || !src) {
    return (
      <span
        // The country name is already on the row next to this, so the code is
        // decoration for a screen reader and would only be read twice.
        aria-hidden="true"
        className="flex items-center justify-center w-full h-full font-semibold text-[9px] tracking-[0.06em] text-warm-400 select-none"
      >
        {countryCode(alt)}
      </span>
    );
  }

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
