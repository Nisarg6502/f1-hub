import { describe, expect, it } from "vitest";
import type { RadioClip } from "./api";
import {
  FIRE_WINDOW_MS,
  MAX_DWELL_MS,
  MAX_QUEUE_WAIT_MS,
  MIN_DWELL_MS,
  advanceRadio,
  createRadioState,
  dwellFor,
  formatClipDuration,
  popupLines,
  schedulableClips,
} from "./watch-radio";

function clip(id: string, tMs: number | null, words = 4, extra: Partial<RadioClip> = {}): RadioClip {
  return {
    id,
    driver_number: "63",
    date: "2026-08-23T13:34:31.961000+00:00",
    t_ms: tMs,
    lap: 34,
    duration_s: 9,
    url: "https://livetiming.formula1.com/a.mp3",
    utterances: [
      {
        speaker: "driver",
        text: Array.from({ length: words }, () => "word").join(" "),
        start: 0,
        end: 1,
        confidence: 0.9,
      },
    ],
    strong_language: false,
    notability: null,
    ...extra,
  };
}

const PLAYING = { playing: true, enabled: true };

describe("schedulableClips", () => {
  it("keeps only placed clips inside the race", () => {
    const kept = schedulableClips([clip("a", 1000), clip("b", null), clip("c", -5000)]);

    expect(kept.map((c) => c.id)).toEqual(["a"]);
  });

  it("drops clips with no caption rather than rendering an empty box", () => {
    const silent = clip("a", 1000);
    silent.utterances = [];

    expect(schedulableClips([silent])).toEqual([]);
  });

  it("sorts by elapsed time so the scheduler can stop at the first future clip", () => {
    const sorted = schedulableClips([clip("b", 9000), clip("a", 1000)]);

    expect(sorted.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("dwellFor", () => {
  it("gives a long message more time than a short one", () => {
    expect(dwellFor(clip("a", 0, 20))).toBeGreaterThan(dwellFor(clip("b", 0, 3)));
  });

  it("never drops below the readable floor", () => {
    expect(dwellFor(clip("a", 0, 1))).toBe(MIN_DWELL_MS);
  });

  it("never camps on the tower, however long the clip", () => {
    expect(dwellFor(clip("a", 0, 500))).toBe(MAX_DWELL_MS);
  });
});

describe("advanceRadio — firing", () => {
  it("fires a clip when the playhead reaches its instant", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000)];

    expect(advanceRadio(state, clips, 9_000, PLAYING)).toBeNull();
    expect(advanceRadio(state, clips, 10_100, PLAYING)?.clip.id).toBe("a");
  });

  it("never shows a clip from the future", () => {
    const state = createRadioState();

    expect(advanceRadio(state, [clip("a", 60_000)], 10_000, PLAYING)).toBeNull();
  });

  it("does not fire a clip the viewer scrubbed past", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000), clip("b", 20_000), clip("c", 600_000)];

    // Jump straight to ten minutes: a and b are behind the fire window.
    const cue = advanceRadio(state, clips, 600_000, PLAYING);

    expect(cue?.clip.id).toBe("c");
  });

  it("fires nothing at all while paused", () => {
    const state = createRadioState();

    const cue = advanceRadio(state, [clip("a", 10_000)], 10_100, {
      playing: false,
      enabled: true,
    });

    expect(cue).toBeNull();
  });

  it("does not repeat a clip when the clock jitters around its instant", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000)];

    advanceRadio(state, clips, 10_100, PLAYING);
    advanceRadio(state, clips, 10_050, PLAYING);
    const cue = advanceRadio(state, clips, 10_200, PLAYING);

    expect(cue?.clip.id).toBe("a");
    expect(state.queue).toHaveLength(0);
  });

  it("tolerates a frame gap up to the fire window", () => {
    const state = createRadioState();

    const cue = advanceRadio(state, [clip("a", 10_000)], 10_000 + FIRE_WINDOW_MS - 1, PLAYING);

    expect(cue?.clip.id).toBe("a");
  });
});

describe("advanceRadio — queueing", () => {
  it("shows one box at a time and queues the rest", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3), clip("b", 10_500, 3)];

    const cue = advanceRadio(state, clips, 10_600, PLAYING);

    expect(cue?.clip.id).toBe("a");
    expect(state.queue.map((c) => c.id)).toEqual(["b"]);
  });

  it("promotes the queued clip once the first has had its dwell", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3), clip("b", 10_500, 3)];

    advanceRadio(state, clips, 10_600, PLAYING);
    const cue = advanceRadio(state, clips, 10_600 + MIN_DWELL_MS + 1, PLAYING);

    expect(cue?.clip.id).toBe("b");
  });

  it("abandons a clip that waited too long rather than showing it out of context", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3), clip("b", 10_500, 3)];

    advanceRadio(state, clips, 10_600, PLAYING);
    const cue = advanceRadio(state, clips, 10_600 + MAX_QUEUE_WAIT_MS + 1_000, PLAYING);

    expect(cue).toBeNull();
    expect(state.queue).toHaveLength(0);
  });

  it("clears the box once its dwell expires", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3)];

    advanceRadio(state, clips, 10_000, PLAYING);
    const cue = advanceRadio(state, clips, 10_000 + MAX_DWELL_MS + 1, PLAYING);

    expect(cue).toBeNull();
  });
});

describe("advanceRadio — scrubbing", () => {
  it("re-arms clips after the playhead when the viewer rewinds", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3)];

    advanceRadio(state, clips, 10_100, PLAYING);
    advanceRadio(state, clips, 10_100 + MAX_DWELL_MS + 1, PLAYING);
    advanceRadio(state, clips, 5_000, PLAYING); // rewind
    const cue = advanceRadio(state, clips, 10_100, PLAYING);

    expect(cue?.clip.id).toBe("a");
  });

  it("leaves clips before the new position alone when rewinding", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3), clip("b", 60_000, 3)];

    advanceRadio(state, clips, 10_100, PLAYING);
    advanceRadio(state, clips, 30_000, PLAYING); // rewind past b but after a

    expect(state.fired.has("a")).toBe(true);
  });
});

describe("advanceRadio — disabled", () => {
  it("shows nothing and drops the queue when captions are turned off", () => {
    const state = createRadioState();
    const clips = [clip("a", 10_000, 3), clip("b", 10_500, 3)];

    advanceRadio(state, clips, 10_600, PLAYING);
    const cue = advanceRadio(state, clips, 10_700, { playing: true, enabled: false });

    expect(cue).toBeNull();
    expect(state.queue).toHaveLength(0);
  });
});

describe("popupLines", () => {
  it("caps a long exchange and reports what it held back", () => {
    const long = clip("a", 0);
    long.utterances = Array.from({ length: 7 }, (_, index) => ({
      speaker: "driver" as const,
      text: `line ${index}`,
      start: index,
      end: index + 1,
      confidence: 0.9,
    }));

    const { lines, truncated } = popupLines(long);

    expect(lines).toHaveLength(3);
    expect(truncated).toBe(4);
  });

  it("reports nothing truncated for a short clip", () => {
    expect(popupLines(clip("a", 0)).truncated).toBe(0);
  });
});

describe("formatClipDuration", () => {
  it("formats seconds as m:ss", () => {
    expect(formatClipDuration(9.2)).toBe("0:09");
    expect(formatClipDuration(191.9)).toBe("3:12");
  });

  it("renders an unmeasured clip as a dash rather than as zero", () => {
    expect(formatClipDuration(null)).toBe("—");
    expect(formatClipDuration(undefined)).toBe("—");
  });
});
