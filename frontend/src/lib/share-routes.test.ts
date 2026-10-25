import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as standingsGET } from "@/app/api/share/standings/route";
import { GET as raceGET } from "@/app/api/share/race/[season]/[round]/route";
import { GET as progressionGET } from "@/app/api/share/progression/route";
import {
  fixtureDriverStandings,
  fixtureLongConstructorStandings,
  fixtureRace,
  fixtureRaceResultsWithDnf,
  jsonResponse,
  pngSize,
} from "./share-fixtures";

/**
 * The share routes, end to end: request in, PNG out, with the backend
 * replaced by a stubbed `fetch`.
 *
 * What is asserted is the HTTP contract — status codes, `Content-Type`,
 * the PNG's real pixel dimensions read out of its IHDR chunk, cache headers —
 * plus that each synthetic edge case renders at all. What the PNGs *look*
 * like is checked by eye: set `SHARE_GALLERY_DIR` and every rendered card is
 * written there.
 *
 *     SHARE_GALLERY_DIR=/tmp/cards npx vitest run src/lib/share-routes.test.ts
 *
 * The first render in a process loads Satori's WASM and five fonts, so the
 * timeout is generous.
 */

const GALLERY = process.env.SHARE_GALLERY_DIR;

type Handler = (url: URL) => Response | Promise<Response>;

let routes: Record<string, Handler> = {};

function stubBackend(map: Record<string, Handler>) {
  routes = map;
}

beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const handler = routes[url.pathname];
      if (!handler) return jsonResponse({ detail: "not found" }, 404);
      return handler(url);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function req(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://apex.test"));
}

async function expectPng(res: Response, width: number, height: number, galleryName?: string) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect(pngSize(bytes)).toEqual({ width, height });
  expect(Number(res.headers.get("content-length"))).toBe(bytes.byteLength);
  if (GALLERY && galleryName) {
    mkdirSync(GALLERY, { recursive: true });
    writeFileSync(join(GALLERY, `${galleryName}.png`), bytes);
  }
}

const races2026 = [
  fixtureRace(1, "Australian Grand Prix", { winner: true }),
  fixtureRace(2, "Chinese Grand Prix", { sprint: true, winner: true }),
  fixtureRace(3, "Japanese Grand Prix"),
];

describe("GET /api/share/standings", () => {
  it.each([
    ["landscape", 1200, 630],
    ["portrait", 1080, 1350],
  ] as const)("renders drivers' standings as a %s PNG", async (format, w, h) => {
    stubBackend({
      "/api/driverstandings": () => jsonResponse({ driver_standings: fixtureDriverStandings() }),
      "/api/races": () => jsonResponse({ races: races2026 }),
    });
    const res = await standingsGET(req(`/api/share/standings?season=2026&kind=drivers&format=${format}`));
    await expectPng(res, w, h, `fixture-standings-drivers-ties-${format}`);
  }, 60_000);

  it.each(["landscape", "portrait"] as const)("fits long constructor names (%s)", async (format) => {
    stubBackend({
      "/api/constructorstandings": () =>
        jsonResponse({ constructor_standings: fixtureLongConstructorStandings() }),
      "/api/races": () => jsonResponse({ races: races2026 }),
    });
    const res = await standingsGET(req(`/api/share/standings?season=2026&kind=constructors&format=${format}`));
    const size = format === "landscape" ? [1200, 630] : [1080, 1350];
    await expectPng(res, size[0], size[1], `fixture-standings-constructors-long-${format}`);
  }, 60_000);

  it.each(["landscape", "portrait"] as const)(
    "renders an honest empty card for a season with no completed races (%s)",
    async (format) => {
      stubBackend({
        "/api/driverstandings": () => jsonResponse({ driver_standings: [] }),
        "/api/races": () => jsonResponse({ races: [fixtureRace(1, "Australian Grand Prix")] }),
      });
      const res = await standingsGET(req(`/api/share/standings?season=2026&format=${format}`));
      const size = format === "landscape" ? [1200, 630] : [1080, 1350];
      await expectPng(res, size[0], size[1], `fixture-standings-no-races-${format}`);
    },
    60_000
  );

  it("still renders when the calendar fails (only the subtitle depends on it)", async () => {
    stubBackend({
      "/api/driverstandings": () => jsonResponse({ driver_standings: fixtureDriverStandings() }),
      "/api/races": () => jsonResponse({ detail: "boom" }, 500),
    });
    const res = await standingsGET(req("/api/share/standings?season=2026"));
    await expectPng(res, 1200, 630);
  }, 60_000);

  it("answers 503, not 500, when the backend is down", async () => {
    stubBackend({
      "/api/driverstandings": () => jsonResponse({ detail: "down" }, 502),
      "/api/races": () => jsonResponse({ races: races2026 }),
    });
    const res = await standingsGET(req("/api/share/standings?season=2026"));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    "season=abc",
    "season=2017",
    "season=2999",
    "season=2026.0",
    "season=%202026",
    "kind=teams",
    "format=square",
    "format=LANDSCAPE",
  ])("rejects %s with 400 and never calls the backend", async (query) => {
    const res = await standingsGET(req(`/api/share/standings?${query}`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches a past season for a day and the active season for five minutes", async () => {
    stubBackend({
      "/api/driverstandings": () => jsonResponse({ driver_standings: fixtureDriverStandings() }),
      "/api/races": () => jsonResponse({ races: races2026 }),
    });
    const past = await standingsGET(req("/api/share/standings?season=2018"));
    expect(past.headers.get("cache-control")).toContain("max-age=86400");
    const active = new Date().getFullYear();
    const now = await standingsGET(req(`/api/share/standings?season=${active}`));
    expect(now.headers.get("cache-control")).toContain("max-age=300");
  }, 60_000);
});

describe("GET /api/share/race/[season]/[round]", () => {
  const ctx = (season: string, round: string) => ({ params: Promise.resolve({ season, round }) });

  it.each([
    ["landscape", 1200, 630],
    ["portrait", 1080, 1350],
  ] as const)("states a DNF and a DSQ inside the top ten (%s)", async (format, w, h) => {
    stubBackend({
      "/api/races": () => jsonResponse({ races: races2026 }),
      "/api/race_results": () =>
        jsonResponse({ race: races2026[0], results: fixtureRaceResultsWithDnf() }),
    });
    const res = await raceGET(req(`/api/share/race/2026/1?format=${format}`), ctx("2026", "1"));
    await expectPng(res, w, h, `fixture-race-dnf-dsq-${format}`);
  }, 60_000);

  it("renders the sprint when asked for it on a sprint weekend", async () => {
    stubBackend({
      "/api/races": () => jsonResponse({ races: races2026 }),
      "/api/sprint_results": () =>
        jsonResponse({ race: races2026[1], results: fixtureRaceResultsWithDnf().slice(0, 9) }),
    });
    const res = await raceGET(req("/api/share/race/2026/2?session=sprint"), ctx("2026", "2"));
    await expectPng(res, 1200, 630, "fixture-race-sprint-landscape");
  }, 60_000);

  it("answers 404 for a sprint on a weekend that had none", async () => {
    stubBackend({ "/api/races": () => jsonResponse({ races: races2026 }) });
    const res = await raceGET(req("/api/share/race/2026/1?session=sprint"), ctx("2026", "1"));
    expect(res.status).toBe(404);
  });

  it("answers 404 for a round not on the calendar", async () => {
    stubBackend({ "/api/races": () => jsonResponse({ races: races2026 }) });
    const res = await raceGET(req("/api/share/race/2026/9"), ctx("2026", "9"));
    expect(res.status).toBe(404);
  });

  it("answers 404 when the session has rows but no classification", async () => {
    // The real shape of several FastF1-sourced rounds: every driver present,
    // every position empty.
    const unclassified = fixtureRaceResultsWithDnf().map((r) => ({ ...r, position: "", positionText: undefined }));
    stubBackend({
      "/api/races": () => jsonResponse({ races: races2026 }),
      "/api/race_results": () => jsonResponse({ race: races2026[0], results: unclassified }),
    });
    const res = await raceGET(req("/api/share/race/2026/1"), ctx("2026", "1"));
    expect(res.status).toBe(404);
  });

  it("answers 503 when the calendar cannot be fetched", async () => {
    stubBackend({ "/api/races": () => jsonResponse({}, 500) });
    const res = await raceGET(req("/api/share/race/2026/1"), ctx("2026", "1"));
    expect(res.status).toBe(503);
  });

  it.each([
    ["abc", "1", ""],
    ["2026", "0", ""],
    ["2026", "31", ""],
    ["2026", "1x", ""],
    ["2017", "1", ""],
    ["2026", "1", "?session=quali"],
    ["2026", "1", "?format=tall"],
  ])("rejects season=%s round=%s %s with 400", async (season, round, query) => {
    const res = await raceGET(req(`/api/share/race/${season}/${round}${query}`), ctx(season, round));
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/share/progression", () => {
  it.each(["landscape", "portrait"] as const)("draws the drivers' title race (%s)", async (format) => {
    stubBackend({
      "/api/driverstandings": () => jsonResponse({ driver_standings: fixtureDriverStandings() }),
      "/api/races": () => jsonResponse({ races: races2026 }),
      "/api/race_results": (url) =>
        jsonResponse({ race: races2026[Number(url.searchParams.get("round")) - 1], results: fixtureRaceResultsWithDnf() }),
      "/api/sprint_results": () => jsonResponse({ results: fixtureRaceResultsWithDnf().slice(0, 8) }),
    });
    const res = await progressionGET(req(`/api/share/progression?season=2026&format=${format}`));
    const size = format === "landscape" ? [1200, 630] : [1080, 1350];
    await expectPng(res, size[0], size[1], `fixture-progression-drivers-${format}`);
  }, 60_000);

  it("renders an honest empty card before the first race", async () => {
    stubBackend({
      "/api/constructorstandings": () => jsonResponse({ constructor_standings: [] }),
      "/api/races": () => jsonResponse({ races: [fixtureRace(1, "Australian Grand Prix")] }),
    });
    const res = await progressionGET(req("/api/share/progression?season=2026&kind=constructors"));
    await expectPng(res, 1200, 630, "fixture-progression-empty-landscape");
  }, 60_000);

  it("rejects a bad kind with 400", async () => {
    const res = await progressionGET(req("/api/share/progression?kind=both"));
    expect(res.status).toBe(400);
  });
});
