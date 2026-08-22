/**
 * CP71 — the single source of truth for how a citation *source kind* looks.
 *
 * The pill, the source card and the citation popover all render the same three
 * kinds. Before this module each surface carried its own icon map (see
 * `source-card.tsx`'s `KIND_ICON`), which is exactly how three surfaces drift
 * apart. Everything visual about a kind — icon, accent, label, description —
 * lives here now.
 *
 * Pure module by design: no JSX, no React import, no CSS import. It is a data
 * table, so it is trivially importable from a server component, a test, or a
 * plain utility.
 *
 * ## Design notes (reviewed against `emil-design-eng`)
 *
 * - **Shape carries the distinction, not colour.** At 14px — the size the icon
 *   actually renders at in a pill — hue differences collapse, and ~8% of male
 *   readers cannot use hue at all. The three glyphs were picked for distinct
 *   *silhouettes*: a stacked cylinder (`database`), a round globe (`public`),
 *   a wide open book (`menu_book`). Those read apart as pure black shapes.
 * - **Accents stay inside the APEX warm palette.** Introducing three saturated
 *   hues (blue/green/purple) into a monochromatic warm-orange system would be
 *   louder than the content it annotates. Instead the kinds separate on a
 *   *luminance* ramp — which survives greyscale and colour-blindness — with the
 *   hero orange reserved for first-party data. That reservation is semantic:
 *   the brand accent means "this came from us".
 * - Every accent is a `var(--color-*)` token from `globals.css`, never a literal
 *   hex, so a future theme flips these with the rest of the app.
 */

/**
 * The kinds the backend emits today, mirroring `AgentSource["kind"]` in
 * `agent-api.ts`. Kept structurally identical rather than imported so this
 * module stays dependency-free; `sourceKindStyle` accepts `string` anyway.
 */
export type SourceKind = "data" | "web" | "wikipedia";

export interface SourceKindStyle {
  /** The canonical kind key, or `"unknown"` when the input was unrecognised. */
  kind: SourceKind | "unknown";
  /** Material Symbols (outlined) ligature name. */
  icon: string;
  /** Foreground accent — a `var(--color-*)` token, safe in any CSS colour slot. */
  accent: string;
  /** Low-alpha wash for badge/chip backgrounds behind {@link accent}. */
  tint: string;
  /** One or two words, for a badge. */
  label: string;
  /** One compact sentence, for a tooltip or popover subheading. */
  description: string;
}

const STYLES: Record<SourceKind, SourceKindStyle> = {
  data: {
    kind: "data",
    // Stacked-cylinder silhouette — the only tall, layered glyph of the three.
    icon: "database",
    // The hero accent, reserved for first-party F1 Hub data.
    accent: "var(--color-primary)",
    tint: "rgb(var(--rgb-primary) / 0.14)",
    label: "Database",
    description: "Timing and results from F1 Hub's own database.",
  },
  web: {
    kind: "web",
    // Round globe — the only circular silhouette of the three.
    icon: "public",
    // Deliberately muted: third-party pages are not endorsed by the brand.
    accent: "var(--color-warm-300)",
    tint: "rgba(168, 158, 144, 0.16)",
    label: "Web",
    description: "A page found on the open web during this answer.",
  },
  wikipedia: {
    kind: "wikipedia",
    // Open book — the only wide, horizontal silhouette of the three.
    icon: "menu_book",
    // Near-white paper tone: brightest of the ramp, distinct from `web`'s grey
    // even in greyscale.
    accent: "var(--color-warm-100)",
    tint: "rgba(246, 241, 234, 0.12)",
    label: "Wikipedia",
    description: "An encyclopaedia article giving background context.",
  },
};

/**
 * Fallback for a kind this build has never heard of. The union is owned by the
 * backend and can grow ahead of the frontend; a citation with an unknown kind
 * must still render as a plausible source rather than crash the whole answer.
 */
const UNKNOWN: SourceKindStyle = {
  kind: "unknown",
  // A neutral chain-link: reads as "a source" without claiming which sort.
  icon: "link",
  accent: "var(--color-warm-400)",
  tint: "rgba(143, 134, 122, 0.14)",
  label: "Source",
  description: "A source cited in this answer.",
};

/** Every known kind, in the order they should appear in legends or filters. */
export const SOURCE_KINDS: readonly SourceKind[] = ["data", "web", "wikipedia"];

/** Narrowing guard for values arriving from the network. */
export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && value in STYLES;
}

/**
 * Visual identity for a citation source kind.
 *
 * Accepts any string (or `null`/`undefined`) so callers can pass a raw API
 * value straight through; anything unrecognised returns {@link UNKNOWN} rather
 * than throwing or returning `undefined`.
 */
export function sourceKindStyle(kind: string | null | undefined): SourceKindStyle {
  return isSourceKind(kind) ? STYLES[kind] : UNKNOWN;
}
