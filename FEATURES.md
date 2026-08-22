# APEX — Feature Inventory

**What this app is.** APEX is a Formula 1 season hub: a dark, warm-orange "glassmorphism" web app that answers *when is the next race, who is winning, what happened last weekend, and who/what is on the grid*. It is built as a Next.js App Router frontend talking to a FastAPI backend, which in turn caches data from the Ergast API (via the Jolpica mirror), FastF1, and OpenF1 into MongoDB. There are thirteen navigable routes covering the calendar, per-race results down to individual practice sessions, both championship tables, driver and team profiles, circuit maps, a WebGL 3D elevation model for circuits with baked geometry, a strategy "Pitwall" view, a live-timing board, a 75-year cross-season heritage page, and a real-pace race replay with phone-as-second-screen pairing. A retrieval-grounded chat assistant runs alongside all of it as a panel rather than a route, served by a separate `f1-agent` Cloud Run service. Everything is read-only — there are no accounts, no writes, and no user-generated content. It self-describes in the footer as a "Concept prototype · not affiliated with Formula 1".

This document describes what is on `main` today. Anything present in the UI but non-functional is collected in [Known gaps](#known-gaps--not-yet-functional) rather than mixed in below.

---

## Route map

| Route | Purpose |
| --- | --- |
| `/` | Home — countdown to the next Grand Prix, season-at-a-glance stats, three highlight cards, links into the rest of the app |
| `/schedule` | Race calendar for a season, split into Upcoming / Completed |
| `/schedule/[season]/[round]` | Race weekend detail — per-session tabs, podium, full classification, circuit stats |
| `/schedule/[season]/[round]/pitwall` | Pitwall strategy lab — tyre stints, pit stops, lap-by-lap position/gap, race control, and a lap-indexed race replay |
| `/standings` | Drivers' and Constructors' championship tables |
| `/drivers` | The grid — a card per driver, each opening a profile modal |
| `/teams` | Constructor cards plus a power-unit grouping |
| `/circuits` | Featured track, cross-track "Circuit DNA" comparison, and a gallery of every circuit with detail modals |
| `/circuits/[circuitId]` | 3D elevation model of one circuit, rendered in WebGL. Any curated circuit works: one without a payload yet offers a "Generate 3D view" button that runs the elevation build on demand. A `circuitId` with no curated spec 404s |
| `/telemetry` | Live Timing board. Linked from the desktop nav as "Live"; not in the mobile bottom bar. **It has never rendered timing data in production** — see [Known gaps](#known-gaps--not-yet-functional) |
| `/watch` | Race replay index — pick a completed round to replay |
| `/watch/[raceId]` | Real-pace race replay: a lap-indexed timing tower that plays a finished race back at the speed it happened, plus phone-as-second-screen pairing |
| `/history` | F1 Heritage — the 75-Season Barcode (every championship race since 1950, one stripe per race, coloured by winning constructor) and the Constructor Genealogy (curated team-lineage timeline, e.g. Tyrrell→BAR→Honda→Brawn→Mercedes). Linked from the desktop nav as "History" (last item); not in the mobile bottom bar |

Two further routes exist and are deliberately **not** linked from anywhere: `/pitwall-chat` and `/agent-check`, both debugging surfaces for the chat agent. Each `page.tsx` carries a docblock explaining why it is kept. They are not features and are not documented below.

---

## Global chrome (present on every page)

**Top navigation bar** — sticky, translucent, blurred. On the left: the APEX wordmark with a glowing dot (links home) and nine desktop links — Home, Schedule, Watch, Standings, Drivers, Teams, Circuits, Live, History. The desktop bar turns on at ~900px rather than the `md` breakpoint, because at 768px the nine labels overflowed and "History" rendered as "Histor". The active link is marked with an orange underline that animates between items as you navigate. On the right: a functional search input (desktop `lg` and up — see below) and a "Season 2026" label.

**Global search** — the nav search box filters the current season's drivers, constructors, and circuits client-side (reusing the same standings/races/circuit-details data other pages already fetch) as you type, in a liquid-glass dropdown matching the compare-drivers/tire-stints popover pattern. Requires 2+ characters; shows a "No results" state otherwise. Selecting a driver or circuit opens that entity's existing modal (`driver-modal.tsx` / `circuit-details-modal.tsx`); selecting a team navigates to `/teams`. Escape and click-outside close it; respects `prefers-reduced-motion`.

**Mobile bottom bar** — replaces the desktop links below 1024px, and is the *only* navigation there, so anything missing from it is unreachable on a phone. Six icon+label items: Home, Schedule ("Races"), Watch, Standings ("Table"), Drivers, Circuits ("Tracks"). It stops at six because a seventh column puts a label under 48px at 390px; Teams, Live and History stay desktop-only and are reached from in-page links. Watch is present deliberately — it is the second-screen feature, designed for a phone propped against a television, and it previously had no way to be reached from one.

**Footer** — three labelled link groups (Project: About, FAQ, GitHub, Report a bug · Data: Data sources, AI disclosure · Legal: Privacy, Disclaimer, Attributions), above the APEX mark, "· F1 season hub", and an "Unofficial · not affiliated with Formula 1" line linking to `/disclaimer`. The info pages live here rather than in the main nav, which already overflowed its own container at nine links.

**Analytics** — Google Analytics 4 (`G-LFJ5KBBXD3`), loaded consent-first. Consent Mode v2 defaults are set to *denied for everyone* in a `beforeInteractive` script, before `gtag.js` is requested; visitors outside the EEA/UK are granted on mount, and EU/UK visitors (detected from the browser's IANA timezone, since a bare `run.app` URL has no geo headers) are shown a consent banner and stay denied until they answer. Page views are sent by hand with `send_page_view: false`, plus eight named events — `pitwall_panel_open`, `pitwall_message_sent`, `watch_replay_start`, `watch_pair_qr`, `circuit_3d_view`, `circuit_3d_generate`, `backend_unavailable`, `search_result_selected`. **No free text is ever sent**: the chat event is a bare count and the search event carries the result *kind*, never the query. With no `NEXT_PUBLIC_GA_MEASUREMENT_ID` the whole thing renders `null` — no script, no banner, no cookie.

**Consent banner** — EU/UK only, and never server-rendered (the server has no timezone, so a server-rendered banner would flash for every visitor on earth before hydration corrected it). Not a modal: it does not trap focus or block reading, and ignoring it leaves analytics off. Sits at `bottom-[76px]` on mobile so it clears the bottom bar, which is the only navigation below 1024px.

**Ambient treatment** — three fixed radial orange glows sit behind all content, and SVG displacement filters power the "liquid glass" card surfaces. Purely decorative.

**Page transitions** — every route fades in on arrival (opacity only). Lists and card grids cascade in with a stagger. All of this collapses to static rendering under `prefers-reduced-motion`, which is honoured throughout (card tilt, number count-ups, ring draw-ins, modal spring animations, and the hover/tap effects on circuit cards all check it).

**Loading skeletons** — `/standings`, `/schedule/[season]/[round]`, and the Pitwall page each render a pulsing glass-block skeleton matching their layout while their server data resolves.

**When the backend is offline** — every page catches its fetch failure and renders with empty data rather than erroring. Depending on the page you get an explicit message ("Driver standings are unavailable right now.", "No driver standings yet") or simply empty sections.

---

## Home (`/`)

**Hero.** A large countdown to the next Grand Prix. The kicker line shows "Round N" plus locality and circuit name; the race name is split so "Grand Prix" renders in the flame gradient. The countdown ticks every second across four segments (Days / Hours / Minutes / Seconds, seconds highlighted orange) and is followed by the target time rendered in the visitor's own locale and timezone, labelled "· your local time". If no dated race can be found it reads "Awaiting schedule".

Below the countdown, a "Next session" row lists up to four upcoming sessions of that weekend as chips (e.g. "FP1 · Fri 13:30"), the nearest one highlighted, each time converted to the visitor's local time.

The hero background carries a drifting-ember canvas and a warm spotlight that follows the cursor.

**"This season" stat card** (right of the hero, tilts toward the cursor in 3D):
- Header shows `done / total rounds`.
- Two animated progress rings that draw themselves in on first view: **Elapsed** (percentage of the season's rounds run) and **Title gap** (points between the championship leader and P2). Each ring has a small `info` button; hovering, focusing or tapping it opens a tooltip explaining the metric.
- Three rows underneath: Leader wins, Rounds completed, Rounds remaining.

**Three highlight cards** (bento row, each tilts on hover):
- **Championship leader** — name, team, and points (points spring-count up on first view). The driver's cutout photo fills the right of the card.
- **Last time out** — winner of the most recent completed round, their team, "<GP> · Win", and their finishing time on a chip dotted in the team colour.
- **Next circuit** — the circuit outline image, circuit name and country. This card is a link to that round's detail page (or to `/circuits` if no next race is known).

**Race-week glimpse** (between the hero and the bento row) — present *only* during a race weekend, from the first session's start until three days after the last. It shows the top three of the most recently classified session with team accents and the time that matters for that session type: best lap for practice, best segment for qualifying, race time and gaps for the race and sprint. A pulsing **LIVE** badge replaces the kicker while a session is actually running. If a session has run but its timing has not been published yet — routine on a Friday, since practice comes from FastF1 — it degrades to a line naming which sessions have run rather than reprinting the hero's session chips. Between weekends it renders nothing at all. The whole strip links to that round's detail page.

This replaced a "77 Seasons" barcode teaser, which was removed along with the ~1,200-race `historical_race_index` fetch that fed it — pulled on every home render for one decorative bar, with `/history` already in the nav.

**"Explore the season"** — four link tiles: Race calendar (with race count), Standings, Driver grid (with driver count), Teams.

Home is always pinned to the active season; it has no season selector.

---

## Schedule (`/schedule`)

Header reads "<year> FIA Formula One World Championship / Race Calendar", with a **season selector** (dropdown, 2018 → current season) that reloads the page via `?season=`.

**Sidebar** (sticky on large screens):
- An **Upcoming / Completed** toggle with an animated sliding pill. It defaults to Upcoming, except for a fully historical season with no upcoming race, which opens on Completed.
- A **Next event** card: race name, circuit · locality, and a days + hours countdown that refreshes every minute.

**Round list.** One row per race, re-cascading each time you flip the toggle. Each row shows: round number, date (`DD MMM`), country flag, race name, circuit · locality, and a status badge — *Next race* (orange, and the whole row is tinted orange), *Completed* (dimmed to 62% opacity), *Sprint*, or *Upcoming*. Completed rounds whose results are cached also show a 🏆 badge with the winner's three-letter code. Completed sprint weekends get an additional "Sprint" chip alongside the status badge. Every row links to that round's detail page. If a filter has nothing in it you get "No completed rounds yet." / "No upcoming rounds."

---

## Race weekend detail (`/schedule/[season]/[round]`)

**Header.** Status badge (*Completed* / *Next race* / *Upcoming*), "Round N · year", the race name with "GP" in the flame gradient, and circuit · locality, country. Three controls on the right: a **season selector** (jumps to round 1 of the chosen year), a **Grand Prix selector** listing every round in the season, and a "← Back to schedule" link.

**Circuit info bar.** Up to three tiles — Laps, Corners, Fastest Lap (time plus driver code). Only the stats FastF1 actually reports for that event are rendered; the whole bar disappears if none are available.

**Session tabs.** A "Race" tab is always present; Qualifying, Sprint Race, Sprint Quali, FP3, FP2 and FP1 tabs appear only for sessions this weekend's format actually has.

*Race tab, completed round with results:*
- **Podium row** — a winner card (team-coloured edge stripe, the driver's photo, name, team, total time), P2 and P3 rows (position, team colour bar, name, team, interval), and a **Fastest lap** card (lap time, driver, team, "Lap X / Y"). If no fastest lap was reported the card says "Not reported for this session."
- **AI Recap** — a glass card streaming in an LLM-written summary of the race, rendered as Markdown (bold driver names, paragraph structure). Grounded in a pre-computed fact bundle rather than raw results: the backend derives teammate pairings, positions gained/lost, retirements, the podium and the closest gaps in code, and pulls penalties, stewards' decisions and safety-car/VSC periods from OpenF1 race control — so the model narrates already-true statements instead of inferring them. Every claim carries an inline citation chip tying it to its source (`P3` for a classification row, `FL` for the fastest lap, `RC 66` for a race-control event on that lap), so any statement can be checked against the table below it. On the Race recap only, a race-control citation with a lap number is also a link into the Pitwall's race-replay module at that exact lap (`P3`/`FL`-style citations stay plain chips — they don't point anywhere). Generated once per race, then cached forever and replayed instantly; the cache is keyed by a prompt version so prompt changes retire stale recaps. Requires `OLLAMA_API_KEY` on the backend; without it, or if generation fails, the card doesn't render at all.

  The **Qualifying** and **Sprint** tabs carry their own recap cards (CP41). Sprint reuses the race fact bundle — it is a classified, points-scoring race — but gets a prompt that forbids narrating it as the Grand Prix. Qualifying gets a bundle of its own, because it has no gaps-to-leader, retirements or points, but does have three timed segments with an elimination at each boundary: `q3`/`q2_eliminated`/`q1_eliminated`/`no_time_set` resolve every driver's segment outcome, `gap_to_cutoff` says how narrowly each eliminated driver missed the line, and pole margin, session-long improvements and teammate head-to-heads are all computed in code. Its citations use segment form (`Q3 P4`, `Q1 P18`). Because qualifying must never be described in race vocabulary, the banned words ("podium", "won", "winner", "victory") are enforced by a Python validator that regenerates once on a violation rather than trusted to the prompt — so the qualifying card buffers its text instead of streaming it in token-by-token.
- **Full classification** table — position, driver (with team colour bar), team, interval, and points. P1 is highlighted orange; DNF/DNS/DSQ/RET intervals render in red; zero-point finishers are dimmed. Columns collapse on narrow screens.
- Above the table sits the **"Pitwall analysis"** call-to-action — a filled orange gradient button with a chart icon and an arrow that nudges right on hover, linking to the Pitwall sub-page.

*Race tab, completed round with no results yet:* "Results pending — This race has finished but results are not yet in the data feed. They usually sync within a few hours of the chequered flag."

*Race tab, upcoming round:* a **Weekend schedule** list instead — every session in the weekend with its date and local start time, the Race row tinted orange and labelled "Lights out", past sessions dimmed and labelled "Completed". Each row has an **"Add to calendar"** button opening a small popover with two options: a Google Calendar link (opens in a new tab, pre-filled with the session name, circuit as location, and correct duration) and a "Download .ics" file for any other calendar app.

*Any non-Race tab:* the session name with a Completed/Upcoming badge, three info tiles (Date, Local start time, Circuit), and — if the session has run and its classification is cached — a results table. Qualifying and Sprint Qualifying show **Q1 / Q2 / Q3** columns when segment times are available (Q3 highlighted); practice sessions show a **Best lap** column; everything else shows Time / status. If the session has finished but there is no classification: "Detailed classification for <session> is not available in the data feed." If the session isn't part of the weekend format: "<session> not scheduled".

---

## Pitwall (`/schedule/[season]/[round]/pitwall`)

Reached from the "Pitwall analysis" button on a completed round's full-classification table. Header reads "Telemetry lab / Pitwall **Strategy**" with the race name and round, plus a "← Back to race" link.

**Sidebar — "Analysis modules"**: six working modules — Tire Stints, Pit Stops, Lap Telemetry, Race Replay, Race Control, Strategy Commentary — switchable instantly (each panel is rendered server-side up front, so switching costs no extra fetch). Tire Stints, Pit Stops, and Lap Telemetry are sourced Mongo-first with a FastF1/Ergast self-heal rebuild on a miss (`race_stints`, `pit_stops`, `race_laps` respectively), each showing its own "not available yet" empty state — rather than an error — when the round hasn't been through the sync job. Race Control is sourced directly from OpenF1 (`/race_control`, resolved via a `/sessions` lookup by race date) rather than through the backend cache.

**Deep linking.** `?module=<id>` opens a specific module on load; `?lap=N` opens the Race Replay module (even without an explicit `?module=`) and scrubs straight to lap `N`. This is how a race-control citation on the main race page jumps into a specific replay moment (see AI Recap, above).

**Tyre stints chart.** A horizontal stacked bar chart, one row per driver, each bar segment a stint coloured by compound (Soft red, Medium yellow, Hard white, Intermediate green, Wet blue) with the X axis labelled "Lap number". A **"Compare drivers" dropdown** (multi-select, defaults to the top five finishers) and a compound legend sit above it. Hovering a bar opens a tooltip listing the driver's full name and every stint — "Stint 1: 15 laps (SOFT)". Deselecting everyone shows "Select at least one driver to view stints."

**Pit stops module.** Stat tiles (fastest / median / slowest / best crew average), a stacked horizontal bar of total pit-lane time per driver, and a sortable full-stop table. Suspension-length (red-flag) stops are excluded from the stat tiles and called out with a "N stops excluded" note, but still listed in the table.

**Lap Telemetry (position/gap chart).** A line chart, one line per selected driver in their team colour, X axis "Lap number". A segmented toggle switches the Y axis between **Position** (reversed so P1 sits at the top — the original view) and **Gap to leader** (seconds behind, also reversed so the leader sits at the top at 0s), reconstructed from each driver's cumulative lap times. Same multi-select driver dropdown as the stints chart. Hovering shows every selected driver's position or gap for that lap, sorted accordingly. Deselecting everyone shows "Select at least one driver to view positions." The Gap toggle is disabled with an explanatory note when a round's cached lap data predates this feature (no `gap_seconds` recorded yet) — Position mode still works for those rounds.

**When a module's data hasn't synced yet** (the FastF1-backed modules — Tire Stints and Lap Telemetry — depend on a local sync job, since FastF1's live-timing archive blocks Cloud Run), the panel shows an hourglass empty state — "Stint data not available yet" / "Lap data not available yet" — explaining that the data appears once the race has finished and been archived, with links back to the race results and schedule. Pit Stops sources from Ergast instead, which is reachable from Cloud Run, so its equivalent empty state ("Pit-stop data not available yet") means the round genuinely has no published stops yet, not a sync gap.

**Race Control module.** Stat tiles (total messages, flag changes, safety car / VSC periods, other notes) above a scrollable, filterable feed (All / Flags / Safety Car / Other) of every race-control message in session order — timestamp, lap number, and involved driver (team-coloured) alongside the message text. Flag and safety-car messages get colour-coded left icons (green/yellow/red/blue for flags, amber for safety car/VSC, neutral for investigations, penalties, and DRS notes) so the highest-signal events read at a glance. This populates for the current season: OpenF1 briefly paywalled its real-time-shaped endpoints for the whole current season, but that has lifted (verified 2026-07-29), so current-season rounds show real messages. When a session genuinely has no messages yet, the module shows a "Race control data not available yet" empty state rather than an error.

**Strategy Commentary module.** An LLM-generated, grounded narrative (2-3 short paragraphs) of a finished race's tyre and pit strategy — undercuts/overcuts that flipped track position between two drivers around their pit windows, drivers who ran a notably different stop count than the field, and the overall shape of the race's strategy (stop counts, compounds used). Every relational fact (whether a stop pair was an undercut or overcut, who ran an outlier strategy) is computed in Python from the already-cached `race_stints`/`pit_stops`/`race_laps` — never left for the model to infer, the same grounding discipline as the AI Recap. Reads only what's already cached (no FastF1/Ergast calls of its own, no self-heal), so it shows an empty state rather than triggering a sync on a miss. Generated once per race, cached forever, keyed by its own prompt version independent of the AI Recap's.

**Race Replay module.** A lap-indexed timing tower, not cars animating around a circuit — there is no GPS/coordinate data anywhere in this app, so this replays running order, gaps, tyres and race-control events lap by lap rather than car positions on track. Play/pause with 1×/2×/4× speed and the scrub track sit above the tower (dragging is 1:1 pointer tracking, updating on press rather than release; arrow keys step one lap at a time; tick marks show pit stops and notable race-control moments on the track itself). Below that, a running-order table (position, driver, tyre compound letter + age, gap-to-leader or "IN PIT") re-sorts as you move through the race, with pit stops highlighted on their lap. Every classified driver stays visible for the whole race even after they stop being individually tracked: a car finishing a lap down keeps its last known gap and tyre state through to the race's final lap rather than vanishing early, and a retiree is shown dimmed at the bottom of the order with a "RETIRED" label instead of a live gap, rather than disappearing outright. Race-control events (penalties, investigations, safety car, red flag) for the current lap show as labelled chips beneath the tower — tone (amber vs. red) separates a cleared investigation from something that actually cost time. Sourced from a single backend endpoint that joins `race_laps`, `race_stints`, `pit_stops` and race control into one lap-keyed payload server-side — `pit_stops` identifies drivers by an Ergast slug (`"albon"`) while the lap/stint data uses a car number (`23`), a join with a silent-failure mode (wrong or missing pit markers, no error) that would be easy to get wrong per-caller, so it's resolved once in the backend instead. An unsynced round shows "Replay not available" rather than an error.

---

## Standings (`/standings`)

Header: "Season <year> · Championship / Championship", a **Drivers / Constructors** tab pair with an animated sliding pill, and a **season selector**.

**Drivers tab** — a row per driver, cascading in: position (P1 highlighted orange with a tinted, orange-bordered row), a glowing team-colour bar, the driver's photo, name, team, wins, and points. Points spring-count up the first time each row scrolls into view. Beside the list, a sticky sidebar stacks three panels: **"Constructor battle"**, showing the top five constructors as horizontal bars filled in team colours sized to their share of the leader's points; **"Teammate battle"**, showing each team's two highest-scoring drivers head-to-head on race finishing position across every round they've both raced this season (a split bar plus an "N-M" score); and **"Title Decider"**, reporting whether the Drivers' and Constructors' championships are still mathematically open — the points gap between P1 and P2, the maximum points still available across remaining rounds (accounting for sprint weekends and a fastest-lap bonus point), and either "mathematically clinched" or how many more points the leader needs (or a runner-up slip) to seal it. All three are computed client-side from cached race/season data — no extra backend calls, and framed as arithmetic on the current gap rather than a prediction.

**Constructors tab** — a card per team: position, team-colour bar, team name, nationality, wins, points (count-up), and a full-width points bar filled with a team-colour gradient, sized relative to the leader.

Empty states: "No driver standings yet" / "No constructor standings yet" / "No constructor data yet".

---

## Drivers (`/drivers`)

Header: "<year> World Championship lineup / The Grid" with a **season selector**.

**Compare drivers panel** — two dropdowns (any driver vs any other) and a "Compare" button open a modal with both drivers' current-season Position/Points/Wins side by side, plus two computed head-to-head splits across every round they both raced: race finishing position, and qualifying pace (comparing whichever Q-segment — Q3, falling back to Q2 then Q1 — both drivers actually reached that round, with the average time gap). Entirely derived client-side from cached race and qualifying results. Below those splits, an **LLM-generated head-to-head narrative** streams in from a dedicated backend endpoint that ports the same comparison logic into Python (`driver_comparison_recap.py`), so the narrative's counts always agree with the numbers shown above it — grounded, never left for the model to tally. Since a driver's season stats shift every round (unlike a finished race), the cache key folds in how many rounds the pair has shared so far rather than caching forever.

**Grid of driver cards** (4 across on large screens), each tilting toward the cursor with a specular glare. A card carries: a team-colour stripe along the top, the driver's permanent number as a huge translucent watermark, the driver's cutout photo, their nationality flag, team name, given name, family name, and a footer with Wins / Pts / Pos (position highlighted) plus a progress bar showing their points relative to the leader.

**Clicking a card opens the driver modal**, with the driver's photo animating smoothly from the card into the modal (shared-element transition). The modal shows:
- Nationality flag, team, full name.
- Current season tiles: Position, Points, Season wins.
- A **Career** block, fetched when the modal opens: Wins, Podiums, Poles, Titles as four tiles, then nationality, date of birth with computed age, and a "Wikipedia →" external link. Four pulsing placeholders show while it loads; if the fetch fails the block reads "Career stats unavailable right now."

The modal closes on the × button, a click on the backdrop, or Escape. Page scroll is locked while it is open.

If standings are unavailable: "Driver standings are unavailable right now."

---

## Teams (`/teams`)

Header: "Constructor standings <year> / Teams & Chassis" with a **season selector**.

**Team cards**, two across, each tilting on hover with a team-coloured corner wash and a blurred colour blob. Each card shows team name, nationality, a "Power · <engine>" chip, and Position / Wins / Season pts. The team's logo appears on a light rounded plate; teams without a freely-licensed logo (Ferrari, Red Bull, Racing Bulls) fall back to a two-letter monogram on a team-colour tile.

**Heritage & lineage**, behind a per-card disclosure, collapsed by default. The trigger is not a bare chevron — it carries the three facts most likely to make someone open it ("Since 2010 · 162 all-time wins · 5 names"), so the collapsed state is an answer rather than a promise of one. Opening it reveals, in place: the team record (on the grid since, Grand Prix wins, Constructors' and Drivers' titles, each labelled as lineage-wide or current-era), the base location and a one-line profile, and the era chain as selectable chips — Tyrrell → BAR → Honda → Brawn → Mercedes — with a panel for the selected era showing its span, seasons, wins, titles and the rename story. Computed values and hand-authored ones are deliberately kept apart in the markup and labelled as such. Expanding one card does not stretch its row-mate.

Below the cards: an attribution line linking to Wikimedia Commons and the CC BY 4.0 licence for the Aston Martin logo (opens in a new tab). The Circuits page carries an equivalent attribution for the Saudi Arabia (Jeddah) circuit outline, licensed CC BY-SA 3.0 (the Bahrain outline is public domain and needs none).

**Power units** — a tile per engine supplier (Red Bull Ford, Mercedes-AMG, Ferrari, Honda, Renault, Audi) listing the teams that run it. Assignments reflect the 2026 rules-reset supplier changes: Alpine switched from Renault to Mercedes power units for 2026 (the lookup is season-aware so pre-2026 seasons still show Renault); Sauber ran Ferrari for its entire modern history through its rename to Audi for 2026, when it became a works Audi entry; Cadillac (new 2026 entrant) runs as a Ferrari customer.

Empty state: "Constructor standings are unavailable right now."

---

## Circuits (`/circuits`)

**Featured track** — a large panel showing the circuit outline of the next upcoming round (or the season opener if none is upcoming), badged "Featured track", with "Round N · <locality>" and the circuit name.

**Circuit DNA** panel — a real cross-track comparison, not a season summary. Two liquid-glass dropdown selectors (only circuits with cached circuit details are selectable) pick two tracks; selecting both opens a comparison modal showing country, total laps, corner count, and lap record (time + holder) for each side by side, plus first-raced / most-wins / closest-finish rows when that cross-season data exists for the circuit (same source as the circuit history panel below).

**World tour gallery** — a card per round with an accent stripe from a rotating palette, locality, country flag, circuit name, the circuit outline image, and country / round. Cards lift on hover and press on tap.

**Clicking a card opens the circuit modal**: flag, "Round N · <country>", circuit name, Grand Prix name, the track map, and up to four stat tiles — Laps, Corners, First GP, and Lap record (highlighted). Only stats the sync actually recorded are shown; if there are none, "No track data recorded for this circuit yet."

Below the stat tiles, a **"Circuit history" panel** shows up to three cross-season facts for that physical circuit, sourced from Ergast/Jolpica's full result history (not just whichever seasons this app's own sync job happens to have cached) and cached backend-side for up to a day: First raced (earliest season a race was held there), Most wins (the driver with the most victories there, with a count), and Closest finish (the smallest P1→P2 race-time gap ever recorded there, with the season it happened). Each fact is independently shown only if Ergast has it; the whole panel is omitted if the circuit has never been synced at all (no cached round to resolve its Ergast `circuitId` from).

The map inside the modal has an **expand button** that opens a full-screen lightbox of the track layout. Escape closes the lightbox first and the modal on a second press; both also close on backdrop click or their × button.

**Cards with no cached circuit detail are not clickable** — they render normally but do nothing, because there is no detail record to show. This is why the gallery feels partly inert early in a season.

This page has no season selector; it always shows the active season.

---

## 3D elevation viewer (`/circuits/[circuitId]`)

A WebGL model of one circuit built from its real centreline and an open elevation model — elevation being the one thing a 2D outline cannot convey, and much of why Eau Rouge, COTA's Turn 1 and the Interlagos bowl matter.

**Any circuit on the calendar can be generated on demand, by anyone.** All 22 are curated in `scripts/trackgeo/curated.py`; a circuit without a payload yet shows a "Generate 3D view" button instead of the viewer. Clicking it runs the real elevation pipeline as a Cloud Run Job, which writes `gs://f1-scratch-assets/tracks/<key>.json` and reports its phase and percentage into Mongo as it works — so the loader shows what is actually happening ("Sampling elevation data…", "Aligning racing line…"), not a fake progress bar. A build takes roughly a minute. It only ever has to happen once: the payload is permanent and every later visitor loads it instantly.

**One build runs at a time, globally**, behind an atomic Mongo lock. A second click while another circuit is building is told which circuit is in the way rather than being queued — OpenTopoData is a courtesy-rate public service, and the daily call budget is shared by everyone using the site.

A circuit with no curated `CircuitSpec` at all 404s rather than rendering an empty scene. Curation is still a repo change: the spec carries the researched upstream feature id, DEM dataset, rotation and any corner names, so "generate" means *run the elevation build for a circuit already curated*, never *invent one from an id*.

**The four Batch 15 circuits (Spa, Austin, Interlagos, Zandvoort) also ship bundled** inside the frontend image and are treated as ready even if the bucket listing fails, so a degraded listing can never take working circuits offline.

**The scene** is a track ribbon with kerbs, DEM terrain with topographic contours, the TUMFTM optimal racing line, instanced elevation posts dropping to the datum, a gradient sky dome and drifting embers matching the app's hero treatment. Bloom and vignette are decorative and are switched off under sustained load by `PerformanceMonitor`, along with terrain and posts.

**Vertical exaggeration defaults to 2× and is always labelled on screen** — 100 m over a 7 km lap is a 1.5% slope and reads as dead flat at true scale. Track width carries a separate, also-labelled 3× presentation multiplier, since a true 13.5 m road is about four pixels wide at whole-circuit framing. A 1:1 button returns both to reality.

**Camera**: four presets (three-quarter, overhead, profile, driver eye) with interruptible transitions — a drag or an arrow key always cancels an in-flight tween. Arrow keys orbit, `+`/`-` zoom, `1`-`4` pick a preset, `F` flies a lap, and Space stops a running tour. Wheel zoom stays off until the canvas is clicked, so the page can still be scrolled past the viewer.

**Guided motion** comes in three forms. **Fly the lap** runs the whole circuit from the current playhead, with a live panel showing the nearest named corner and distance covered. **Clicking a named corner or a highlight card** flies just that stretch. Both ease onto the track over ~1.15 s before moving off, ramp up from a standstill, and brake out at the end rather than cutting. **Scrubbing the elevation profile** walks the camera along the lap while preserving the viewer's own angle and zoom — it moves the orbit target, not the whole pose. This can be turned off with the "Follow scrub" toggle. Hovering the 3D ribbon moves the profile playhead but deliberately does *not* move the camera.

**Named corner markers** are curated per circuit and snapped at build time to the nearest detected curvature apex. They sit on pins above the tarmac, are hidden when terrain is physically in front of them, and are nudged into free rows when they would overlap each other, so no name is ever lost to crowding. Clicking one flies that corner. This is deliberately not official corner numbering — raw curvature peaks and F1's numbering disagree structurally (Spa detects 30 apexes against 19 numbered corners, because official numbering merges multi-apex complexes).

**The elevation profile strip** below the scene is a hand-rolled SVG showing the full lap, with shaded bands for each named highlight and a draggable playhead. Highlight cards underneath give the climb or drop in metres, the gradient, and a one-line blurb.

**Without WebGL**, the page falls back to the static circuit outline plus a fully working elevation profile — the numbers are the content, the 3D is the presentation. Screen readers get the elevation figures and every highlight as text rather than a canvas. Under `prefers-reduced-motion` the intro flight and flythroughs resolve without animating.

**Provenance is stated on the page**: centrelines from `bacinger/f1-circuits` (MIT), elevation from OpenTopoData (EU-DEM / NED / SRTM), widths and racing line from `TUMFTM/racetrack-database`, and banking curated from published figures — a 25 m elevation grid cannot resolve camber across a 15 m road. A badge shows the source dataset and a confidence grade for each circuit.

---

## Live Timing (`/telemetry`)

**This page does not work, and never has in production.** It is documented here because it is in the navigation, not because it functions. See [Known gaps](#known-gaps--not-yet-functional) for the diagnosis.

Linked from the desktop nav as "Live", after Circuits; excluded from the mobile bottom bar, so it is unreachable on a phone.

**What does work.** The header reads "APEX Live / Live Timing" with the current session name and a **Live** pill (pulsing red dot) or a **Standby** pill, plus a link to the schedule. Whether a session is live is derived from the season calendar plus *assumed* session durations (FP 60 min, "Sprint Shootout" 45, Sprint 30, Qualifying 60, Race 120) — several of which are wrong, so the page can drop to Standby part-way through a real session. The race list refreshes every 60 seconds and the clock ticks every second. When nothing is live it names the next session and its local time. That countdown is accurate and is the only part of the page carrying real information.

**What does not.** The timing table — Pos, No, Driver, Gap, Interval, Last Lap, three sector bars, tyre compound and age, and a PIT/DRS/RUN status column — is coded and has never rendered a row in production. It was built against a paid RapidAPI feed whose key was never provisioned. Measured 2026-08-21: roughly three-quarters of the page is empty background in its normal state, and 0 of 20 driver rows render in every state, live or not.

The idle copy ("Live timing polling is paused because no session is currently active") implies a feed that resumes when a session starts. It does not. The honest string — "Live timing isn't available in this environment yet" — is only reachable *during* a live session.

---

## Race replay (`/watch`, `/watch/[raceId]`)

`/watch` lists completed rounds to replay. `/watch/[raceId]` plays one back **at the pace it actually happened**: a clock advances in real time and a timing tower re-orders itself at each crossing, rather than animating cars on a track — this app has no position data, and the module says so rather than inventing it.

Built on the official lap record. Positions, gaps and intervals are exact at every crossing and OpenF1's fill is corrected there; a carried-forward sample used to go stale during long stops and safety cars, which is why the correction exists. The `PIT` state is keyed on the driver's *own* lap rather than the leader's, so a long stop keeps its flag.

Controls include play/pause, speed, a scrub, driver favourites and density modes. A screen wake lock keeps a phone or laptop awake through a replay. Preferences sync across tabs via a `storage` listener. A round with no replay data reports that rather than showing an empty tower.

**Second-screen pairing.** A phone and a laptop can run one replay in step: the host shows a QR code, the phone scans it, and both confirm the pairing. What syncs is a command and an anchor, not a playhead — so the two clocks stay in step without either one dragging the other.

---

## The Pitwall Assistant (a panel, not a route)

A retrieval-grounded chat assistant available across the app, served by the separate `f1-agent` Cloud Run service over SSE. It answers questions about this app's own data.

- **Grounded, and shows its work.** Answers carry citation pills with human titles and kind tags; clicking one opens an inspectable popover, and the cited value in the prose *is* the citation anchor. A per-step activity timeline shows what the agent did.
- **Verified before display.** A deterministic verifier checks claims against the evidence ledger before an answer is shown; predictive and subjective questions are held to a framing contract enforced by the verifier rather than by prompt wording.
- **Guarded on both sides.** Scope, injection and PII checks on input; output guards on every tier. Untrusted web content fetched via Tavily is quarantined from instruction-following.
- **Rate limited and budgeted.** A Mongo-backed daily cost cap plus cost-weighted per-caller and per-subnet buckets on a composite identity, charged in run-cost units rather than request counts, with a kill switch.
- Retry, regenerate, copy, a "New chat" control, contextual suggestion chips validated by the router, an SSE heartbeat, and focus-trap accessibility.

Its design is documented at length in `CHAT-AGENT-PLAN.md`.

---

## F1 Heritage (`/history`)

Linked from the desktop nav as "History", the last item; deliberately excluded from the mobile bottom bar, which stays at its 5-item ceiling (reachable there via a teaser on Home instead — see below). Header states the season span and total race count ("1160 championship races, 1950–2026 …") pulled live from the backend.

**The 75-Season Barcode** — every F1 championship race since 1950 as one thin vertical stripe in a single scaling SVG, coloured by winning constructor, 1950 on the left and the present on the right. Hovering or tapping a stripe opens a tooltip with the race name, year, winning driver and constructor; the four Indianapolis-500-only constructors (`kurtis_kraft`, `epperly`, `kuzma`, `watson` — the 1950-1960 Indy 500 counted toward the World Championship despite never being a Grand Prix) render as a visually distinct muted chrome with a tooltip explaining why they're there rather than looking like unexplained one-off colours. A legend of the top constructors by win count plus a dedicated "Indy 500" entry lets you hover (or tap-pin, for touch) to isolate one constructor's stripes across all 75 years — this is what makes eras like the unbroken 2014-2021 Mercedes run or the single-season 2009 Brawn cluster legible as a pattern. The active season's unraced remaining rounds render as hatched "ghost slots" rather than the barcode just stopping abruptly. Stripes reveal left-to-right on scroll-into-view; fully respects `prefers-reduced-motion`. A compact, non-interactive version of the same barcode appears as a full-width teaser strip on Home, linking through to this page.

**Constructor Genealogy** — a hand-rolled horizontal band timeline (1950-present, no charting library) of 15 curated team lineages, each node's active-year span resolved live from the backend rather than hand-typed: Tyrrell→BAR→Honda→Brawn→Mercedes, Jordan→Midland→Spyker→Force India→Racing Point→Aston Martin, Sauber→BMW Sauber→Sauber→Alfa Romeo Racing→Kick Sauber→Audi, Minardi→Toro Rosso→AlphaTauri→RB, Stewart→Jaguar→Red Bull, Benetton→Renault→Lotus F1 Team→Renault→Alpine, plus single-node lineages (Ferrari, McLaren, Williams, Brabham, classic Lotus, Cooper, BRM, Vanwall) shown as unbroken bands for contrast. Every rename is marked directly on the band with a visible divider and year label, not hidden in a tooltip. Hovering a lineage dims all others to ~15% opacity; clicking a band segment opens a liquid-glass popover with years active and a one-line note on why the team was renamed.

Both visualisations source their colours from a single canonical constructor-identity map (`frontend/src/lib/constructor-identity.ts`) that defers to the same team-colour map `/standings` and `/teams` use for any constructor still on the grid, so a team's colour never disagrees between this page and the rest of the app.

---

## Cross-cutting behaviour

**Season selection.** A shared dropdown offering every year from 2018 to the current season appears on Schedule, Standings, Drivers, Teams and the race-detail page. On most pages it sets `?season=<year>`; on the race-detail page it navigates to round 1 of the chosen year. Out-of-range or unparseable `?season=` values are clamped rather than passed to the backend. Home and Circuits are always pinned to the active season. The page `<title>` and meta description on Schedule, race-detail, Standings, Drivers and Teams reflect whichever season is actually being viewed (e.g. "APEX | 2023 F1 Season Hub"), falling back to the active season when none is selected; Home and Circuits keep the root layout's active-season metadata.

**Graceful degradation on images.** This is the main reason a page can look different at different times:
- **Driver photos** exist for 22 named drivers. Any driver not in that set renders the "APEX hatch" — a dark diagonal-stripe placeholder, labelled `// CUTOUT` on driver cards, `// DRIVER CUTOUT` on the home bento, `// WINNER` on the race winner card.
- **Circuit outlines** are mapped by locality/country. Unmapped circuits, or a missing/failed asset, fall back to the hatch with a `// TRACK MAP` label.
- **Flags** are mapped from nationality and country strings; an unmapped or failed flag simply disappears, leaving the neutral chip behind rather than a broken-image icon.
- **Team logos** exist for 8 of the 11 teams; the rest use a colour + monogram tile.
- Driver photos, circuit outlines, flags and team logos are all served from `NEXT_PUBLIC_ASSET_BASE_URL` when it is set (driver photos and flags are also bundled under `frontend/public`); circuit and team images exist only on that asset host, so with no asset base configured those two fall back to hatch/monogram everywhere.

**"Not cached yet" states.** Most of the backend is Mongo-first with a live upstream fallback, populated by an hourly sync job. Where the cache is cold the UI says so rather than showing nothing: results-pending on a just-finished race, "not available in the data feed" for a missing session classification, "No track data recorded for this circuit yet", disabled circuit cards, an absent 🏆 winner badge on the schedule, and a missing circuit info bar on the race page.

**Team colours** are resolved from a single canonical map by case-insensitive substring match, so they survive the various constructor names the API returns ("RB F1 Team", "Kick Sauber", "Aston Martin Aramco"). Anything unmatched gets the APEX flame orange.

---

## Data the UI actually consumes

| Backend endpoint | Feeds |
| --- | --- |
| `GET /api/races` | Home, Schedule, race detail, Pitwall, Circuits, Live Timing — the season calendar, with each completed round's winner attached |
| `GET /api/driverstandings` | Home, Standings, Drivers |
| `GET /api/constructorstandings` | Standings, Teams |
| `GET /api/race_results` | Home ("Last time out"), race detail podium + classification, Pitwall driver list |
| `GET /api/qualifying_results` | Race detail — Qualifying tab |
| `GET /api/sprint_results` | Race detail — Sprint tab |
| `GET /api/session_classification` | Race detail — FP1 / FP2 / FP3 / Sprint Quali tabs |
| `GET /api/circuit_info` | Race detail — Laps / Corners / Fastest Lap bar |
| `GET /api/circuit_details` | Circuits gallery and its detail modals |
| `GET /api/circuit_history` | Circuits detail modal — Circuit history panel (first raced, most wins, closest finish) |
| `GET /api/driver_bio` | Driver modal — career wins, podiums, poles, titles, DOB, Wikipedia link |
| `GET /api/session_recap` | Race detail page — AI Recap card, on the Race, Qualifying and Sprint tabs (`?session=`, defaulting to `race`). Streams Markdown rather than JSON; builds a grounded fact bundle from the matching results collection plus OpenF1 race control, then calls Ollama Cloud on a cache miss |
| `GET /api/race_replay` | Pitwall — Race Replay module. Lap-indexed payload joining `race_laps`, `race_stints`, `pit_stops` and race control server-side |
| `GET /api/strategy_commentary` | Pitwall — Strategy Commentary module. Streams Markdown; reads only already-cached `race_stints`/`pit_stops`/`race_laps`/`race_results`, no self-heal |
| `GET /api/driver_comparison_recap` | Drivers — compare-drivers modal's head-to-head narrative. Streams Markdown; reads cached standings/race/qualifying results |
| `GET /api/historical_race_index` | History — the 75-Season Barcode and its Home-page teaser. Every championship race 1950-present, one normalised winner record per race (constructor identity already de-duplicated/normalised server-side); Mongo-first, backfilled once then topped up per-season by `data_sync.py` |
| `GET /api/constructor_seasons` | History — Constructor Genealogy. Active-year span for one raw Ergast constructorId, resolving each curated lineage node's real band width rather than a hand-typed year range |
| `GET /health` | Not used by the UI (deployment health check) |

The 3D elevation viewer's **geometry** is still not an API response: it is a JSON payload per circuit fetched client-side straight from `gs://f1-scratch-assets/tracks/`, so the browser and CDN cache it — inlining a 26-63 KB payload into the RSC stream on every navigation would be worse. The route also reads `/api/races` for the circuit's name and round.

Its **control plane** is three endpoints, which only ever start and observe builds — never build anything themselves:

| Endpoint | Used by |
|---|---|
| `GET /api/track_geometry/available` | Which circuits have a payload, and which are curated and therefore buildable. Replaces what used to be a hardcoded frontend list, so a newly built circuit needs no redeploy to appear |
| `POST /api/track_geometry/build` | "Generate 3D view". `202` with the status doc, or `409` naming the circuit already building |
| `GET /api/track_geometry/status` | The loader's poll, returning the job's own `phase`/`progress_pct`/`message` verbatim |

**The bucket needs a CORS policy**, not just public-read. The payload is read with `fetch()` (unlike the image assets beside it, loaded via `<img>`, which are exempt), so a bucket without CORS serves the JSON fine to `curl` and blocks it in every browser — presenting as "Track geometry unavailable" for a payload that is demonstrably present. See `scripts/README.md`.

Three data sources are called directly from the frontend rather than through the backend: **OpenF1** (`/sessions`, `/stints`, server-side, for the Pitwall chart; `/sessions`, `/race_control`, server-side, for the Pitwall Race Control module) and a **RapidAPI live-timing feed** (client-side, for `/telemetry`).

---

## Known gaps / not yet functional

These exist in the shipped UI but do not work, or do not work as their label implies.

- **`/telemetry` has never rendered a row of timing data in production, and cannot without a rebuild.** Diagnosed 2026-08-21. It calls a paid RapidAPI feed (`f1-live-pulse`) directly from the browser, and `_NEXT_PUBLIC_RAPIDAPI_KEY` defaults to an empty string in `cloudbuild-frontend.yaml` so builds do not fail. Next inlines `NEXT_PUBLIC_*` at **build** time, so the deployed bundle contains the dead-code-eliminated stub — `isLiveTimingConfigured` compiles to `function f(){return!1}` and the fetch is not in the shipped JavaScript at all. Setting the variable at runtime on Cloud Run would therefore change nothing. Calling the nav item "Live" is not accurate and never has been.
- **Session live/standby windows are guessed, not sourced.** `frontend/src/lib/sessions.ts` hardcodes durations and some are wrong — `Sprint: 30` against a real 60-minute window at Zandvoort, `SprintQualifying: 45` against 44 — so a live session can be treated as over halfway through, and a red-flagged session overruns the assumption entirely. The label "Sprint Shootout" is also F1's pre-2024 name.
- **Practice and sprint-qualifying classification can be missing for a round.** FastF1's upstream intermittently refuses Google Cloud Run IP ranges and fails *soft* — empty streams, no error — so the hourly sync cannot be relied on for any specific round. Running `python -m app.data_sync` from a local machine is the documented remedy. (Separately, a bug that made *every* practice classification roughly two days late was fixed on 2026-08-21: session-scoped syncs were gated on the race having started rather than on the session having finished.)
- **`backend/app/strategy_whatif.py` is experimental, unrouted, and fails its own accuracy gate.** It is not reachable from the UI and is not a feature. Asked to move a pit stop to the lap it already happened on, it reproduces the real finishing position for only 51% of clean finishers. Details in `ROADMAP.md`.
- **Season selectors offer 2018 onward, but data quality drops off sharply.** The range is fixed at `MIN_SUPPORTED_SEASON = 2018` regardless of what is actually cached; older seasons will show calendars and standings but largely empty session classifications, circuit details, and no Pitwall data.
- **Pitwall Race Control's OpenF1 paywall has lifted.** This was previously documented as a hard gap — OpenF1 returned 401 for the entire current season, so the module always showed its empty state. As of 2026-07-29 `GET /v1/sessions?year=2026` and `/race_control` both return 200 with full data (verified against the Hungarian GP: 80 messages including penalties, VSC periods and stewards' decisions). The module should now populate for current-season rounds; if it looks empty, suspect a caching window rather than the paywall.

---

*Written from the code on `main`, refreshed 2026-08-21. The repo's `DESIGN-CONTEXT.md` is stale — it describes an obsolete cyan/magenta theme that no longer exists — and was not used as a source here.*
