/**
 * A team's car, used as graphic furniture rather than as a picture.
 *
 * Every surface that wanted one wanted a *fragment* — a nose pushing in from an
 * edge, a silhouette dissolving behind a row — because a whole 4.5:1 car
 * dropped into a UI panel stops being decoration and starts being the subject.
 * So this never draws a car to be looked at; it draws one to be felt at the
 * edge of attention, and every variant fades out before it can compete with
 * the text on top of it.
 *
 * Three things do the work, and the first two are easy to get wrong together:
 *
 *   1. **`cover` crops, `contain` never does.** The first version of this
 *      component tried to crop to a nose by making the image box wider than its
 *      container while keeping `object-contain`. That cannot work: `contain`
 *      picks the scale that fits the *whole* image, so a wider box just adds
 *      transparent padding either side and re-centres the same complete car.
 *      Cropping to a fragment requires `cover`. The `nose-*` variants use it;
 *      the `ghost-*` variants genuinely do want the whole car and keep
 *      `contain`.
 *   2. **`object-position` must be set explicitly.** Both fits centre by
 *      default, so "anchored to the right edge" does not happen just because
 *      the box is on the right — without this every variant floats in the
 *      middle of its box and the fade lands in the wrong place.
 *   3. **A mask, not an opacity ramp.** `mask-image` fades the car's own pixels
 *      to transparent, so whatever is behind it (a team-colour wash, a card
 *      gradient) shows through cleanly. A gradient overlay would instead paint
 *      a coloured veil over both the car and the background.
 *
 * How much of the car a `nose-*` variant keeps is decided entirely by the box's
 * aspect ratio, since `cover` is height-bound here: a box `n` times as wide as
 * it is tall keeps the leading `n / 4.54` of the car. So a 2.7:1 box shows the
 * front ~60%, and a box as wide as the car itself shows all of it and crops
 * nothing. Callers wanting a real nose must give a box distinctly *narrower*
 * than 4.54:1 — widening it does the opposite of what it looks like it should.
 *
 * The renders' alpha channel is load-bearing for all of this: cropping a car
 * off a white plate would leave a hard rectangle exactly where the fade is
 * meant to be.
 *
 * `aria-hidden` with an empty `alt` throughout, in every case: the team is
 * always named in text within a few pixels of wherever one of these is used, so
 * announcing "Ferrari car" would be a second reading of the same fact.
 */

import Image from "next/image";
import { getTeamCarPath } from "@/lib/team-images";

export type TeamCarVariant =
  /** Front of the car, pointing right, pinned to the box's right edge, tail
   * cropped and dissolving leftward. The left half of a head-to-head. */
  | "nose-right"
  /** Mirror of the above — the right half of a head-to-head. */
  | "nose-left"
  /** The whole car, pinned right, dissolving leftward. Sits behind a row whose
   * text starts at the left. */
  | "ghost-right"
  /** The whole car, pinned left, dissolving rightward. */
  | "ghost-left";

interface VariantSpec {
  facing: "left" | "right";
  /** `cover` crops to a fragment; `contain` keeps the whole car. */
  fit: "cover" | "contain";
  /** Edge the car is pinned to — also the end the fade starts from. */
  anchor: "left" | "right";
  /** Where the mask reaches full transparency, as a fraction of the box. */
  fadeStart: number;
}

const VARIANTS: Record<TeamCarVariant, VariantSpec> = {
  "nose-right": { facing: "right", fit: "cover", anchor: "right", fadeStart: 0.4 },
  "nose-left": { facing: "left", fit: "cover", anchor: "left", fadeStart: 0.4 },
  "ghost-right": { facing: "right", fit: "contain", anchor: "right", fadeStart: 0.12 },
  "ghost-left": { facing: "left", fit: "contain", anchor: "left", fadeStart: 0.12 },
};

export default function TeamCar({
  team,
  variant,
  className = "",
  opacity = 1,
  sizes = "(min-width: 768px) 40vw, 80vw",
}: {
  team?: string;
  variant: TeamCarVariant;
  /** Positions and sizes the box. Must establish its own height, and for the
   * `nose-*` variants its width/height ratio decides how much car you see —
   * see the note above. */
  className?: string;
  opacity?: number;
  sizes?: string;
}) {
  const spec = VARIANTS[variant];
  const src = getTeamCarPath(team, spec.facing);
  // All 11 current constructors have a car, so this only fires for a season
  // whose team list predates the mirror — a historical standings page, say.
  // Rendering nothing is right: these are all decorative, and every caller's
  // layout holds its own shape without one.
  if (!src) return null;

  // Percentages, so the ramp scales with the box rather than being pinned to a
  // pixel width that only looks right at one size. The fade always runs *away*
  // from the anchored edge, so the detailed end of the car stays crisp and the
  // cropped end is the one that dissolves.
  const direction = spec.anchor === "right" ? "to left" : "to right";
  const mask = `linear-gradient(${direction}, rgba(0,0,0,1) ${spec.fadeStart * 100}%, rgba(0,0,0,0) 100%)`;

  return (
    <div
      aria-hidden
      className={`pointer-events-none overflow-hidden ${className}`}
      style={{
        opacity,
        maskImage: mask,
        // Safari still wants the prefix, and this is exactly the kind of
        // silent no-op that ships looking fine in Chrome: without it the mask
        // is ignored and the car appears as a hard-edged cutout.
        WebkitMaskImage: mask,
      }}
    >
      <Image
        src={src}
        alt=""
        fill
        sizes={sizes}
        className={spec.fit === "cover" ? "object-cover" : "object-contain"}
        style={{ objectPosition: `${spec.anchor} center` }}
      />
    </div>
  );
}
