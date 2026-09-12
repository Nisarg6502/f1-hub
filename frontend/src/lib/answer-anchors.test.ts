import { describe, expect, it } from "vitest";
import { buildAnchoredMarkdown } from "./answer-anchors";

/**
 * Marker stripping is the one transformation every answer goes through, and
 * its whitespace rules are easy to get subtly wrong in both directions: eat
 * too little and the prose shows `"the McLaren team ."`, eat too much and two
 * words fuse into `"wonand"`.
 */
const plain = (draft: string) => buildAnchoredMarkdown(draft, [], "m1").plainText;

describe("citation marker stripping", () => {
  it("removes a marker and the space that introduced it", () => {
    expect(plain("Russell won [ev_1].")).toBe("Russell won.");
  });

  it("removes a space the model left stranded before a full stop", () => {
    // The production case: the draft carried a space on BOTH sides of the
    // marker, so stripping only the leading one left " ." behind.
    expect(plain("driving for the McLaren team [ev_3] .")).toBe(
      "driving for the McLaren team."
    );
  });

  it("does the same before a comma, semicolon and closing bracket", () => {
    expect(plain("He won [ev_1] , then retired.")).toBe("He won, then retired.");
    expect(plain("He won [ev_1] ; then retired.")).toBe("He won; then retired.");
    expect(plain("(He won [ev_1] )")).toBe("(He won)");
  });

  it("keeps the space that separates two words", () => {
    // The opposite failure, and the more damaging one — this must not become
    // "won and" losing its space, nor "wonand".
    expect(plain("Russell won [ev_1] and set the fastest lap.")).toBe(
      "Russell won and set the fastest lap."
    );
  });

  it("substitutes a space when the marker itself was the separator", () => {
    // A real production draft: no space either side of a full-width marker.
    expect(plain("Russell won【ev_2】and set the fastest lap.")).toBe(
      "Russell won and set the fastest lap."
    );
  });

  it("handles every bracket variant the backend can emit", () => {
    expect(plain("A [ev_1] .")).toBe("A.");
    expect(plain("A 【ev_1】 .")).toBe("A.");
    expect(plain("A ［ev_1］ .")).toBe("A.");
  });

  it("leaves a newline before a marker alone", () => {
    // Structural whitespace: removing it would join two blocks.
    expect(plain("- First\n- Second [ev_1].")).toBe("- First\n- Second.");
  });

  it("leaves prose with no markers untouched", () => {
    expect(plain("Norris won the Dutch Grand Prix.")).toBe(
      "Norris won the Dutch Grand Prix."
    );
  });
});
