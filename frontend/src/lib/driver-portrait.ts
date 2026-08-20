import type { CSSProperties } from "react";

/**
 * Framing for the driver cutouts in /public/drivers.
 *
 * All 22 assets share one studio geometry. Measured off the alpha channel of
 * every file (not assumed):
 *
 *   - every image is 440 x 1265 with a transparent background
 *   - the top of the head sits at row 4-20 (mean 10)
 *   - the narrowest point of the neck sits at row 153-188 (mean 172)
 *   - the shoulders flare out by row 211-256 (mean 232)
 *   - the head is horizontally centred at x = 217 of 440 (49.3%)
 *
 * So the head occupies roughly the top 14% of a very tall image, and that is
 * why `object-fit: cover` cannot frame it. Cover chooses *which part* of a
 * fixed-scale image is visible, never the scale. On the 36px square avatar in
 * the standings it showed a 440 x 440 source window, and `object-position:
 * 50% 10%` slid that window down to source rows 83-523 — below the chin, which
 * is exactly the "faces cut off at the top" the standings page showed. On the
 * short, wide photo band of a driver card it did the opposite: cover scaled to
 * the box width, so a 248 x 120 band showed source rows 0-213 — a head, alone,
 * filling the card edge to edge.
 *
 * Framing therefore needs a zoom, and a zoom needs an element whose size is
 * derived from the source geometry rather than from the container. That is
 * what `driverPortraitFrameStyle` returns: a wrapper box, scaled so a chosen
 * band of source rows exactly spans the container's height and centred on the
 * head's x. Put it inside a `relative`, `overflow-hidden` container and put an
 * ordinary `<Image fill>` inside it.
 *
 * The geometry deliberately lives on a wrapper and not on the image's own
 * `style`. `next/image` rejects that: `get-img-props.js` throws on `fill`
 * combined with a `style.width`/`style.height`/`style.position` that is not its
 * own — and only under `if (process.env.NODE_ENV !== 'production')`, so styling
 * the image directly renders fine in a production build and crashes the page in
 * dev. The wrapper is invisible to that check.
 */

export const DRIVER_PORTRAIT_SOURCE_WIDTH = 440;
export const DRIVER_PORTRAIT_SOURCE_HEIGHT = 1265;

/**
 * `face`   — head, neck and a sliver of shoulder; for small square avatars.
 * `bust`   — head to upper chest; for cards and hero panels.
 * `figure` — head down to mid-torso, meant to be CLIPPED at the container's
 *            bottom edge so the driver reads as standing in the card rather
 *            than as a photo that happens to end. Its band runs past the
 *            bottom of the container on purpose (see FRAME_BANDS).
 */
export type DriverPortraitFrame = "face" | "bust" | "figure";

/**
 * Source-row band that each frame maps onto the container's height. The top of
 * every band is negative on purpose: the head starts at row ~10, so a band
 * starting at 0 would leave the crown touching the very edge of the frame.
 */
const FRAME_BANDS: Record<DriverPortraitFrame, readonly [number, number]> = {
  face: [-16, 250],
  bust: [-24, 440],
  // Row 520 of 1265 is upper-mid torso. Mapping it to the container's bottom
  // edge means the figure is cut off there by the container's own
  // `overflow: hidden` rather than fading out or floating — which is what
  // makes a cutout sit in a card instead of on it.
  figure: [-20, 520],
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Inline style for the wrapper that sits between an overflow-hidden container
 * and an `<Image fill>`. Percentages are relative to the container, so the
 * frame follows the container's height at every breakpoint with no JS.
 */
export function driverPortraitFrameStyle(
  frame: DriverPortraitFrame = "face"
): CSSProperties {
  const [bandTop, bandBottom] = FRAME_BANDS[frame];
  const band = bandBottom - bandTop;
  return {
    position: "absolute",
    left: "50%",
    top: `${round2((-bandTop / band) * 100)}%`,
    // Height is the whole image scaled so `band` source rows fill the
    // container; the aspect ratio then supplies the width, so the box can
    // overflow the container sideways and be clipped rather than squashed.
    height: `${round2((DRIVER_PORTRAIT_SOURCE_HEIGHT / band) * 100)}%`,
    aspectRatio: `${DRIVER_PORTRAIT_SOURCE_WIDTH} / ${DRIVER_PORTRAIT_SOURCE_HEIGHT}`,
    transform: "translateX(-50%)",
  };
}

/**
 * The width the image actually renders at for a container of a given pixel
 * height — the honest value for `sizes`, which next/image would otherwise
 * guess from the container's width and under-fetch (the standings avatar is a
 * 36px-wide box that renders a 60px-wide image).
 */
export function driverPortraitRenderedWidth(
  containerHeightPx: number,
  frame: DriverPortraitFrame = "face"
): number {
  const [bandTop, bandBottom] = FRAME_BANDS[frame];
  return Math.ceil(
    (containerHeightPx * DRIVER_PORTRAIT_SOURCE_WIDTH) / (bandBottom - bandTop)
  );
}

/** `sizes` string for a container of a known pixel height. */
export function driverPortraitSizes(
  containerHeightPx: number,
  frame: DriverPortraitFrame = "face"
): string {
  return `${driverPortraitRenderedWidth(containerHeightPx, frame)}px`;
}

/**
 * Where a given source row lands inside the container, as a fraction of the
 * container's height (0 = top edge, 1 = bottom edge). Exists so a check can
 * assert the face is actually inside the frame instead of eyeballing it.
 */
export function driverPortraitRowFraction(
  sourceRow: number,
  frame: DriverPortraitFrame = "face"
): number {
  const [bandTop, bandBottom] = FRAME_BANDS[frame];
  return (sourceRow - bandTop) / (bandBottom - bandTop);
}
