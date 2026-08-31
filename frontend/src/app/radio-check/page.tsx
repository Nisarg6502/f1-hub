"use client";

/**
 * `/radio-check` — the harness for the team-radio popup.
 *
 * Same reasoning as `/visual-check` and `/agent-check`, and the same deliberate
 * unlinked-in-the-tree treatment: "it compiles" is not "it looks right", and the
 * states that matter most here are the ones live data will not produce on
 * demand. An abstained speaker label, a masked expletive, a three-minute open
 * channel that has to truncate, a clip whose transcription failed — each is one
 * click away here, with the backend switched off entirely.
 *
 * It exists for a second reason too. Real captions need a transcription key and
 * a completed job, so without this harness the only way to see the popup at all
 * is to have the whole pipeline running against a session F1 happened to publish
 * radio for. That is a poor loop for a component whose entire job is to look
 * exactly like the broadcast graphic.
 *
 * NOTE for verification: do not drive this through the Claude_Browser preview
 * pane. Its tabs are permanently `document.hidden`, `requestAnimationFrame`
 * never fires there, and anything gated on a frame looks permanently stuck.
 * Real headless Chrome over CDP shows the truth.
 */

import { useState } from "react";
import type { RadioClip } from "@/lib/api";
import RadioPopup from "@/components/radio-popup";

function clip(
  id: string,
  driverNumber: string,
  utterances: RadioClip["utterances"],
  extra: Partial<RadioClip> = {}
): RadioClip {
  return {
    id,
    driver_number: driverNumber,
    date: "2026-08-23T13:34:31.961000+00:00",
    t_ms: 2071961,
    lap: 34,
    duration_s: 9,
    url: "",
    utterances,
    strong_language: false,
    notability: null,
    ...extra,
  };
}

function line(
  speaker: RadioClip["utterances"][number]["speaker"],
  text: string,
  confidence = 0.9
): RadioClip["utterances"][number] {
  return { speaker, text, start: 0, end: 1, confidence };
}

interface Fixture {
  id: string;
  label: string;
  /** What this case is checking, so a reviewer knows what "right" looks like. */
  note: string;
  clip: RadioClip;
  driver: { code: string; name: string; team: string };
}

const FIXTURES: Fixture[] = [
  {
    id: "exchange",
    label: "Driver ↔ pit exchange",
    note: "The common case. Driver lines take the team colour, pit lines stay grey — that split is what separates the voices before the labels are read.",
    clip: clip("f-exchange", "63", [
      line("driver", "The tyres are completely gone, I can't hold him"),
      line("pit", "Understood George, box this lap, box box"),
    ]),
    driver: { code: "RUS", name: "George Russell", team: "Mercedes" },
  },
  {
    id: "pit-only",
    label: "Pit wall only",
    note: "One instruction, no reply. Ferrari red on the edge and the surname.",
    clip: clip("f-pit", "16", [line("pit", "Safety car is in this lap, safety car in this lap")], {
      lap: 41,
      duration_s: 4.1,
    }),
    driver: { code: "LEC", name: "Charles Leclerc", team: "Ferrari" },
  },
  {
    id: "unknown",
    label: "Abstained label",
    note: "The attribution model was not confident, so the line reads RADIO in neutral grey rather than being assigned to anyone. This must never look like a driver line.",
    clip: clip("f-unknown", "4", [line("unknown", "Okay, understood", 0.35)], {
      lap: 18,
      duration_s: 2.8,
    }),
    driver: { code: "NOR", name: "Lando Norris", team: "McLaren" },
  },
  {
    id: "masked",
    label: "Masked language",
    note: "`***` in the caption, and the audio flagged as explicit. The audio itself is unedited — it plays only on a tap.",
    clip: clip(
      "f-masked",
      "1",
      [
        line("driver", "That is *** ridiculous, he pushed me off the track"),
        line("pit", "Copy that, we are looking at it"),
      ],
      { strong_language: true, lap: 52, duration_s: 11.4 }
    ),
    driver: { code: "VER", name: "Max Verstappen", team: "Red Bull" },
  },
  {
    id: "long",
    label: "Truncated open channel",
    note: "The longest clip measured in a 2026 race is 192s against a 9s median. The box caps at three lines and says what it held back rather than ending mid-exchange.",
    clip: clip(
      "f-long",
      "5",
      [
        line("pit", "Okay so we are going to the end on this set"),
        line("driver", "How is the gap behind me"),
        line("pit", "Three seconds and stable, you have got this"),
        line("driver", "Understood"),
        line("pit", "Keep the delta positive through sector two"),
      ],
      { duration_s: 191.9, lap: 68 }
    ),
    driver: { code: "BOR", name: "Gabriel Bortoleto", team: "Audi" },
  },
  {
    id: "no-transcript",
    label: "No transcript",
    note: "Transcription failed or has not run. Still a playable clip — it must not render as an empty box, and it must not claim a speaker.",
    clip: clip("f-none", "44", [], { lap: 7, duration_s: 6.3 }),
    driver: { code: "HAM", name: "Lewis Hamilton", team: "Ferrari" },
  },
  {
    id: "unknown-team",
    label: "Unmapped team",
    note: "A constructor `getTeamColor` does not know falls back to APEX flame rather than to nothing.",
    clip: clip("f-fallback", "99", [line("pit", "Box box box")], { lap: 2, duration_s: 3.0 }),
    driver: { code: "XYZ", name: "Test Driver", team: "Some New Team" },
  },
];

export default function RadioCheckPage() {
  const [activeId, setActiveId] = useState<string>(FIXTURES[0].id);
  const active = FIXTURES.find((fixture) => fixture.id === activeId) ?? FIXTURES[0];

  return (
    <div className="min-h-[100dvh] px-6 py-10">
      <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-2xl">
        Team radio popup — visual check
      </h1>
      <p className="font-medium text-sm text-warm-400 mt-2 max-w-2xl leading-relaxed">
        The popup renders bottom-left, portalled to the body, exactly where it
        does over the watch-mode tower. Pick a case; the note says what to look
        for. The play button is inert here — these fixtures carry no audio URL.
      </p>

      <div className="flex flex-wrap gap-2 mt-6">
        {FIXTURES.map((fixture) => (
          <button
            key={fixture.id}
            type="button"
            onClick={() => setActiveId(fixture.id)}
            className="font-bold text-xs px-4 h-10 rounded-control apex-glass-soft transition-[border-color,color] duration-150"
            style={{
              color: fixture.id === activeId ? "var(--color-primary)" : "var(--color-warm-300)",
              borderColor:
                fixture.id === activeId ? "rgb(var(--rgb-flame-bright) / 0.5)" : undefined,
            }}
          >
            {fixture.label}
          </button>
        ))}
      </div>

      <p className="font-medium text-[13px] text-warm-300 mt-6 max-w-2xl leading-relaxed">
        {active.note}
      </p>

      {/* A stand-in for the timing tower, so the popup is judged over the busy
          surface it actually lands on rather than over an empty page. */}
      <div className="mt-8 rounded-2xl apex-glass-soft p-4 max-w-2xl">
        <p className="font-bold text-[10px] tracking-[0.18em] uppercase text-warm-500">
          Stand-in for the tower
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 font-bold text-xs tabular-nums">
              <span className="text-warm-500 w-5">{index + 1}</span>
              <span className="w-[3px] h-4 rounded-full bg-white/20" />
              <span className="text-warm-200 w-12">DRV</span>
              <span className="text-warm-400">+{(index * 1.37).toFixed(3)}</span>
            </div>
          ))}
        </div>
      </div>

      <RadioPopup clip={active.clip} driver={active.driver} />
    </div>
  );
}
