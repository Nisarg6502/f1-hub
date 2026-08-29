# Team Radio — implementation plan

Written 2026-08-29. **Supersedes the 2026-08-24 research pass in this file**,
which was directionally right but wrong on three loadbearing facts: it treated
one session's 31 clips as representative without checking coverage, it did not
know the 2026 season has a hard publication cutoff at the Canadian GP, and it
assumed the audio could be analysed in the browser (it cannot — no CORS header).

The companion doc `TEAM-RADIO-EXPLAINER.md` is the same feature in plain English.
This one is the build instructions.

---

## 0. Status — Phase 1, as built 2026-08-29

Everything below is written, unit-tested and verified against real data except
the transcription run itself, which is blocked on one free API key.

**Shipped and verified**

| Piece | State |
|---|---|
| `app/radio_clips.py` + tests | 19 tests. Verified live: 31 clips for the 2026 Dutch GP, `source=openf1`; the 2026 Australian GP correctly resolves to "F1 published none" through *both* sources. |
| `app/radio_profanity.py` + tests | 18 tests, including the Scunthorpe set and idempotence under a second pass. |
| `app/race_radio.py` + `/api/race_radio` + tests | 28 tests. Serve-only, `text_raw` excluded at the query. |
| `app/radio_transcribe.py` | Groq seam, glossary prompt budgeted to Whisper's 224-token cap. **Needs `GROQ_API_KEY`.** |
| `app/radio_attribution.py` + tests | 21 tests. All three approaches. Verified against real transcripts — see below. |
| `scripts/sync_race_radio.py` | Four independently-versioned stages. `--stage ingest` run for real. |
| `lib/watch-radio.ts` + tests | 23 tests covering every scheduling rule. |
| `components/radio-popup.tsx` | Verified in headless Chrome across seven states via `/radio-check`. |
| `watch-view.tsx` / watch page wiring | Frame-loop hook, preference toggle, `Promise.allSettled` fetch. Typechecks and lints clean; full suite 1,360 backend + 55 frontend tests pass. |

**Blocked on one key.** Transcription needs `GROQ_API_KEY` (free tier at
console.groq.com covers a full backfill). Set it and run:

```
python -m scripts.sync_race_radio --round 12 --stage asr,attrib,mask
```

**Two things the build found that the research did not.**

* **`lap_ms` is per-lap DURATIONS, not cumulative instants**, and misreading it
  fails silently — every value is smaller than any mid-race timestamp, so a
  bisect returns the final lap for every clip and the payload still looks
  plausible. Caught on real data: a clip 3 minutes into the Dutch GP reported
  lap 72 of 72. `race_radio.lap_boundaries` now converts, with a test carrying
  the real numbers.
* **Ollama Cloud does not enforce the `format` JSON Schema.** Passing a schema
  to `gpt-oss:120b` returned valid JSON in a shape of the model's own invention.
  The output shape now lives in the system prompt, the schema is sent but not
  depended on, and `_chat` tolerates a bare array.

**The attribution approaches, measured on real transcripts** (12 utterances
from the CC BY 4.0 corpus, run through the real Ollama key — indicative, not the
eval set of §5.4):

* `transcript_llm` labelled all 12 correctly, including abstaining on
  "Okay, understood" inside an exchange it otherwise split correctly into
  pit → driver → unknown.
* `keyword` abstained on 11 of 12, labelling only "Box, Brendan, box, box".

So approach A is comfortably ahead of the baseline on this sample. That is
*not* the bake-off — §5.4's hand-labelled set and §5.5's decision rule still
have to run, and B1 has not been built yet.

---

## 1. Measured facts this plan is built on

Every number here came from hitting the live APIs on 2026-08-29. Re-derive with
the commands in §11 before trusting any of it in six months.

### 1.1 The data has three fields and no more

`GET https://api.openf1.org/v1/team_radio?session_key=11353` returns:

```json
{
  "meeting_key": 1292,
  "session_key": 11353,
  "driver_number": 63,
  "date": "2026-08-23T13:34:31.961000+00:00",
  "recording_url": "https://livetiming.formula1.com/static/2026/2026-08-23_Dutch_Grand_Prix/2026-08-23_Race/TeamRadio/RUS_63_20260823_153426.mp3"
}
```

**This was checked at the origin, not just at the wrapper.** F1's own
`https://livetiming.formula1.com/static/<meeting>/<session>/TeamRadio.json`
carries `{"Captures":[{"Utc","RacingNumber","Path"}]}` and nothing else. OpenF1
adds no field and hides no field.

Consequences, stated once so nothing downstream re-litigates them:

- **There is no speaker direction anywhere.** Driver-vs-pit-wall must be
  inferred. See §5.
- **There is no transcript.** Captions, `***` masking and notability ranking are
  all downstream of an ASR step that does not exist yet.
- **There is no topic or importance tag.** A driver saying "copy" and a driver
  reporting a puncture are the same shape of row.
- The filename's TLA prefix (`RUS_63_…`) is a driver code, not a speaker label.

### 1.2 Coverage — 2026 is a cutoff, not a decay

Verified per session with a 404-vs-200 check and retries:

| Session | Clips | | Session | Clips |
|---|---|---|---|---|
| AUS, CHN(S+R), JPN, BHR, SAU, USA(S+R) | **0** | | Britain Sprint / Race | 4 / 20 |
| Canada Sprint / Race | 13 / 33 | | Belgium | 29 |
| Monaco | 36 | | Hungary | 36 |
| Spain | 40 | | Netherlands Sprint / Race | 6 / 31 |
| Austria | 23 | | **2026 race+sprint total** | **271** |

**Nothing before 2026-05-23 (Canada); everything from Canada onward.** OpenF1's
docs currently claim "most 2026 events provide no radio data" — that is stale and
should not be quoted in code comments.

Season shape: 2023 ≈ 112 clips/race (22 of 29 sessions), 2024 ≈ 102 (29 of 30),
2025 ≈ 28 (29 of 30), 2026 ≈ 30 on the covered half.

**OpenF1 rate-limits hard enough to produce false negatives.** A naive sequential
scan reported the British GP as having zero clips; the same session returned 20 on
retry. Any coverage tooling must distinguish HTTP 404 (genuinely absent) from a
transport error, and must back off. This is the single easiest way to write a
confidently wrong number into a doc.

### 1.3 Volume, per driver and per clip

- Per session: **median 2 clips per driver**, mean 2.5, max 10. Only 9–14 of 20
  drivers appear at all in a given race.
- Clip duration at Zandvoort 2026 (n=31): min 2.8s, p25 6.9s, **median 9.2s**,
  p75 12.7s, max **191.9s** (car #5, near race end — an open channel, not a
  transmission). 4 clips under 5s, 20 between 5–15s, 7 over 15s.
- **Total audio in a full race: 8.5 minutes.** This is what makes the AI cost
  round to zero.

### 1.4 Duration is free

The MP3s are 128 kbps CBR (`ffprobe`: `duration=8.976`, `bit_rate=128342` on a
144,000-byte file). So:

```
duration_seconds ≈ Content-Length / 16000
```

from a `HEAD` request, with no download. Used as a triage signal and to size the
popup's dwell time. Verify the bitrate assumption once per season rather than
trusting it forever.

### 1.5 The CDN sends no CORS header

`Vary: Origin` is present; `Access-Control-Allow-Origin` is **not**. Therefore:

- `<audio src="https://livetiming...">` **works** — media elements play
  cross-origin without CORS.
- `crossorigin="anonymous"`, `AudioContext.createMediaElementSource`,
  `decodeAudioData` and `fetch()` **all fail**.

**So: playback yes, real waveform no.** A genuine waveform needs the file proxied
through our own origin. A CSS-animated bar cluster that merely looks alive costs
nothing and is what v1 ships. Do not write code that assumes it can read the
audio buffer.

### 1.6 A free, licensed transcript corpus exists

`MikCil/f1-team-radio` on Hugging Face: 14,681 clips, 149 Grands Prix,
2018-03-25 → 2025-12-07, fields `id, driver_id, racing_number, grand_prix,
race_id, session_date, message_timestamp, audio, transcription`. **CC BY 4.0** —
usable commercially with attribution. **No speaker labels.**

Two uses: instant historical backfill, and a large held-out set for scoring the
attribution work in §5. Attribution goes on the existing `/attributions` page.

---

## 2. Architecture

```
                    ┌─────────────────────────── Cloud Run Job (offline) ───┐
OpenF1 /team_radio ─┤                                                        │
  (fallback:        │  radio_clips.ingest   → clip rows + duration (HEAD)    │
   livetiming       │  radio_transcribe     → Groq whisper-large-v3-turbo    │
   TeamRadio.json)  │  radio_attribution    → utterances + speaker roles     │
                    │  radio_profanity      → text_masked, strong_language   │
                    │  radio_notability     → score + reasons (rule-based)   │
                    └────────────────────────────┬───────────────────────────┘
                                                 ▼
                                     Mongo  `race_radio`  (one doc per session)
                                                 │
                            f1-backend  GET /api/race_radio   (serve-only)
                                                 │
                     ┌───────────────────────────┼────────────────────────┐
                     ▼                           ▼                        ▼
              watch-view popup           Pitwall "Radio" module     agent radio tool
              (Phase 1)                       (Phase 2)                (Phase 3)
```

**Three rules that follow from the codebase's existing discipline:**

1. **Transcribe once, ever.** Same argument as `session_recap.py`'s "generate
   once, cache forever, keyed by prompt version". No page load ever calls Groq.
2. **The endpoint serves; the job fills.** `/api/race_radio` reads Mongo and
   returns `synced: false` when a session has not been processed, exactly as
   `race_replay` does. It deliberately does **not** self-heal, because
   self-healing here means an inference bill on a cold page view.
3. **The agent service must never import this module.** `race_timing` imports
   `race_laps` imports `fastf1`, and `requirements-agent.txt` deliberately omits
   FastF1 so a FastF1 call is impossible rather than merely forbidden (see
   `backend/app/driver_directory.py`'s docstring). The Phase 3 chat tool reads
   the cached Mongo document directly, never the builder.

---

## 3. Data model

One document per session in a new `race_radio` collection. A full race is ~31
clips of short text — a few tens of KB, nothing like `race_timing`'s 490 KB.

```jsonc
{
  "_id": "...",
  "session_key": 11353,
  "meeting_key": 1292,
  "year": 2026, "round": 15, "session_type": "Race",
  "race_start": "2026-08-23T13:00:12.345000+00:00",  // the anchor used for t_ms
  "radio_version": 1,      // payload shape
  "asr_version": 1,        // model + prompt + params
  "attrib_version": 1,     // approach + prompt
  "mask_version": 1,       // profanity word list revision
  "synced": true,
  "source": "openf1",      // or "livetiming" when the fallback was used
  "clips": [
    {
      "id": "11353-63-20260823T133431961",   // stable: session-driver-timestamp
      "driver_number": 63,
      "date": "2026-08-23T13:34:31.961000+00:00",
      "t_ms": 2059616,          // elapsed race ms — what watch mode indexes on
      "lap": 34,                // best-effort, from race_timing lap boundaries
      "duration_s": 3.9,
      "url": "https://livetiming.formula1.com/.../RUS_63_20260823_153426.mp3",
      "transcript": {
        "engine": "groq/whisper-large-v3-turbo",
        "language": "en",
        "utterances": [
          { "speaker": "driver", "confidence": 0.88,
            "start": 0.0, "end": 2.4,
            "text_raw": "...", "text_masked": "..." },
          { "speaker": "pit",    "confidence": 0.93,
            "start": 2.6, "end": 3.9,
            "text_raw": "...", "text_masked": "..." }
        ]
      },
      "flags": { "strong_language": true, "overlong": false, "low_confidence": false },
      "notability": { "score": 0.72, "reasons": ["pit_stop_within_30s", "duration_p90"] }
    }
  ]
}
```

**Field notes that are decisions, not description:**

- `speaker` is one of `"driver" | "pit" | "unknown"`. **`"unknown"` is a
  first-class value, not a failure**, and the UI must render it (as a neutral
  `RADIO` label) rather than treating it as missing. A confidently wrong speaker
  label is worse than an honest abstention — that is the whole reason the field
  carries `confidence` alongside it.
- `text_raw` is stored and **never served**. It exists because the attribution
  model and any future re-masking need the unmasked text, and re-fetching plus
  re-transcribing to recover it would be absurd. The endpoint projects it out at
  the query, not in application code, so a new caller cannot leak it by
  forgetting.
- Four independent version keys, not one. Re-masking after a word-list change
  must not force re-transcription; re-running attribution after a prompt change
  must not either. Each stage checks only its own version.
- `t_ms` is precomputed server-side. The frontend must never see a raw wall-clock
  timestamp and try to place it itself — see §4.

---

## 4. Placing a clip on the replay clock

**This is already solved and the work is to not re-solve it.**

`backend/app/race_timing.py` computes the wall-clock instant of lights out in
order to place OpenF1's `/position` and `/intervals` samples on the replay's
elapsed-ms timeline. Radio timestamps are the same kind of quantity from the same
source, so they go through the same conversion:

```python
t_ms = _elapsed_ms(_parse_iso(clip["date"]), race_start)
```

Getting `race_start`, in order of preference:

1. **Read it off the cached `race_timing` document.** It is not currently
   persisted, so: add `race_start` (ISO string) to the payload `build_timing`
   returns. **Do not bump `TIMING_VERSION` for this.** Consumers must tolerate its
   absence anyway — a document cached before this change simply won't have it,
   which is the identical situation `lap_time_seconds` documented for
   `ReplayRunner` — and bumping would retire eleven ~490 KB payloads to add one
   string.
2. **Fall back to `stated_race_start(lap_rows)`** from a single OpenF1 `/laps`
   fetch. Its docstring records that this instant equals race control's
   `SESSION STARTED` to the millisecond on all eleven synced 2026 rounds. The
   refinement in `race_start_offset` exists only to absorb OpenF1's 0.42–0.77s
   boundary-stamping bias, which is **irrelevant to a caption that sits on screen
   for six seconds.** Do not fetch the official archive just for this.
3. If both are unavailable, store the clips with `t_ms: null` and `synced: true`.
   Watch mode drops null-`t_ms` clips; the Pitwall module still lists them by
   wall-clock. A session that cannot be placed is not a session that must be
   hidden.

**Round 1 caveat, recorded so nobody rediscovers it:** `race_start_offset`'s
docstring documents an 84s systematic error on the 2026 Australian GP caused by a
missing lap boundary in OpenF1's `/laps`. Australia has **zero** radio clips, so
this cannot bite the radio feature — but do not copy the fallback logic to a
consumer where it could.

`lap` is best-effort: bisect `t_ms` into the `lap_ms` array the timing payload
already carries. It is used for the popup's `LAP 34` chip only. When timing is
absent, omit it rather than guessing — the popup renders without the chip.

---

## 5. The attribution bake-off

Two approaches get built and scored against a hand-labelled set. A third, a
zero-AI keyword baseline, gets built too — cheap, and if the models cannot beat
it we have learned something important about whether the LLM earns its cost.

### 5.1 Approach A — transcript-only (LLM infers role from wording)

1. Groq `whisper-large-v3-turbo`, `response_format=verbose_json`,
   `timestamp_granularities=["segment","word"]`, with a **domain prompt** listing
   the season's driver surnames, team names and F1 vocabulary (`box`, `undercut`,
   `delta`, `DRS`, `plank`, `graining`, compound names). Whisper's `prompt`
   parameter measurably improves proper nouns on noisy audio, and "Verstappen" →
   "for stopping" is the failure to design against.
2. One call to the existing Ollama seam (`backend/agent/model.py`,
   `gpt-oss:120b`, near-greedy temperature) per clip, returning structured JSON:
   utterance spans with `speaker` ∈ {driver, pit, unknown} and a confidence.
3. Prompt discipline follows `session_recap.py`'s rule — the model is given the
   driver's name and team as *facts*, never asked to infer them, and is
   explicitly instructed that `unknown` is the correct answer when the wording is
   neutral ("copy", "understood", "okay").

**Cost:** one ASR call + one small LLM call per clip. **Ops:** zero new services.

### 5.2 Approach B — acoustic diarization first, then role assignment

Build **B1** for the bake-off, not B2:

- **B1 (hosted).** A diarizing ASR API — Deepgram Nova with `diarize=true`, or
  AssemblyAI — returns speaker-tagged turns in one call. Then **one** LLM call per
  clip decides which speaker index is the driver, rather than one decision per
  line.
- **B2 (self-hosted).** `whisperX` / `pyannote-audio 3.1` in a Cloud Run Job.

**B1 is the right thing to bake off because it isolates the question.** What we
want to know is whether acoustic speaker separation helps *at all* on this audio.
B2 answers the same question while also making us operate a GPU-shaped job, and
if the answer turns out to be "no", we will have built that for nothing. If B1
wins decisively and the per-call cost later matters, port to B2 then.

**The structural advantage to test:** B makes turn boundaries an acoustic
measurement rather than an LLM's guess, and reduces role assignment from N
per-line decisions to one per clip. **The structural risk:** F1 radio is
band-limited, heavily compressed, clipped, and often has engine noise and helmet
muffle over the driver's voice — the conditions diarization is worst at. It may
also merge two voices or split one.

### 5.3 Approach C — keyword baseline (no AI)

A scored word list: `box`/`box box`/`we are checking`/`stay out`/`target
plus`/`push now`/driver-first-name-vocative → pit; `I've got`/`the tyres are`/
`he's`/`what is he doing`/`no grip`/expletives → driver. Sentence-split on
punctuation from the ASR segments.

Included because the codebase's stated discipline is "compute the facts in code,
never trust the model to infer them", and because a baseline is the only way to
know whether the LLM is adding value or laundering it.

### 5.4 The evaluation set

**40 clips, ~150 utterances, hand-labelled by listening.** Stratified so the set
cannot flatter any approach:

- Duration: 10 short (<5s), 20 medium (5–15s), 10 long (>15s). Short clips are
  where A is weakest; long clips are where B should shine.
- ≥6 different sessions, ≥10 different drivers, both a calm race and a chaotic
  one. Include at least 5 clips from 2023 (noisier, richer, different production).
- Include the pathological cases deliberately: the 192s Zandvoort open channel, a
  clip that is pure "copy", a clip with crosstalk.

Ground truth stored as `backend/tests/fixtures/radio_attribution_eval.json`:
clip id, hand transcript, and per-utterance `{start, end, speaker}`. Label by
listening; RaceFans' published human transcripts are a reasonable second opinion
to check yourself against, but are **not** to be scraped into the fixture.

### 5.5 Metrics and the decision rule

Run by `backend/scripts/eval_radio_attribution.py`, printing a table:

| Metric | Why it's here |
|---|---|
| **Utterance role accuracy** | Primary. Of the utterances we labelled `driver`/`pit`, what fraction match ground truth. |
| **Clip-level exact match** | Every utterance in the clip right. This is what the user actually perceives. |
| **Abstention rate** | Fraction answered `unknown`. A model that abstains on everything scores 100% on accuracy and is useless. |
| **Turn-boundary F1** | Did we split the clip in the right places (±0.3s)? B should dominate; if it doesn't, B has no reason to exist. |
| **WER** | Shared across approaches, but B1 uses a different ASR — so it must be reported or a transcription regression could masquerade as an attribution win. |
| **Cost per clip, p50/p95 latency** | The tiebreaker. |

**Decision rule, written down before running it so the result cannot be
rationalised afterwards:**

> Adopt B only if it beats A by **≥8 points on utterance role accuracy** *and*
> **≥10 points on clip-level exact match**, at a comparable abstention rate
> (within 5 points). Otherwise A ships, because A has no new service to operate
> and that is worth real accuracy.
>
> If **C** comes within 5 points of A, ship C and drop the LLM call entirely.

Whichever wins, `attrib_version` records it and the loser's implementation stays
in the tree behind the same interface, so a re-run after a model upgrade is a
config change rather than an archaeology project.

### 5.6 The confidence gate

Independent of which approach wins: any utterance below a calibrated confidence
threshold is stored as `speaker: "unknown"`. The threshold is chosen from the
eval set as the point where role accuracy on non-abstained utterances reaches
**95%**. Report the resulting abstention rate honestly in the plan's completion
notes; if it is above ~30%, the feature ships as "quotes, mostly unattributed",
which is still worth shipping and must not be dressed up as more.

---

## 6. Profanity masking

New module `backend/app/radio_profanity.py`. Deliberately small and dependency-free.

```python
mask(text: str) -> tuple[str, bool]   # -> (masked_text, contained_profanity)
```

- **Whole-word matching with boundaries**, plus an explicit allowlist, because
  the Scunthorpe problem is real and F1 has a driver whose name substring-matches
  nothing today but might tomorrow. Test it with `Scunthorpe`, `assist`,
  `Sainz`, `bugger` and `analysis`.
- The whole matched word becomes exactly `***` — three asterisks, regardless of
  word length, per the request. Surrounding punctuation is preserved:
  `"fucking hell"` → `"*** hell"`.
- The word list lives in a **Mongo-backed config document with a file default**,
  so a missed word can be added without a redeploy. `mask_version` increments on
  change and triggers a re-mask pass over stored `text_raw` — which is the entire
  reason `text_raw` is stored.
- Handles common ASR renderings (spacing, hyphenation, `f***ing` already
  partially masked by the ASR) and a small set of non-English expletives; F1
  radio is not monolingual.

**The API serves `text_masked` only.** `text_raw` is projected out in the Mongo
query, not filtered in Python — a future endpoint author cannot leak it by
forgetting a line.

**Audio bleeping is explicitly out of scope for v1**, and the reason is not
difficulty but consequence: editing the MP3 means we can no longer point at F1's
URL, so we take on hosting, a processing job, and ownership of a modified
derivative of F1's content. Word-level timestamps are already captured in
`utterances[].start/end`, so the option stays open. It is gated behind actual
demand, not built speculatively.

---

## 7. Notability ranking

Not needed for 2026 (31 clips over two hours is one every four minutes) and
genuinely needed for 2023/2024 (110–146 clips). Built rule-first, in Python,
against data the app has already cached — the same discipline `race_replay` and
`session_recap` apply.

Signals, all cheap:

- **Proximity to a race-control event** (penalty, investigation, SC/VSC, red
  flag) within ±30s — `race_control_facts.summarize_race_control` already
  produces these.
- **Proximity to that driver's own pit stop** (±30s) — `pit_stops` is cached.
- **Position change** for that driver within ±1 lap — `race_laps` is cached.
- **Duration percentile** within the session. A 3s clip is very likely "copy".
  The 192s outlier shows why this is a percentile and not a threshold.
- **Burst detection**: ≥3 clips from one driver inside 2 minutes.
- **Retirement or DNF** within ±60s.

An optional single LLM call **per session** (not per clip) ranks the transcribed
list; it is a refinement on top of the rule score, never a replacement for it, and
its output is stored so it never re-runs.

**Display rule, matching the app's "no silent caps" convention:** every clip gets
a marker on the replay scrub bar regardless of score. Ranking only decides which
ones auto-pop in watch mode and which are collapsed behind "show all N" in the
Pitwall module. Nothing is ever silently dropped.

---

## 8. Backend modules

| File | Responsibility |
|---|---|
| `backend/app/radio_clips.py` | Fetch `/team_radio`; fall back to livetiming `TeamRadio.json` on 404/error; `HEAD` each URL for `Content-Length` → `duration_s`; emit clip rows. **404 means "F1 published none" and is a normal outcome, not an error.** |
| `backend/app/radio_transcribe.py` | The ASR seam. `transcribe(url) -> Transcript`. One provider behind one interface, mirroring `agent/model.py`'s reasoning for why the seam exists. |
| `backend/app/radio_attribution.py` | Approaches A, B1 and C behind one `attribute(transcript, driver, team) -> list[Utterance]`, selected by config. |
| `backend/app/radio_profanity.py` | §6. |
| `backend/app/radio_notability.py` | §7. |
| `backend/app/race_radio.py` | `GET /api/race_radio?year=&round=&session=race`. Mongo read + projection only. Returns `{clips, synced, source, total_clips}`. Registered in `main.py` alongside the other routers. |
| `backend/scripts/sync_race_radio.py` | The job. `--year --round --force --stage=ingest,asr,attrib,mask,notability`. Follows `scripts/sync_race_timing.py`'s shape, including its motor stub for CLI use. |
| `backend/scripts/eval_radio_attribution.py` | §5.5's scoreboard. |
| `backend/scripts/import_hf_radio_corpus.py` | Phase 4. Maps the CC BY 4.0 corpus onto our clip ids to backfill 2018–2025 transcripts without re-transcribing. |

**Endpoint contract** (`RaceRadio` in `frontend/src/lib/api.ts`):

```ts
export interface RadioUtterance {
  speaker: "driver" | "pit" | "unknown";
  text: string;           // already masked; text_raw is never served
  start: number; end: number;
  confidence: number;
}
export interface RadioClip {
  id: string;
  driver_number: string;
  t_ms: number | null;    // null when the session could not be anchored — §4
  lap?: number;
  duration_s: number;
  url: string;
  utterances: RadioUtterance[];
  strong_language: boolean;
  notability: number;
}
export interface RaceRadio {
  year: number; round: number; session: string;
  clips: RadioClip[];     // ascending by t_ms, nulls last
  synced: boolean;
  source: "openf1" | "livetiming";
}
```

---

## 9. Frontend — the watch-mode popup

### 9.1 Where it hooks in

`watch-view.tsx` already computes exactly the number needed, in the paint
callback around line 566:

```ts
const raceMs = (cumulative[index] ?? 0) + elapsedMs;
```

That is the same quantity as a clip's `t_ms`. **The popup scheduler consumes
`raceMs` and nothing else.**

New files, keeping `watch-view.tsx` (2,354 lines) from growing another feature:

- `frontend/src/lib/watch-radio.ts` — pure, React-free, testable: given the clip
  list and successive `raceMs` readings, decide what should be on screen.
- `frontend/src/components/radio-popup.tsx` — the box.

`watch-view.tsx` gains only the fetch, one hook call, and one element.

### 9.2 Scheduling rules

These are the rules that make it feel right rather than annoying:

- **Fire on forward crossing only.** A clip fires when `raceMs` crosses its
  `t_ms` moving forward, within a 2s window. On a scrub or jump-to-lap, clips
  skipped over are **not** replayed as a backlog — the user jumped past them
  deliberately.
- **Dwell** = `clamp(4500ms, 350ms × word_count, 9000ms)`. Long enough to read,
  short enough not to camp on the timing tower.
- **Queue, never stack.** One box at a time. A clip arriving while another is up
  waits, up to 15s; past that it is dropped from the queue (its marker stays on
  the scrub bar). Two boxes fighting over the bottom-left corner is worse than
  missing one.
- **Never show the future.** Same rule the race-control feed already enforces —
  a clip whose `t_ms` is ahead of the playhead cannot render, so a paired second
  screen cannot spoil the race.
- **Paused means paused.** No clip fires while the clock is stopped.
- **Overlong clips** (`duration_s > 30`) show the first two utterances plus an
  ellipsis and a "full message" affordance; the box never grows past three lines.
- **`prefers-reduced-motion`** replaces the slide with a fade. `useReducedMotion`
  is already imported in `watch-view.tsx`.

### 9.3 Visual spec

Reuses the `PairedToast` portal pattern at `watch-view.tsx:288` — portalled to
`document.body` because the header and footer are flex-none clipping contexts and
the body is `overflow-hidden`.

- **Position** bottom-left: `left: max(0.75rem, env(safe-area-inset-left) +
  0.75rem)`, `bottom` likewise. Bottom-left is the broadcast's own placement and
  is the corner the timing tower does not occupy.
- **Width** `min(calc(100vw - 1.5rem), 420px)`.
- **Opaque, not glass.** `PairedToast` already establishes why: this lands over a
  moving timing tower, and translucency over twenty rows of shifting numbers is
  the one place the house style costs legibility. Same
  `linear-gradient(180deg,#241a13,#191210)` ground.
- **Team colour** from `getTeamColor(driver.team)` — `ReplayDriver` already
  carries `team`, so no extra lookup. Applied as a 4px left bar, the driver
  surname, and a 0.35-alpha border.
- **Header row:** surname in team colour, `TEAM RADIO` in the app's established
  uppercase tracked label style (`text-[10px] tracking-[0.18em] uppercase
  text-warm-500`), `LAP nn` right-aligned and tabular.
- **Utterance rows:** a 34px speaker gutter (`RUS` / `PIT` / `RADIO`) then the
  quoted text. **Driver lines in team colour, pit lines in `text-warm-300`,
  unknown in `text-warm-300` with the neutral `RADIO` label.** The colour split
  is what lets the eye separate the voices without reading the labels — it is the
  feature, not decoration.
- **Play control** bottom-right of the box with `duration_s` as `m:ss`. Audio is
  tap-to-play, never autoplay. While playing, a four-bar pseudo-waveform animates
  on a CSS keyframe — **it is not driven by the audio** (§1.5) and no code should
  imply otherwise.
- **Entrance** `apex-radio-in` (a slide-from-left sibling of the existing
  `apex-toast-in` at `globals.css:412`), 320ms, `var(--ease-out-apex)`. Exit is a
  160ms fade.
- **`role="status"`, `aria-live="polite"`** — a caption is not an interruption,
  and `alert` would preempt a screen reader mid-sentence. Same reasoning
  `PairedToast` records.
- A `strong_language` clip renders its masked caption normally; the flag only
  gates any future audio-related treatment.

### 9.4 A settings toggle

Radio popups get an entry in `watch-preferences.ts` alongside `density`,
`pinned` and `timingMode`, persisted the same way. Default **on** for captions.
Some people watching next to a live broadcast will want the screen quiet.

---

## 10. Testing

**Backend** (`pytest`, matching the existing per-module test files):

- `test_radio_clips.py` — 404 → `synced: true, clips: []`, not an exception;
  livetiming fallback on OpenF1 error; `Content-Length` → duration; a missing
  `Content-Length` yields `duration_s: null` and does not abort the session.
- `test_radio_profanity.py` — the Scunthorpe set; `***` exactness; punctuation
  preservation; `mask_version` triggering a re-mask; **an assertion that the
  endpoint projection excludes `text_raw`**, since that is the one leak with real
  consequences.
- `test_race_radio.py` — `t_ms` derivation against a fixture with a known
  `race_start`; null-`t_ms` ordering (nulls last); the projection; version-key
  independence (a `mask_version` bump must not invalidate transcripts).
- `test_radio_attribution.py` — the eval fixture runs as a **regression test with
  a floor**, not a pass/fail on absolute accuracy: a prompt change that drops
  role accuracy more than 3 points below the recorded baseline fails CI.

**Frontend** (matching how `watch-clock` was made testable — React-free logic
with an injectable clock):

- `watch-radio.test.ts` — forward-crossing only; no backlog after a jump; queue
  ordering; the 15s drop; dwell clamp at both ends; nothing fires while paused;
  no future clip ever selected.
- The popup component itself is verified visually per the repo's convention —
  headless Chrome, **not** the Claude_Browser preview pane, which stalls on
  routes with `loading.tsx`.

---

## 11. Re-verifying the research

```bash
curl -s "https://api.openf1.org/v1/team_radio?session_key=11353" | head -c 400
```

```bash
curl -s "https://livetiming.formula1.com/static/2026/2026-08-23_Dutch_Grand_Prix/2026-08-23_Race/TeamRadio.json" | head -c 400
```

```bash
curl -s -D - -o /dev/null -H "Origin: https://example.com" "https://livetiming.formula1.com/static/2026/2026-08-23_Dutch_Grand_Prix/2026-08-23_Race/TeamRadio/RUS_63_20260823_153426.mp3" | grep -i "access-control\|content-length"
```

Coverage scans must retry and must treat 404 separately from transport errors —
§1.2 explains why a naive scan lies.

---

## 12. Phasing

**Phase 1 — the popup, end to end.** §§3, 4, 5, 6, 8, 9. Ingest → Groq ASR →
bake-off → winner wired in → masking → `/api/race_radio` → the box in watch mode
with tap-to-play. Backfill the eleven covered 2026 sessions. Demoable on its own.

**Phase 2 — the feed.** Pitwall "Radio" module (the module list is in
`schedule/[season]/[round]/pitwall/page.tsx`, and Race Control is its nearest
sibling); scrub-bar markers on Race Replay; per-driver filter and text search.
Notability ranking starts earning its keep here.

**Phase 3 — radio as evidence.** A `get_team_radio` fact tool in
`backend/agent/tools/` — reading cached Mongo, never the builder (§2 rule 3) —
plus radio quotes as cited grounding in AI Recap and Strategy Commentary, reusing
the existing citation-chip mechanism.

**Phase 4 — depth.** Import the Hugging Face corpus for 2018–2025; driver
"radio personality" stats on the driver modal; "radio moment of the race" on the
race detail page; revisit audio bleeping only if demand is real.

---

## 13. Deliberately not doing

- **Audio bleeping** (§6) — deferred, not forgotten; word timings are stored.
- **Real waveform visualisation** — needs an audio proxy (§1.5) for a purely
  decorative gain.
- **Live/in-session radio** — OpenF1 charges for real-time, and ASR adds latency
  on top. It would arrive late and cost money.
- **Re-hosting any audio** — we hotlink F1's public files, the same posture the
  app already takes with Race Control.
- **Scraping human transcripts** for training or display.
- **Pre-2023 radio** — not in the API; would be a manual curation project, like
  Constructor Genealogy, not a data feature.

---

## 14. Open decisions

1. **Diarization provider for B1** — Deepgram vs AssemblyAI. Pick on free-credit
   terms at build time; the seam in `radio_attribution.py` makes it a swap.
2. **Where the job runs.** `sync_race_radio` as a new Cloud Run Job, or a stage
   inside the existing `data_sync` job? A stage is fewer moving parts; a separate
   job keeps a slow inference step out of the hourly sync's timeout budget. Lean
   separate.
3. **Does the popup surface in the fast `race-replay.tsx` too**, or watch mode
   only? Its clock runs ~150× real time, so captions would strobe. Probably
   markers there and popups only in watch mode — confirm once Phase 1 is on
   screen.
4. **Whether `unknown` utterances render at all in the popup**, or only in the
   Pitwall module. Depends entirely on §5.6's measured abstention rate; decide
   with the number in hand, not before.
