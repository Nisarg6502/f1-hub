# F1 Hub — Pitwall Assistant: Rich Visual Answers

**Status:** research + proposal. Nothing implemented, no application code written.
**Date:** 2026-08-23
**Scope:** letting the Pitwall Assistant answer with charts, not only prose.

---

## 1. What exists today (verified, not assumed)

### 1.1 The chat surface

`frontend/src/components/pitwall-assistant-panel.tsx` is the production panel — a portaled
480px right-hand drawer. `frontend/src/app/pitwall-chat/page.tsx` is an unlinked CP61 dev
page kept for debugging; it renders the same stream with far less UI.

**Rendering.** Answers go through `react-markdown` with `remark-gfm`, with two component
overrides: `a` → `AnchorMark` (citation marks) and `table` → `MarkdownTable` (a horizontal
scroller, because a six-column table in a 480px drawer otherwise gives the whole message list
a horizontal scrollbar). Prose styling is `ANSWER_PROSE`, a long list of Tailwind arbitrary
descendant variants — `@tailwindcss/typography` is deliberately not a dependency.

**Sanitisation.** There is no `rehype-raw` anywhere in the frontend (`grep -rn "rehype"` in
`frontend/src` returns nothing). `react-markdown` v10 does not render raw HTML by default, so
model-authored HTML in an answer is inert text today. **Any plan that starts injecting markup
is removing a safety property that currently exists for free.**

**Transport.** SSE over `POST /api/chat`, hand-parsed in `frontend/src/lib/agent-api.ts`
(`streamChat`, `splitFrames`, `parseFrame`, `dispatch`). `EventSource` is deliberately not
used — it is GET-only and silently reconnects, which would re-run and re-charge a whole agent
turn. Event vocabulary is defined in `backend/agent/sse.py`, which its own docstring calls
"the contract":

| Event | Payload | Notes |
|---|---|---|
| `activity` | `{label, state, detail, kind, at}` | drives the activity timeline |
| `token` | `{text}` | many; see chunking note below |
| `sources` | `{sources[], anchors[]}` | once, before `done` |
| `done` | `{run_id, mode, model, tier, verification, elapsed_ms, cached?}` | terminal success |
| `suggestions` | `{suggestions[]}` | the one frame emitted **after** `done` |
| `error` | `{code, message}` | terminal failure, always a stream event, never a 4xx |

`dispatch`'s `default:` case ignores unknown events on purpose ("a newer service may emit
events this build predates"), so **adding a new SSE event type is backward-compatible by
construction** — an old frontend build simply ignores it. This is the single most important
fact for this plan.

One nuance worth knowing before designing around streaming: the answer is **not** streamed as
it is generated. `graph._run_turn` buffers the whole draft, `verifier.check` runs, a one-shot
repair may replace it, and only then is it replayed through `_chunk_draft` at six words per
`token` frame. So "mid-stream" in this app means "during a cosmetic replay of an already-final
answer", which makes attaching a visual to a completed answer much easier than it would be in
a genuinely token-streamed system.

### 1.2 The backend agent — it already has a tool-calling loop

`backend/agent/` is a full LangGraph/deepagents service, not a prompt wrapper.

- `tools/__init__.py` registers **19 tools** in `TOOLS`, keyed by each function's own
  `tool_name`. `graph.build_tools` / `build_tool_subset` bind them per request.
- `tools/base.py` enforces one contract on every tool:
  `{"available": True, "data": {...}, "evidence_id": "ev_7", "source": "mongo:race_results/2026-14", "as_of": ...}`
  or `{"available": False, "reason": ...}`. A tool **never raises** (`@fact_tool` converts
  escaping exceptions) and **never triggers FastF1**.
- `ledger.py` — every tool call appends an `Evidence` entry with an opaque `ev_N` id, the full
  fact bundle, its source string and per-entry `as_of`. `Evidence.locate()` can find where a
  value lives inside a bundle; `anchored_citations()` groups anchors per record.
- `verifier.py` walks the finished draft: does every claim carry a marker, does every cited id
  exist, do the numbers appear in that entry's data. One repair attempt, then ship anyway.
- `router.py` picks a tier from pattern rules with no model call; `subagents.py` has four
  subagents; `answer_cache.py` replays whole answers keyed on normalised question +
  `PROMPT_VERSION`; `followups.py` generates the chips.
- Budgets: `AGENT_MAX_STEPS = 12` super-steps, `REQUEST_TIMEOUT_SECONDS = 180`.

**This changes the whole plan.** There is already a validated, tested mechanism for "the model
decides it needs something and asks for it", with a ledger recording exactly what came back.
A visual should be a *tool call*, not a new output format the model has to be taught to emit.

Fact bundles that are already chart-shaped, with no new backend data work:

| Tool | Chart-ready payload |
|---|---|
| `get_standings` | `standings[]` with `position, driver/constructor, team, points, wins, points_behind_leader` (gaps precomputed — CP38 bans model arithmetic) |
| `get_lap_summary` | per driver: `start_position, end_position, net_positions_gained, best/worst_position, position_changes` plus `trace[]` already downsampled to `TRACE_SAMPLES = 10` points, max `MAX_TRACE_DRIVERS = 6` drivers. This is *literally* a line-chart series. |
| `get_head_to_head` | `_season_shape` per driver: `wins, podiums, points, retirements, best_finish, average_finish` + `qualifying_teammate_battles` |
| `get_driver_season_summary` | same shape for one driver |
| `get_race_strategy` | `strategy_commentary.build_facts(...)` — stints, undercut/overcut, already computed |
| `get_pit_stops` | `stops_by_driver`, `fastest_stop`, `total_stops` |
| `get_season_calendar` | `rounds[]` |

### 1.3 Frontend visual capability that already exists

`package.json` already has **`recharts` ^3.8.1**, `motion` ^12, `three` + `@react-three/*`,
`lucide-react`. No new charting dependency is needed.

Existing chart/visual components:

| File | What it is | Reusable in a chat bubble? |
|---|---|---|
| `components/lap-position-chart.tsx` | Recharts line chart, position/gap modes, custom tooltip | Pattern yes, component no — takes page-level `drivers` + `initialLaps: RaceLap[]` server props and is sized for a full page |
| `components/pit-stops-chart.tsx` | Recharts, sortable table + bars | Same caveat |
| `components/tire-stints-chart.tsx` | Recharts stint strips with a compound colour map | Same caveat; the `COMPOUND` colour map is directly liftable |
| `components/season-barcode.tsx` | The history barcode (pure SVG/divs) | Yes, close to drop-in for a season-shape strip |
| `components/animated-ring.tsx` | `AnimatedRing({center, unit, label, offset, color})` | Yes, genuinely drop-in for a stat tile |
| `components/track-map.tsx` | Image + label wrapper | Yes |
| `components/teammate-battle-panel.tsx`, `driver-comparison-recap.tsx`, `strategy-commentary-card.tsx`, `title-decider-panel.tsx` | Typed-props presentation components | Good shape references |
| `lib/team-colors.ts` | `getTeamColor(teamName)` → `TeamColor` | **The series palette. Use this, do not invent chart colours.** |
| `components/pitwall-modules.tsx` | A `Record<id, ReactNode>` module switcher | The registry pattern already exists in this codebase |

Honest read: **the existing charts are not drop-in for a 480px drawer.** What is reusable is
Recharts itself, `team-colors.ts`, the compound colour map, `AnimatedRing`, and the prop-shape
conventions. Budget for new small-format components, not for wrapping existing ones.

One live-verified trap from `pitwall-modules.tsx`: Recharts `ResponsiveContainer` silently
renders at zero height if no ancestor has a definite height. In a chat bubble every visual must
carry an explicit pixel height.

### 1.4 The CSP, read from the actual header

`frontend/next.config.ts` builds `CSP` and serves it on `/:path*`. Confirmed live against the
dev server on :3113:

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:;
img-src 'self' data: blob: https://storage.googleapis.com https://upload.wikimedia.org https://commons.wikimedia.org;
connect-src 'self' https://f1-backend-…run.app https://api.openf1.org https://www.opentopodata.org;
worker-src 'self' blob:; upgrade-insecure-requests
```

Load-bearing consequences:

- There is **no `frame-src`**, so it falls back to `default-src 'self'`. A `data:` or
  cross-origin iframe is blocked today.
- A `srcdoc` iframe **inherits the parent's policy** — which includes `script-src
  'unsafe-inline'`. So a same-document sandbox would *not* stop model-authored inline script
  from executing; the CSP would give a false sense of containment.
- `style-src 'unsafe-inline'` is present, so Recharts' inline styles are fine.
- `img-src data: blob:` is present, so canvas/SVG-derived images are fine.
- The repo has a real CSP incident on record (GA's `gtag.js` refused with an *empty*
  `errorText`, misdiagnosed as a network block). A CSP refusal here would look like "the chart
  just doesn't render", with nothing in the logs.
- Side note found while checking: this dev build's `connect-src` does **not** list an agent
  origin, only the backend. `NEXT_PUBLIC_AGENT_BASE_URL` is presumably unset locally while
  `agent-api.ts` defaults to `http://localhost:8100`. Not this plan's problem, but worth
  knowing before debugging a "chart never arrives" locally.

---

## 2. The option space

| | Expressiveness | Security under this CSP | Latency / tokens | Malformed output | Work here |
|---|---|---|---|---|---|
| **1. Typed spec → vetted React registry** | Only pre-built kinds | Excellent — no new CSP directive, no injected markup, React escapes all text | Lowest; ~30 tokens if the model references evidence rather than restating data | Validate at the boundary, drop the visual, prose answer stands | Moderate, mostly frontend components |
| **2. Model-authored markup in a sandboxed iframe** | Maximum ("artifacts") | Poor→expensive. `srcdoc` inherits `script-src 'unsafe-inline'`; real isolation needs a **second origin** (extra Cloud Run service or subdomain), a `frame-src` entry, its own tight CSP, and postMessage sizing | Worst — a whole document per answer against a 12-step / 180s budget on a free-tier plan | Broken page, blank frame, or worse | High, and it breaks the project's core claim |
| **3. Constrained chart DSL (Vega-Lite-ish)** | High within charts | Good, but the model emits the *data* | Medium-high; a 20-driver series is a lot of tokens the model can get wrong | Schema-validate, reject | Medium; new dependency or a hand-rolled spec compiler |
| **4. Markdown++ (tables, fenced blocks)** | Low | Excellent | Free | Renders as a code block | **Tables already work today** |

### Why option 2 is wrong *for this app specifically*

Not because iframes are scary. Because this project's entire thesis, stated in
`CHAT-AGENT-PLAN.md` §1, is that **the model narrates and orchestrates but never derives
facts**, and every number is checked against the ledger by `verifier.py`. A chart the model
authored as markup contains numbers the verifier cannot see, cannot anchor, and cannot cite.
It would be the one part of the answer with no evidence trail — sitting directly above a
source strip that promises there is one. That is a worse regression than shipping no charts.

### Why option 3 is a fallback, not the default

A Vega-Lite-style config still has the model typing out data points. CP38 (invented teammate
relationship from correct raw rows), CP41 (prompt rule violated in ALL CAPS) and CP44
(documented format, different format emitted) all say the same thing: do not make correctness
depend on the model transcribing accurately.

### Recommendation

**Option 1, with one twist that makes it materially better than the generic version: the model
never emits the chart data.**

The model calls a tool — `render_visual(kind, evidence_id, …)` — and the **backend** expands
the spec from the fact bundle already sitting in the ledger under that `evidence_id`. The
model's entire contribution is "draw a standings bar chart from `ev_3`".

This buys, in one design:

1. **Hallucinated chart data is structurally impossible.** Every value comes out of a bundle a
   tool already returned. There is no path by which a chart can show a number the ledger does
   not contain.
2. **Charts are citable for free.** A visual carries the `evidence_id` it was built from, so
   `ledger.anchored_citations` and the existing `SourceStrip` work unchanged.
3. **~30 tokens instead of ~1500.** Material on a rationed free-tier inference plan with a
   12-step budget.
4. **Zero CSP change.** Recharts is inline SVG. No new origin, no script, no iframe, no CDN.
5. **It uses the mechanism the model is already good at.** A 20th tool in an existing registry,
   not a new output grammar to be taught in the prompt — and CP41/CP44 are two recorded
   failures of teaching a model an output grammar.

Fallback if the fixed kinds prove too rigid in real use: option 3, a small in-house chart spec
(`{mark, x, y, series}`) compiled to Recharts — but still populated from ledger data, with the
model choosing only the *shape*, never the numbers.

Hybrid with option 2 behind a flag: **not recommended, not even as a flag.** It needs a second
deployed origin before it is safe at all, and the argument against it is architectural rather
than effort-based.

---

## 3. Schema sketch

### Wire format — a new SSE event

```
visuals    {"visuals": [ VisualSpec, ... ]}
```

Emitted **once, immediately before `sources`**, always as one complete frame. There is
deliberately no partial/streamed visual: a chart that draws itself in pieces from an
incomplete spec is a class of bug this design simply does not have. Old frontend builds ignore
the event via `dispatch`'s `default:` case.

### Types (`frontend/src/lib/visual-spec.ts`)

```ts
/** Shared by every kind. `evidence_id` is what makes a chart citable. */
interface VisualBase {
  id: string;                 // "vis_1", assigned by the backend, opaque
  evidence_id: string;        // "ev_3" — must exist in this turn's ledger
  title: string;              // backend-composed from the bundle, not model prose
  caption?: string | null;    // e.g. "after round 14"
  as_of?: string | null;      // inherited from the evidence entry
}

interface StandingsBar extends VisualBase {
  kind: "standings_bar";
  basis: "driver" | "constructor";
  rows: { label: string; team?: string | null; points: number;
          wins?: number | null; behind?: number | null }[];
}

interface PositionTrace extends VisualBase {
  kind: "position_trace";
  laps: number[];             // shared x axis, already downsampled
  series: { label: string; team?: string | null;
            points: (number | null)[] }[];   // null = no sample at that lap
}

interface HeadToHead extends VisualBase {
  kind: "head_to_head";
  metrics: { label: string; unit?: string | null;
             a: number | null; b: number | null;
             better: "higher" | "lower" }[];
  a: { label: string; team?: string | null };
  b: { label: string; team?: string | null };
}

interface StatTiles extends VisualBase {
  kind: "stat_tiles";
  tiles: { label: string; value: string; unit?: string | null;
           ratio?: number | null }[];        // ratio drives AnimatedRing
}

interface StintStrip extends VisualBase {
  kind: "stint_strip";
  total_laps: number;
  drivers: { label: string; team?: string | null;
             stints: { compound: string; start_lap: number; end_lap: number }[] }[];
}

export type VisualSpec =
  | StandingsBar | PositionTrace | HeadToHead | StatTiles | StintStrip;
```

### Example payload

```json
{
  "visuals": [{
    "id": "vis_1",
    "kind": "standings_bar",
    "evidence_id": "ev_2",
    "title": "2026 drivers' championship",
    "caption": "after round 14",
    "as_of": "2026-08-23T06:31:04.118000+00:00",
    "basis": "driver",
    "rows": [
      {"label": "Lando Norris",   "team": "McLaren",  "points": 284, "wins": 6, "behind": 0},
      {"label": "Max Verstappen", "team": "Red Bull", "points": 259, "wins": 5, "behind": 25},
      {"label": "Oscar Piastri",  "team": "McLaren",  "points": 241, "wins": 3, "behind": 43}
    ]
  }]
}
```

Every one of those numbers was read out of `ev_2`'s bundle by Python. The model wrote the
string `"ev_2"` and the word `"standings_bar"`.

---

## 4. Which visuals to build first, and why

Chosen against the panel's own suggestion chips in `ROUTE_SUGGESTIONS` — these are literally
the questions the product already invites.

| Kind | Question it answers | Source tool | Field mapping | Built from |
|---|---|---|---|---|
| `standings_bar` | "Who's leading the drivers' championship?" / "How close is the constructors' title fight?" | `get_standings` | `standings[].points`, `.points_behind_leader`, `.wins` | Recharts horizontal `BarChart` + `getTeamColor` |
| `head_to_head` | "Compare Verstappen and Norris this season" (a **default** chip) | `get_head_to_head` | `_season_shape`: wins / podiums / points / average_finish | New diverging bar pair; prop shape modelled on `driver-comparison-recap.tsx` |
| `position_trace` | "Walk me through this race's key moments" / "How did he lose the lead?" | `get_lap_summary` | `drivers[].trace[].{lap,position}` (already ≤10 pts × ≤6 drivers) | Recharts `LineChart`, reversed Y — same idea as `lap-position-chart.tsx`, sized down |
| `stat_tiles` | "Who won this race?" / point lookups generally | any bundle | 2–4 scalar fields | `AnimatedRing` + text |
| `stint_strip` | "Why did Ferrari two-stop?" | `get_race_strategy` | `build_facts` stints | `tire-stints-chart.tsx`'s `COMPOUND` map + flex bars |

`position_trace` is the one that is nearly free on the backend: `TRACE_SAMPLES = 10` and
`MAX_TRACE_DRIVERS = 6` mean the bundle is *already* a bounded chart series, downsampled for
exactly the "don't blow the context window" reason that also makes it the right size for a
480px drawer.

**Recommended first two:** `standings_bar` and `stat_tiles`. Standings is the most-asked
question class and the cleanest data; stat_tiles is trivial and proves the registry, the SSE
frame, the cache round-trip and the error states on the simplest possible payload.

---

## 5. Backend changes

### 5.1 Where it lives

- `backend/agent/visuals/__init__.py` — a `BUILDERS: dict[str, Builder]` registry, one builder
  per `kind`, mirroring how `tools/__init__.py` builds `TOOLS` from `tool_name`.
- `backend/agent/visuals/base.py` — the spec contract, `VISUAL_MAX_PER_ANSWER = 2`, and a
  `VisualLedger` (a list plus `vis_N` id assignment; same rationale as `EvidenceLedger`'s
  opaque ids).
- `backend/agent/tools/visualise.py` — the tool itself, `tool_name="render_visual"`, added to
  `ALL_TOOLS`. It obeys the same `@fact_tool` contract as its 19 siblings and therefore cannot
  raise and cannot abort a run.
- `backend/agent/sse.py` — one new `visuals(items)` frame, documented in the module docstring
  alongside the others, since that docstring is the stated contract.
- `backend/agent/main.py` — yield `sse.visuals(...)` just before `sse.sources(...)`.
- `backend/agent/graph.py` — the `AgentEvent` tuple gains nothing; the visual ledger travels
  with the request the same way `EvidenceLedger` does (constructed in `_stream`, passed into
  `build_tools`).

### 5.2 The tool's shape

```python
@fact_tool("render_visual")
async def render_visual(kind: str, evidence_id: str,
                        subjects: list[str] | None = None,
                        *, ledger=None, visuals=None, db=None) -> dict:
    """Draw a chart from evidence you have already retrieved this turn."""
```

`visuals` joins `ledger` and `db` in `graph._HIDDEN_ARGS` so it never appears in the model-
facing JSON schema — the same treatment `ledger`/`db` already get, and for the reason
`_public_signature` documents (a hidden arg that becomes visible is one the model will start
asserting).

Returns `{"available": True, "data": {"visual_id": "vis_1", "kind": "standings_bar",
"rows_drawn": 10}}` on success — deliberately **not** the spec itself, so the built payload
never re-enters the model's context and cannot be paraphrased back into the prose.

### 5.3 How the model is instructed

One short paragraph appended to the existing system prompt in `graph.py`, plus the tool's own
first docstring paragraph (which `_tool_description` already uses as the model-facing
description). Substance:

- Call `render_visual` **after** you have the data, with the `evidence_id` from that tool
  result.
- At most one chart per answer unless the question is explicitly a comparison.
- Never restate the chart's numbers in full in the prose; say what it shows.
- If `render_visual` reports `available: false`, answer in prose and do not mention the chart.

`PROMPT_VERSION` in `config.py` **must** be bumped — it keys `answer_cache`, and old cached
answers have no visuals.

### 5.4 Malformed / non-compliant output — assume it, don't hope

The plan does not assume the model complies. Every one of these is a real expected path:

| The model does | What happens |
|---|---|
| Cites `ev_9` that does not exist | Ledger lookup miss → `unavailable("no evidence with that id was retrieved this turn")`. Same posture as a hallucinated `[ev_N]` citation, which `verifier.py` already handles. |
| Asks for `kind: "pie_chart_3d"` | Registry miss → `unavailable("<kind> is not a chart this assistant can draw; available: …")`. The reason lists the real kinds, so the model can self-correct within its step budget. |
| Asks for `standings_bar` from a weather bundle | The builder validates required fields against the bundle and returns `unavailable` naming the missing field. |
| Calls `render_visual` five times | Capped at `VISUAL_MAX_PER_ANSWER = 2`; further calls return `unavailable("this answer already has the most charts it can show")`. |
| Calls it before any data tool | No evidence exists → miss, as row 1. |
| Emits a chart-ish fenced code block instead of calling the tool | Renders as a code block, exactly as today. No regression. |
| Emits nothing | Prose answer, exactly as today. Visuals are strictly additive. |

The builder itself must be **total in the same way `Evidence.locate` already is**: a bundle it
cannot walk yields no visual rather than costing the reader the answer they are looking at.

### 5.5 Answer cache

`answer_cache.set_cached` / `get_cached` currently round-trip `text` + `sources`. They must
round-trip `visuals` too, and the cached-replay branch in `main.py` (~line 320) must emit the
`visuals` frame before `sources`. An entry written before this change simply has no `visuals`
key — the same "older entries carry no anchors" degrade the CP72 anchors already rely on.
Without this, a cache hit silently loses the chart and the same question answers differently
on the second ask.

---

## 6. Frontend changes

### 6.1 Files

- `frontend/src/lib/visual-spec.ts` — the types above **plus a runtime validator per kind**.
  This is a CP44 requirement, not defensiveness theatre: the panel already re-validates
  `suggestions` at the boundary for exactly this reason.
- `frontend/src/components/pitwall-visual.tsx` — the registry:
  `const RENDERERS: Record<VisualSpec["kind"], FC<{spec}>>`, plus `PitwallVisual({spec})` which
  looks up, validates, and renders. **Unknown kind → render nothing**, matching
  `agent-api.ts`'s `default:` forward-compatibility stance.
- `frontend/src/components/visuals/*.tsx` — one small component per kind.
- `frontend/src/lib/agent-api.ts` — a `VisualSpec[]` type re-export, an `onVisuals` handler,
  and a `case "visuals":` in `dispatch` that filters to specs passing validation.
- `frontend/src/components/pitwall-assistant-panel.tsx` — `Message` gains `visuals:
  VisualSpec[]`, initialised `[]` on both message shapes; `onVisuals` patches it;
  `MessageBubble` renders them **between the answer bubble and `SourceStrip`**;
  `streamingSignature` gains `visuals.length` so the auto-scroll follows the added height.

### 6.2 States

- **Loading:** none needed, and that is the point. The frame is atomic and arrives after the
  answer text. A skeleton for something that appears in one tick is worse than nothing.
- **Mid-stream / incomplete:** structurally unreachable. A `visuals` frame is one JSON payload;
  a truncated frame fails `parseFrame`'s `JSON.parse` and is dropped by the existing parser.
- **Validation failure:** render nothing, no apology. Same call `FollowUpChips` makes — "no
  chips is a state, not a failure".
- **Empty data** (a spec with zero rows): the backend should not emit it; the frontend renders
  nothing if it arrives anyway.
- **Cancelled turn:** visuals arrive before `done`, so a turn cancelled early simply has none.
  The existing `cancelled` copy already covers it.
- **Reduced motion:** every visual honours `useReducedMotion` — Recharts `isAnimationActive`
  off, `AnimatedRing` static. The panel already imports the hook.
- **Sizing:** explicit pixel height on every chart container (see §1.3 — `ResponsiveContainer`
  renders at zero height otherwise, silently).
- **Copy button:** `CopyButton` copies `message.text`. A chart is not in it. Either leave it
  (charts are a view of cited data that is also described in prose) or append a plain-text
  table. Recommend leaving it in slice 1 and noting it.

### 6.3 Placement

**Slice 1: always below the answer text, above the source strip.** Do not ask the model to
place charts inline with a `[vis_1]` marker in slice 1 — that is precisely the CP44 shape
("the prompt documented `[RC L66]`; the model emitted `[RC 5]`"). Inline placement is a later
slice, and when it comes it should reuse `answer-anchors.ts`'s existing marker-rewriting
machinery rather than inventing a second one.

---

## 7. CSP implications, concretely

Against the header in §1.4, the recommendation needs **no CSP change at all**:

| Mechanism | Directive | Verdict |
|---|---|---|
| Recharts SVG | none (inline SVG is DOM, not a resource) | allowed |
| Recharts inline styles | `style-src 'unsafe-inline'` | already present |
| `visuals` SSE frame | `connect-src` — same `/api/chat` request | already allowed |
| No new fonts/images/scripts | — | nothing to add |

For completeness, what the rejected options would have cost:

- **Option 2 (iframe):** add `frame-src` (currently absent, so inheriting `default-src 'self'`);
  and note that a `srcdoc` frame **inherits** `script-src 'unsafe-inline'` from the parent, so
  same-document sandboxing does not actually contain script. Real containment means a second
  origin — a second Cloud Run service or a subdomain — with its own restrictive policy, plus
  `sandbox="allow-scripts"` *without* `allow-same-origin`, plus postMessage height negotiation.
  That is deployment work, not frontend work.
- **CDN-loaded chart library:** would need `script-src` widening. Given the gtag.js incident
  (refused with an empty `errorText`, misdiagnosed as a network block) this should be treated
  as a hard no; Recharts is bundled anyway.

---

## 8. Failure and abuse modes

Beyond §5.4's model-non-compliance table:

1. **A chart for data that does not exist.** Cannot happen. A visual is built only from a
   ledger entry, and a ledger entry exists only because a tool returned `available: true`. Ask
   for a lap chart on a round whose `race_laps` is unsynced and `get_lap_summary` already
   returns `unavailable`, so there is no `evidence_id` to reference at all.
2. **Stale data shown as current.** Every spec carries `as_of` inherited from its evidence
   entry. Render it — the app already does this via `LocalDateTime` and `source-strip.tsx`, and
   the hourly-sync / FastF1-403 reality (see memory + `HANDOFF.md`) makes it non-optional.
3. **Prompt injection through `tools/web.py`.** A web-sourced bundle can contain
   attacker-chosen strings that would become chart labels. Mitigations: (a) restrict
   chart-capable evidence to `mongo:` sources in slice 1; (b) truncate every label to ~40
   chars; (c) all label text goes through React's normal text escaping, never `dangerouslySet…`.
4. **Verifier blind spot.** `verifier.py` checks prose numbers against the ledger. Chart values
   bypass it — but they *are* ledger values by construction, so there is nothing for it to
   catch. Worth an explicit test asserting a built spec's values are all present in its
   evidence entry.
5. **Step-budget consumption.** Each `render_visual` call costs a super-step against
   `AGENT_MAX_STEPS = 12`. On a hard multi-hop question this could push a turn into
   `GraphRecursionError` and the `budget_exhausted` degrade. Must be measured on the golden
   set, not assumed. If it bites, the mitigation is to build the visual *implicitly* from the
   highest-value bundle in the ledger with no tool call at all — cheaper, less controllable.
6. **Frame size.** A 20-row standings spec is ~2KB. `MAX_TRACE_DRIVERS × TRACE_SAMPLES` = 60
   points. Cap rows at 20 per spec.
7. **Wrong chart, right data.** The model picks `stat_tiles` where a bar chart was obviously
   right. Not a correctness failure, just a mediocre answer. Accept it in slice 1; a per-kind
   hint in each builder's tool description is the cheap lever.
8. **Screen readers.** A chart is invisible to them. Every visual needs a `role="img"` with an
   `aria-label` summarising it, or a visually-hidden text equivalent. The panel already takes
   accessibility seriously (focus trap, `role="group"` on the chips) — do not regress it.

---

## 9. Phased delivery

**Slice 1 — the smallest useful thing (one checkpoint).**
`stat_tiles` + `standings_bar` only. Backend: `visuals/` package with two builders,
`render_visual` tool, `sse.visuals`, `main.py` wiring, `PROMPT_VERSION` bump, cache round-trip.
Frontend: `visual-spec.ts` with validators, `pitwall-visual.tsx` registry, two components,
`agent-api.ts` handler, panel wiring. Tests: builder unit tests (including every §5.4 row),
an SSE contract test asserting the real frame shape (CP44 rule), and frontend validator tests.
Rough size: ~600–800 LOC including tests, of which maybe 250 is the two chart components.

**Slice 2.** `position_trace` + `head_to_head`. Mostly new frontend components; the backend
builders are thin because both bundles are already chart-shaped. Smaller than slice 1.

**Slice 3.** `stint_strip`; tap-to-expand into the existing portal-modal pattern; golden-set
measurement of step-budget impact and of how often the model actually reaches for a chart.

**Slice 4 (only if slices 1–3 land well).** Inline placement via `[vis_N]` markers, reusing
`answer-anchors.ts`.

**Explicitly not planned:** iframes, model-authored markup, a new charting dependency, raw HTML
in answers.

---

## 10. Open questions for the user

1. **Placement.** Charts always below the answer (recommended for slice 1), or inline markers
   from the start? Inline is more pleasant and is the CP44 trap.
2. **Web-sourced charts.** Restrict chart-capable evidence to `mongo:` sources in slice 1
   (recommended), or allow web bundles from the start and rely on label truncation?
3. **Rate limiting.** Should a `render_visual` call count toward `rate_limit.measured_cost`?
   It costs a super-step but no meaningful model time.
4. **Drawer width.** Charts in a 480px drawer are small. Add tap-to-expand into the app's
   existing portal modal (`driver-modal.tsx` pattern), or accept small in v1?
5. **Cached answers.** Round-trip visuals through `answer_cache` (recommended — otherwise the
   same question answers differently on the second ask), or skip charts on cache hits?
6. **Model reliability.** CP73 already recorded this model getting confused about tool choice
   and burning its step budget. Is adding a 20th tool acceptable, or should slice 1 build the
   visual *implicitly* from the ledger with no model decision at all — cheaper and more
   reliable, but the model cannot choose the right chart for the question?
7. **Copy behaviour.** Should `CopyButton` include a plain-text rendering of the chart?
