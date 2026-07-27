# APEX Roadmap

## Vision

APEX is a Formula 1 season hub — the next stretch of work grows it from "when's the next race, who's winning" into deeper race analysis (comparisons, strategy, replay) and a few tightly-grounded GenAI features, per the research report from 2026-07-27. Everything ships read-only, free-tier-sourced, and Mongo-cached; no feature gets added by compromising those constraints.

## How this works

Checkpoints (`CP<n>`) number flatly and continuously across the project's life — they never restart per batch. One branch (`feat/<kebab-case>` or `fix/<kebab-case>`) and one PR per checkpoint; branch off `main`, implement, test (`python -m unittest discover tests` from `backend/`; `npm run build && npm run lint` from `frontend/`), verify in the browser, push, wait for the user's merge confirmation before starting the next checkpoint. Batches are small — 2 to 4 checkpoints — and get built, verified, and deployed before the next batch is planned; nothing here commits to building everything at once. `FEATURES.md` is the source of truth for what's actually shipped (its "Known gaps" section is not restated here). `HANDOFF.md` is the source of truth for session-level working memory and gotchas (also not restated here) — this file only tracks the durable plan: vision, batch history, current batch, and backlog.

## Shipped batches

| Batch | Checkpoints | Theme | Status |
|---|---|---|---|
| 1 | CP1-6 | Perf, circuit images, driver crop, driver modal, season selector, team logos | merged |
| 2 | CP7-14 | Circuit lightbox, schedule/home/standings polish, Pitwall CTA prominence, tyre stints re-sourced from FastF1 | merged |
| 2 (ad hoc) | unnumbered | Pit-stop analysis module (Pitwall), driver-bio rate-limit fix (Hamilton championship undercount) — built mid-batch in response to user requests, outside the original CP15-19 plan | merged |

The original plan's CP15-19 (driver/team head-to-head compare, championship calculator, lap-by-lap chart, calendar links, global search) were superseded by the ad-hoc work above and never built under those numbers. They're carried forward into the Backlog below rather than left as gaps — checkpoint numbering resumes cleanly at CP20.

## Current batch

Batch 3 — CP20-22, small fixes/polish before starting larger comparison/analysis features.

| # | Checkpoint | Status |
|---|---|---|
| 20 | Race weather "Conditions" tile on race detail page | ✅ merged |
| 21 | Nav "Season" label reflects active/viewed season | not started |
| 22 | `/telemetry` graceful env-var error + nav-link deferred | not started |

## Backlog (unscheduled)

### Comparison & analysis
- Driver-vs-driver head-to-head comparison (quali gap, points, head-to-head finishes)
- Teammate battle view
- Lap-by-lap position/gap chart (Pitwall "Lap Telemetry" module)
- Championship "Title Decider" scenario calculator
- Circuit similarity / "Circuit DNA" comparison across tracks

### Race weekend enrichment
- Circuit history panel (closest finish, most wins, first year raced)
- "Add to calendar" reminders for sessions
- Functional global search (nav search input is currently dead)
- Team radio moments (text, from OpenF1 race_control)
- F1DB circuit-layout SVGs / team logos to replace incomplete asset host coverage

### GenAI features
- "Explain this session" auto-recap after a race/quali/sprint syncs
- Natural-language query bar (replaces the dead nav search box)
- Race strategy commentary on the Pitwall page (grounded in stint data)
- Driver comparison narrative (pairs with the head-to-head feature)
- "Ask about this circuit" scoped chat (RAG over cached circuit history + Wikipedia extract)
- Pre-race prediction with transparent reasoning (framed as commentary, not a promise)

### Replay & media
- Race replay / session playback (lap-by-lap scrub, timing tower, track status flags)
- Strategy "what-if" pit-stop replay (drag a stop to a different lap, estimate position impact)

### Other
- Personal "watch party" second-screen mode
- Constructor budget cap tracker (manually updated, no live feed exists)
- Fantasy / prediction game (bigger scope — needs auth + persistence; v2 milestone)
- Metadata title/description hardcoded to 2026 (same root cause as CP21, deferred there)
