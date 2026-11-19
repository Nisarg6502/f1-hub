import type { Metadata } from "next";
import { parseWatchParams } from "./share";

/**
 * The link-preview metadata every public page shares.
 *
 * Next merges a page's metadata into its layout's SHALLOWLY: a page that sets
 * `openGraph` replaces the whole block, so it loses the layout's `siteName` and
 * its image. That is how the race, standings, drivers, teams and schedule pages
 * shipped with a title and a description but no preview picture (measured on the
 * live site, 2026-11-17), and why a pasted link showed a bare URL. Building the
 * block here, with an image every time, means no page can forget it.
 *
 * Image URLs are relative on purpose: `metadataBase` in the root layout turns
 * them into absolute ones, which is what link-preview crawlers require.
 */

export interface SocialImage {
  url: string;
  width: number;
  height: number;
  alt: string;
}

const CARD = { width: 1200, height: 630 } as const;

/** The generated site card (`app/opengraph-image.tsx`). */
export const DEFAULT_SOCIAL_IMAGE: SocialImage = {
  url: "/opengraph-image",
  ...CARD,
  alt: "APEX — Formula 1 season hub",
};

/** The podium and top ten of one race, from the share-card route. */
export function raceResultImage(season: number, round: number, raceName: string): SocialImage {
  return {
    url: `/api/share/race/${season}/${round}?session=race&format=landscape`,
    ...CARD,
    alt: `${season} ${raceName} result`,
  };
}

/** A championship table, from the share-card route. */
export function standingsImage(season: number, kind: "drivers" | "constructors"): SocialImage {
  return {
    url: `/api/share/standings?season=${season}&kind=${kind}&format=landscape`,
    ...CARD,
    alt: `${season} ${kind === "drivers" ? "drivers'" : "constructors'"} championship`,
  };
}

/**
 * A replay's card. Deliberately a different route from `raceResultImage`: a
 * replay link is shared with people who have not seen the race, so its preview
 * carries no result (`app/api/share/watch`).
 */
export function watchImage(season: number, round: number, raceName: string): SocialImage {
  return {
    url: `/api/share/watch/${season}/${round}`,
    ...CARD,
    alt: `${raceName} replay`,
  };
}

/** Concrete rather than Next's `Twitter` union, so `card` is readable by callers. */
export interface SocialTwitter {
  card: "summary_large_image";
  title: string;
  description: string;
  images: string[];
}

export function socialMetadata(opts: {
  title: string;
  description: string;
  path: string;
  image?: SocialImage;
}): {
  openGraph: NonNullable<Metadata["openGraph"]>;
  twitter: SocialTwitter;
} {
  const image = opts.image ?? DEFAULT_SOCIAL_IMAGE;
  return {
    openGraph: {
      type: "website",
      siteName: "APEX",
      title: opts.title,
      description: opts.description,
      url: opts.path,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: [image.url],
    },
  };
}

/**
 * The metadata for a replay page (`/watch/2026-20`).
 *
 * Lives here, not in the page, so the property that matters is testable: a
 * replay link is sent to people who have not seen the race, so it previews with
 * the spoiler-free card and says so, and nothing in it can come from a result.
 *
 * The card route only draws rounds it can name (seasons 2018 to the active one,
 * rounds 1 to 30), and a round that has not run has nothing to preview, so
 * anything else gets the site card rather than an image URL that would 400.
 * The route's own validator decides, so the two cannot drift apart.
 */
export function replayMetadata(opts: {
  season: number;
  round: number;
  raceName: string;
  /** Whether the round has been run (`hasStarted`). */
  started: boolean;
  activeSeason: number;
}) {
  const { season, round, raceName } = opts;
  const title = `${raceName} replay · APEX`;
  const description = `Replay the ${season} ${raceName} lap by lap at the pace it was run. No results shown.`;
  const cardDrawable =
    opts.started &&
    parseWatchParams({ season: String(season), round: String(round) }, new URLSearchParams(), opts.activeSeason).ok;
  return {
    title,
    description,
    ...socialMetadata({
      title,
      description,
      path: `/watch/${season}-${round}`,
      image: cardDrawable ? watchImage(season, round, raceName) : undefined,
    }),
  };
}
