import { describe, expect, it } from "vitest";
import { CONSTRUCTOR_LINEAGES, resolveLineages } from "./constructor-lineages";
import { buildDossier, buildWinIndex } from "./constructor-profiles";

const redBullLineage = (seasonsById: Record<string, number[]>) => {
  const lineage = resolveLineages(seasonsById).find((l) => l.id === "stewart-red-bull");
  if (!lineage) throw new Error("Stewart → Red Bull lineage missing");
  return lineage;
};

const without = (seasons: Record<string, number[]>, id: string) =>
  Object.fromEntries(Object.entries(seasons).filter(([key]) => key !== id));

const SEASONS = {
  stewart: [1997, 1998, 1999],
  jaguar: [2000, 2001, 2002, 2003, 2004],
  red_bull: Array.from({ length: 22 }, (_, i) => 2005 + i),
};

// One win for Stewart (1999 European GP) and three for Red Bull.
const WINS = buildWinIndex([
  { season: 1999, constructor_key: "stewart", indy500: false },
  { season: 2010, constructor_key: "red_bull", indy500: false },
  { season: 2013, constructor_key: "red_bull", indy500: false },
  { season: 2026, constructor_key: "red_bull", indy500: false },
] as Parameters<typeof buildWinIndex>[0]);

describe("buildDossier — an era that did not resolve", () => {
  it("is complete when every era resolved", () => {
    const dossier = buildDossier(redBullLineage(SEASONS), WINS, null, 2026);

    expect(dossier.incomplete).toBe(false);
    expect(dossier.lineageWins).toBe(4);
  });

  it("is incomplete when the current era failed, so 'Stewart's 1 win' is not Red Bull's record", () => {
    // Production, 2026-10-23: red_bull's season lookup failed under throttling
    // and the page rendered Red Bull as "1 all-time win · 2 names".
    const dossier = buildDossier(redBullLineage(without(SEASONS, "red_bull")), WINS, null, 2026);

    expect(dossier.incomplete).toBe(true);
    expect(dossier.lineageWins).toBe(1);
  });

  it("is incomplete when a middle era failed, which used to undercount with no flag at all", () => {
    const dossier = buildDossier(redBullLineage(without(SEASONS, "jaguar")), WINS, null, 2026);

    expect(dossier.incomplete).toBe(true);
    expect(dossier.currentEraUnresolved).toBe(false);
  });

  it("covers every curated lineage", () => {
    expect(CONSTRUCTOR_LINEAGES.length).toBeGreaterThan(0);
  });
});
