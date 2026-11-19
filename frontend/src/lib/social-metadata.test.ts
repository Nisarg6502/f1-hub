import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOCIAL_IMAGE,
  raceResultImage,
  socialMetadata,
  standingsImage,
  watchImage,
} from "./social-metadata";

describe("images", () => {
  it("the default is the generated site card", () => {
    expect(DEFAULT_SOCIAL_IMAGE).toEqual({
      url: "/opengraph-image",
      width: 1200,
      height: 630,
      alt: "APEX — Formula 1 season hub",
    });
  });

  it("a race result image points at the landscape share card for the race session", () => {
    expect(raceResultImage(2026, 20, "Brazilian Grand Prix")).toEqual({
      url: "/api/share/race/2026/20?session=race&format=landscape",
      width: 1200,
      height: 630,
      alt: "2026 Brazilian Grand Prix result",
    });
  });

  it("a standings image names the right table", () => {
    expect(standingsImage(2026, "drivers")).toEqual({
      url: "/api/share/standings?season=2026&kind=drivers&format=landscape",
      width: 1200,
      height: 630,
      alt: "2026 drivers' championship",
    });
    expect(standingsImage(2026, "constructors")).toMatchObject({
      url: "/api/share/standings?season=2026&kind=constructors&format=landscape",
      alt: "2026 constructors' championship",
    });
  });

  it("a watch image points at the spoiler-free replay card", () => {
    expect(watchImage(2026, 20, "Brazilian Grand Prix")).toEqual({
      url: "/api/share/watch/2026/20",
      width: 1200,
      height: 630,
      alt: "Brazilian Grand Prix replay",
    });
  });
});

describe("socialMetadata", () => {
  const base = { title: "T", description: "D", path: "/standings" };

  it("falls back to the default image", () => {
    const { openGraph, twitter } = socialMetadata(base);

    expect(openGraph).toMatchObject({
      type: "website",
      siteName: "APEX",
      title: "T",
      description: "D",
      url: "/standings",
      images: [DEFAULT_SOCIAL_IMAGE],
    });
    expect(twitter).toMatchObject({
      card: "summary_large_image",
      title: "T",
      description: "D",
      images: ["/opengraph-image"],
    });
  });

  it("uses the image it is given, in both blocks", () => {
    const image = raceResultImage(2026, 20, "Brazilian Grand Prix");

    const { openGraph, twitter } = socialMetadata({ ...base, image });

    expect(openGraph.images).toEqual([image]);
    expect(twitter.images).toEqual([image.url]);
  });

  it("always asks for the large summary card", () => {
    expect(socialMetadata(base).twitter.card).toBe("summary_large_image");
  });
});
