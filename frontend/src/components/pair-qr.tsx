"use client";

/**
 * The pairing code as a QR the phone can scan.
 *
 * Typing `ABCD 2345` was the whole cost of the second screen: the phone had to
 * find the site, find the race, open the pairing panel and transcribe a code
 * that expires — four steps before anything happens, three of them navigation.
 * The QR encodes a deep link that collapses all four into pointing a camera,
 * because it carries the race in the path and the code in the query
 * (`/watch/<raceId>?pair=<CODE>`), and the watch page joins on arrival.
 *
 * Rendered as an SVG path built from the module matrix rather than through
 * `qrcode`'s own SVG/canvas renderers or `dangerouslySetInnerHTML`. Two
 * reasons, both practical: the markup stays a single `<path>` (each row of
 * dark modules collapses into one horizontal run, so a 33x33 code is a few
 * hundred bytes rather than a thousand `<rect>` elements), and the colours come
 * from this file instead of a library default that knows nothing about the
 * page it lands on.
 *
 * On a LIGHT plate, deliberately, on a dark-themed page. Scanners assume dark
 * modules on a light background; inverted codes are read by some and not
 * others, and a pairing affordance that works on one phone is worse than one
 * that looks slightly out of place. The plate also supplies the quiet zone —
 * the spec asks for four modules of margin and the padding here is that
 * margin, not decoration.
 */

import { useMemo } from "react";
import QRCode from "qrcode";

/** Modules of clear space required around the symbol by the QR spec. */
const QUIET_ZONE = 4;

interface PairQrProps {
  /** The URL to encode. */
  value: string;
  /** Rendered edge length in CSS pixels, quiet zone included. */
  size?: number;
}

function buildPath(value: string): { d: string; span: number } | null {
  try {
    // 'M' corrects ~15% damage. 'L' would make the symbol smaller and denser
    // to scan; 'Q'/'H' buy resilience this does not need, since the code is on
    // a screen a foot away rather than printed on a box.
    const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
    const size = qr.modules.size;
    const data = qr.modules.data;
    const runs: string[] = [];

    for (let y = 0; y < size; y += 1) {
      let x = 0;
      while (x < size) {
        if (!data[y * size + x]) {
          x += 1;
          continue;
        }
        let run = 1;
        while (x + run < size && data[y * size + x + run]) run += 1;
        runs.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
        x += run;
      }
    }

    return { d: runs.join(""), span: size + QUIET_ZONE * 2 };
  } catch {
    // An over-long URL is the only realistic failure. The code stays readable
    // beneath it, so the caller can render nothing here and lose an
    // affordance rather than the feature.
    return null;
  }
}

export default function PairQr({ value, size = 164 }: PairQrProps) {
  const qr = useMemo(() => buildPath(value), [value]);
  if (!qr) return null;

  return (
    <div
      className="rounded-2xl p-2.5 bg-[#f6f1ea]"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${qr.span} ${qr.span}`}
        width="100%"
        height="100%"
        role="img"
        aria-label="QR code that opens this replay on another device and pairs it"
        shapeRendering="crispEdges"
      >
        {/* Painted rather than left transparent: the plate behind it is opaque
            anyway, and a scanner reading a screenshot of this needs the light
            field to travel with the dark modules. */}
        <rect width={qr.span} height={qr.span} fill="#f6f1ea" />
        <path d={qr.d} fill="#17110d" />
      </svg>
    </div>
  );
}
