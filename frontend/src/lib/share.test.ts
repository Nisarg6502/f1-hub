import { describe, expect, it } from "vitest";
import {
  availableShareActions,
  parseRaceParams,
  parseRound,
  parseSeason,
  parseShareFormat,
  parseStandingsParams,
  progressionCardPath,
  raceCardPath,
  shareCacheControl,
  shareEventParams,
  shareFilename,
  slugify,
  standingsCardPath,
  SHARE_FORMATS,
} from "./share";

const params = (entries: Record<string, string>) => new URLSearchParams(entries);
const ACTIVE = 2026;

describe("SHARE_FORMATS", () => {
  it("is the Open Graph size and Instagram's 4:5", () => {
    expect(SHARE_FORMATS.landscape).toEqual({ width: 1200, height: 630 });
    expect(SHARE_FORMATS.portrait).toEqual({ width: 1080, height: 1350 });
    expect(SHARE_FORMATS.portrait.width / SHARE_FORMATS.portrait.height).toBe(0.8);
  });
});

describe("parseShareFormat", () => {
  it("defaults a missing format to landscape, so a bare URL is a link preview", () => {
    expect(parseShareFormat(null)).toEqual({ ok: true, value: "landscape" });
    expect(parseShareFormat("")).toEqual({ ok: true, value: "landscape" });
    expect(parseShareFormat(undefined)).toEqual({ ok: true, value: "landscape" });
  });

  it("accepts the two formats exactly", () => {
    expect(parseShareFormat("landscape")).toEqual({ ok: true, value: "landscape" });
    expect(parseShareFormat("portrait")).toEqual({ ok: true, value: "portrait" });
  });

  it.each(["square", "Landscape", "PORTRAIT", " portrait", "1200x630"])("rejects %j", (raw) => {
    expect(parseShareFormat(raw).ok).toBe(false);
  });
});

describe("parseSeason", () => {
  it("defaults to the active season only when the season is optional", () => {
    expect(parseSeason(null, ACTIVE, { required: false })).toEqual({ ok: true, value: ACTIVE });
    expect(parseSeason(null, ACTIVE, { required: true }).ok).toBe(false);
  });

  it("accepts every season from 2018 to the active one", () => {
    expect(parseSeason("2018", ACTIVE, { required: true })).toEqual({ ok: true, value: 2018 });
    expect(parseSeason("2026", ACTIVE, { required: true })).toEqual({ ok: true, value: 2026 });
  });

  it("rejects out-of-range seasons instead of clamping them", () => {
    // The page clamps; an image URL must not answer for a different season
    // than the one it names.
    expect(parseSeason("2017", ACTIVE, { required: true }).ok).toBe(false);
    expect(parseSeason("2027", ACTIVE, { required: true }).ok).toBe(false);
  });

  it.each(["abc", "26", "02026", "2026.0", " 2026", "2026 ", "0x7EA", "2e3", "-2026", "20 26"])(
    "rejects the non-canonical spelling %j",
    (raw) => {
      expect(parseSeason(raw, ACTIVE, { required: true }).ok).toBe(false);
    }
  );
});

describe("parseRound", () => {
  it("accepts 1 to 30", () => {
    expect(parseRound("1")).toEqual({ ok: true, value: 1 });
    expect(parseRound("24")).toEqual({ ok: true, value: 24 });
    expect(parseRound("30")).toEqual({ ok: true, value: 30 });
  });

  it.each(["0", "31", "100", "-1", "1.5", "one", "", "1x", "007"])("rejects %j", (raw) => {
    expect(parseRound(raw).ok).toBe(false);
  });
});

describe("parseStandingsParams", () => {
  it("resolves the bare URL to the active drivers' table in landscape", () => {
    expect(parseStandingsParams(params({}), ACTIVE)).toEqual({
      ok: true,
      value: { season: ACTIVE, kind: "drivers", format: "landscape" },
    });
  });

  it("reads every parameter", () => {
    expect(parseStandingsParams(params({ season: "2018", kind: "constructors", format: "portrait" }), ACTIVE)).toEqual({
      ok: true,
      value: { season: 2018, kind: "constructors", format: "portrait" },
    });
  });

  it("names the parameter that is wrong", () => {
    const bad = parseStandingsParams(params({ kind: "teams" }), ACTIVE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/kind/);
  });

  it("rejects parameters it does not know (cache-busting must not mint new renders)", () => {
    expect(parseStandingsParams(params({ utm_source: "x" }), ACTIVE).ok).toBe(false);
    expect(parseStandingsParams(params({ season: "2026", kind: "drivers", format: "portrait" }), ACTIVE).ok).toBe(true);
  });
});

describe("parseRaceParams", () => {
  it("reads segments and query", () => {
    expect(parseRaceParams({ season: "2026", round: "5" }, params({ session: "sprint", format: "portrait" }), ACTIVE)).toEqual({
      ok: true,
      value: { season: 2026, round: 5, session: "sprint", format: "portrait" },
    });
  });

  it("defaults to the race in landscape", () => {
    expect(parseRaceParams({ season: "2026", round: "5" }, params({}), ACTIVE)).toEqual({
      ok: true,
      value: { season: 2026, round: 5, session: "race", format: "landscape" },
    });
  });

  it("requires the season segment to be valid — it has no default", () => {
    expect(parseRaceParams({ season: "", round: "5" }, params({}), ACTIVE).ok).toBe(false);
  });

  it("rejects a session that is not race or sprint", () => {
    expect(parseRaceParams({ season: "2026", round: "5" }, params({ session: "qualifying" }), ACTIVE).ok).toBe(false);
  });
});

describe("card paths", () => {
  it("round-trip through the parsers", () => {
    const standings = { season: 2025, kind: "constructors", format: "portrait" } as const;
    const url = new URL(standingsCardPath(standings), "http://x");
    expect(url.pathname).toBe("/api/share/standings");
    expect(parseStandingsParams(url.searchParams, ACTIVE)).toEqual({ ok: true, value: standings });

    const progression = new URL(progressionCardPath(standings), "http://x");
    expect(progression.pathname).toBe("/api/share/progression");
    expect(parseStandingsParams(progression.searchParams, ACTIVE)).toEqual({ ok: true, value: standings });

    const race = { season: 2026, round: 12, session: "sprint", format: "landscape" } as const;
    const raceUrl = new URL(raceCardPath(race), "http://x");
    const [, , , , season, round] = raceUrl.pathname.split("/");
    expect(parseRaceParams({ season, round }, raceUrl.searchParams, ACTIVE)).toEqual({ ok: true, value: race });
  });

  it("leaves session off a race URL, so the race card has one canonical address", () => {
    expect(raceCardPath({ season: 2026, round: 1, session: "race", format: "landscape" })).toBe(
      "/api/share/race/2026/1?format=landscape"
    );
  });
});

describe("shareCacheControl", () => {
  it("caches past seasons for a day and the active one for five minutes", () => {
    expect(shareCacheControl(2025, 2026)).toMatch(/max-age=86400/);
    expect(shareCacheControl(2026, 2026)).toMatch(/max-age=300\b/);
  });
});

describe("slugify / shareFilename", () => {
  it("folds diacritics rather than dropping the letter", () => {
    expect(slugify("São Paulo Grand Prix")).toBe("sao-paulo-grand-prix");
    expect(slugify("Nico Hülkenberg")).toBe("nico-hulkenberg");
    expect(slugify("Sergio Pérez")).toBe("sergio-perez");
  });

  it("collapses punctuation and trims separators", () => {
    expect(slugify("  Mercedes-AMG / Petronas!! ")).toBe("mercedes-amg-petronas");
    expect(slugify("---")).toBe("");
  });

  it("caps length without leaving a trailing hyphen", () => {
    const slug = slugify("a ".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("names files apex-<parts>-<format>.png", () => {
    expect(shareFilename(["standings", 2026, "drivers"], "landscape")).toBe(
      "apex-standings-2026-drivers-landscape.png"
    );
    expect(shareFilename(["São Paulo Grand Prix", 2024, "sprint"], "portrait")).toBe(
      "apex-sao-paulo-grand-prix-2024-sprint-portrait.png"
    );
  });

  it("skips empty parts", () => {
    expect(shareFilename(["answer", null, undefined, ""], "portrait")).toBe("apex-answer-portrait.png");
    expect(shareFilename([], "landscape")).toBe("apex-landscape.png");
  });

  it("never produces a character a filesystem would refuse", () => {
    const name = shareFilename(['a<b>c:"d/e\\f|g?h*i'], "landscape");
    expect(name).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe("availableShareActions", () => {
  const none = { canShareFiles: false, canCopyImage: false, canCopyText: false };

  it("always offers Download, the floor everything falls back to", () => {
    expect(availableShareActions(none, { hasLink: false })).toEqual(["download"]);
  });

  it("offers Share only when files can actually be shared", () => {
    expect(availableShareActions({ ...none, canShareFiles: true }, { hasLink: false })[0]).toBe("share");
    expect(availableShareActions(none, { hasLink: true })).not.toContain("share");
  });

  it("offers Copy link only for a card that has a URL", () => {
    const caps = { ...none, canCopyText: true };
    expect(availableShareActions(caps, { hasLink: true })).toContain("copy_link");
    expect(availableShareActions(caps, { hasLink: false })).not.toContain("copy_link");
  });

  it("orders a fully capable browser share, download, copy image, copy link", () => {
    expect(
      availableShareActions({ canShareFiles: true, canCopyImage: true, canCopyText: true }, { hasLink: true })
    ).toEqual(["share", "download", "copy_image", "copy_link"]);
  });
});

describe("shareEventParams", () => {
  it("carries the surface and the action and nothing else", () => {
    expect(shareEventParams("answer", "copy_image")).toEqual({ surface: "answer", action: "copy_image" });
    expect(Object.keys(shareEventParams("race", "download")).sort()).toEqual(["action", "surface"]);
  });
});
