# APEX — Feature Inventory

**What this app is.** APEX is a Formula 1 season hub: a dark, warm-orange "glassmorphism" web app that answers *when is the next race, who is winning, what happened last weekend, and who/what is on the grid*. It is built as a Next.js App Router frontend talking to a FastAPI backend, which in turn caches data from the Ergast API (via the Jolpica mirror), FastF1, and OpenF1 into MongoDB. There are eight user-facing routes covering the calendar, per-race results down to individual practice sessions, both championship tables, driver and team profiles, circuit maps, a strategy "Pitwall" view, and a live-timing board. Everything is read-only — there are no accounts, no writes, and no user-generated content. It self-describes in the footer as a "Concept prototype · not affiliated with Formula 1".

This document describes what is on `main` today. Anything present in the UI but non-functional is collected in [Known gaps](#known-gaps--not-yet-functional) rather than mixed in below.

---

## Route map

| Route | Purpose |
| --- | --- |
| `/` | Home — countdown to the next Grand Prix, season-at-a-glance stats, three highlight cards, links into the rest of the app |
| `/schedule` | Race calendar for a season, split into Upcoming / Completed |
| `/schedule/[season]/[round]` | Race weekend detail — per-session tabs, podium, full classification, circuit stats |
| `/schedule/[season]/[round]/pitwall` | Pitwall strategy lab — tyre-stint comparison chart |
| `/standings` | Drivers' and Constructors' championship tables |
| `/drivers` | The grid — a card per driver, each opening a profile modal |
| `/teams` | Constructor cards plus a power-unit grouping |
| `/circuits` | Featured track, cross-track "Circuit DNA" comparison, and a gallery of every circuit with detail modals |
| `/telemetry` | Live Timing board (polls a third-party feed while a session is running). Linked from the desktop nav as "Live" (last item); not in the mobile bottom bar |

---

## Global chrome (present on every page)

**Top navigation bar** — sticky, translucent, blurred. On the left: the APEX wordmark with a glowing dot (links home) and six desktop links — Home, Schedule, Standings, Drivers, Teams, Circuits. The active link is marked with an orange underline that animates between items as you navigate. On the right: a functional search input (desktop `lg` and up — see below) and a "Season 2026" label.

**Global search** — the nav search box filters the current season's drivers, constructors, and circuits client-side (reusing the same standings/races/circuit-details data other pages already fetch) as you type, in a liquid-glass dropdown matching the compare-drivers/tire-stints popover pattern. Requires 2+ characters; shows a "No results" state otherwise. Selecting a driver or circuit opens that entity's existing modal (`driver-modal.tsx` / `circuit-details-modal.tsx`); selecting a team navigates to `/teams`. Escape and click-outside close it; respects `prefers-reduced-motion`.

**Mobile bottom bar** — replaces the desktop links below the `md` breakpoint. Five icon+label items: Home, Schedule, Standings, Drivers, Circuits. Teams is not in the mobile bar.

**Footer** — the APEX mark, "· 2026 F1 season hub", "Concept prototype · not affiliated with Formula 1", and a link to the project's GitHub repo (opens in a new tab).

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
- **AI Recap** — a glass card labelled "AI Recap" with a small pulsing dot while generating, streaming in an LLM-written summary of the race (who won, the closest battles, notable retirements, the fastest lap) grounded strictly in the cached classification data, with a "Generated commentary from race data · not official reporting" disclaimer beneath it. Generated once per race on the first request after it finishes, then cached forever and replayed instantly for every request after that. Requires `OLLAMA_API_KEY` to be configured on the backend (Ollama Cloud); without it, or if generation fails, the card simply doesn't render — same "omit rather than error" pattern as everything else in this app.
- **Full classification** table — position, driver (with team colour bar), team, interval, and points. P1 is highlighted orange; DNF/DNS/DSQ/RET intervals render in red; zero-point finishers are dimmed. Columns collapse on narrow screens.
- Above the table sits the **"Pitwall analysis"** call-to-action — a filled orange gradient button with a chart icon and an arrow that nudges right on hover, linking to the Pitwall sub-page.

*Race tab, completed round with no results yet:* "Results pending — This race has finished but results are not yet in the data feed. They usually sync within a few hours of the chequered flag."

*Race tab, upcoming round:* a **Weekend schedule** list instead — every session in the weekend with its date and local start time, the Race row tinted orange and labelled "Lights out", past sessions dimmed and labelled "Completed". Each row has an **"Add to calendar"** button opening a small popover with two options: a Google Calendar link (opens in a new tab, pre-filled with the session name, circuit as location, and correct duration) and a "Download .ics" file for any other calendar app.

*Any non-Race tab:* the session name with a Completed/Upcoming badge, three info tiles (Date, Local start time, Circuit), and — if the session has run and its classification is cached — a results table. Qualifying and Sprint Qualifying show **Q1 / Q2 / Q3** columns when segment times are available (Q3 highlighted); practice sessions show a **Best lap** column; everything else shows Time / status. If the session has finished but there is no classification: "Detailed classification for <session> is not available in the data feed." If the session isn't part of the weekend format: "<session> not scheduled".

---

## Pitwall (`/schedule/[season]/[round]/pitwall`)

Reached from the "Pitwall analysis" button on a completed round's full-classification table. Header reads "Telemetry lab / Pitwall **Strategy**" with the race name and round, plus a "← Back to race" link.

**Sidebar — "Analysis modules"**: four working modules — Tire Stints, Pit Stops, Lap Telemetry, Race Control — switchable instantly (each panel is rendered server-side up front, so switching costs no extra fetch). Tire Stints, Pit Stops, and Lap Telemetry are sourced Mongo-first with a FastF1/Ergast self-heal rebuild on a miss (`race_stints`, `pit_stops`, `race_laps` respectively), each showing its own "not available yet" empty state — rather than an error — when the round hasn't been through the sync job. Race Control is sourced directly from OpenF1 (`/race_control`, resolved via a `/sessions` lookup by race date) rather than through the backend cache.

**Tyre stints chart.** A horizontal stacked bar chart, one row per driver, each bar segment a stint coloured by compound (Soft red, Medium yellow, Hard white, Intermediate green, Wet blue) with the X axis labelled "Lap number". A **"Compare drivers" dropdown** (multi-select, defaults to the top five finishers) and a compound legend sit above it. Hovering a bar opens a tooltip listing the driver's full name and every stint — "Stint 1: 15 laps (SOFT)". Deselecting everyone shows "Select at least one driver to view stints."

**Pit stops module.** Stat tiles (fastest / median / slowest / best crew average), a stacked horizontal bar of total pit-lane time per driver, and a sortable full-stop table. Suspension-length (red-flag) stops are excluded from the stat tiles and called out with a "N stops excluded" note, but still listed in the table.

**Lap Telemetry (position/gap chart).** A line chart, one line per selected driver in their team colour, X axis "Lap number". A segmented toggle switches the Y axis between **Position** (reversed so P1 sits at the top — the original view) and **Gap to leader** (seconds behind, also reversed so the leader sits at the top at 0s), reconstructed from each driver's cumulative lap times. Same multi-select driver dropdown as the stints chart. Hovering shows every selected driver's position or gap for that lap, sorted accordingly. Deselecting everyone shows "Select at least one driver to view positions." The Gap toggle is disabled with an explanatory note when a round's cached lap data predates this feature (no `gap_seconds` recorded yet) — Position mode still works for those rounds.

**When a module's data hasn't synced yet** (the FastF1-backed modules — Tire Stints and Lap Telemetry — depend on a local sync job, since FastF1's live-timing archive blocks Cloud Run), the panel shows an hourglass empty state — "Stint data not available yet" / "Lap data not available yet" — explaining that the data appears once the race has finished and been archived, with links back to the race results and schedule. Pit Stops sources from Ergast instead, which is reachable from Cloud Run, so its equivalent empty state ("Pit-stop data not available yet") means the round genuinely has no published stops yet, not a sync gap.

**Race Control module.** Stat tiles (total messages, flag changes, safety car / VSC periods, other notes) above a scrollable, filterable feed (All / Flags / Safety Car / Other) of every race-control message in session order — timestamp, lap number, and involved driver (team-coloured) alongside the message text. Flag and safety-car messages get colour-coded left icons (green/yellow/red/blue for flags, amber for safety car/VSC, neutral for investigations, penalties, and DRS notes) so the highest-signal events read at a glance. Because OpenF1 currently paywalls its real-time-shaped endpoints for the whole current season (see below), this module shows an "unavailable for this session" empty state for the 2026 season rather than an error.

---

## Standings (`/standings`)

Header: "Season <year> · Championship / Championship", a **Drivers / Constructors** tab pair with an animated sliding pill, and a **season selector**.

**Drivers tab** — a row per driver, cascading in: position (P1 highlighted orange with a tinted, orange-bordered row), a glowing team-colour bar, the driver's photo, name, team, wins, and points. Points spring-count up the first time each row scrolls into view. Beside the list, a sticky sidebar stacks three panels: **"Constructor battle"**, showing the top five constructors as horizontal bars filled in team colours sized to their share of the leader's points; **"Teammate battle"**, showing each team's two highest-scoring drivers head-to-head on race finishing position across every round they've both raced this season (a split bar plus an "N-M" score); and **"Title Decider"**, reporting whether the Drivers' and Constructors' championships are still mathematically open — the points gap between P1 and P2, the maximum points still available across remaining rounds (accounting for sprint weekends and a fastest-lap bonus point), and either "mathematically clinched" or how many more points the leader needs (or a runner-up slip) to seal it. All three are computed client-side from cached race/season data — no extra backend calls, and framed as arithmetic on the current gap rather than a prediction.

**Constructors tab** — a card per team: position, team-colour bar, team name, nationality, wins, points (count-up), and a full-width points bar filled with a team-colour gradient, sized relative to the leader.

Empty states: "No driver standings yet" / "No constructor standings yet" / "No constructor data yet".

---

## Drivers (`/drivers`)

Header: "<year> World Championship lineup / The Grid" with a **season selector**.

**Compare drivers panel** — two dropdowns (any driver vs any other) and a "Compare" button open a modal with both drivers' current-season Position/Points/Wins side by side, plus two computed head-to-head splits across every round they both raced: race finishing position, and qualifying pace (comparing whichever Q-segment — Q3, falling back to Q2 then Q1 — both drivers actually reached that round, with the average time gap). No new backend endpoint; entirely derived client-side from cached race and qualifying results.

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

Below the cards: an attribution line linking to Wikimedia Commons and the CC BY 4.0 licence for the Aston Martin logo (opens in a new tab). The Circuits page carries an equivalent attribution for the Saudi Arabia (Jeddah) circuit outline, licensed CC BY-SA 3.0 (the Bahrain outline is public domain and needs none).

**Power units** — a tile per engine supplier (Red Bull Ford, Mercedes-AMG, Ferrari, Honda, Renault, Audi) listing the teams that run it.

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

## Live Timing (`/telemetry`)

Linked from the desktop nav as "Live" (last item, after Circuits); deliberately excluded from the mobile bottom bar, which stays at its 5-item ceiling.

Header reads "APEX Live / Live Timing" with the current session name, a **Live** pill (pulsing red dot) or a **Standby** pill, and a link to the schedule.

The page derives whether a session is live from the season calendar plus assumed session durations (FP 60 min, Sprint Shootout 45, Sprint 30, Qualifying 60, Race 120). The race list refreshes every 60 seconds and the clock ticks every second.

**When no session is live**, it shows "Live timing polling is paused because no session is currently active." plus "Next session: <race> · <session> · <date/time>".

**When a session is live**, it polls a third-party RapidAPI feed every 10 seconds and renders a timing table: Pos, No, Driver (three-letter code in the team's colour), Gap, Interval, Last Lap, three **sector bars** (purple = overall fastest, green = personal best, orange otherwise), a **tyre** column (compound-coloured dot plus tyre age), and a Status column showing PIT / DRS / RUN. Rows are sorted by position. Loading, error, and "No timing rows available yet." states are all handled.

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
| `GET /api/session_recap` | Race detail page — AI Recap card. Streams plain text rather than JSON; calls Ollama Cloud on a cache miss |
| `GET /health` | Not used by the UI (deployment health check) |

Three data sources are called directly from the frontend rather than through the backend: **OpenF1** (`/sessions`, `/stints`, server-side, for the Pitwall chart; `/sessions`, `/race_control`, server-side, for the Pitwall Race Control module) and a **RapidAPI live-timing feed** (client-side, for `/telemetry`).

---

## Known gaps / not yet functional

These exist in the shipped UI but do not work, or do not work as their label implies.

- **`/telemetry` is gated by a RapidAPI key at runtime.** It is now linked from the desktop nav ("Live", last item) but deliberately still excluded from the mobile bottom bar (already at its 5-item ceiling). If `NEXT_PUBLIC_RAPIDAPI_KEY` isn't provisioned in an environment, the page shows a friendly "not available in this environment yet" message instead of a raw config-error string.
- **Season selectors offer 2018 onward, but data quality drops off sharply.** The range is fixed at `MIN_SUPPORTED_SEASON = 2018` regardless of what is actually cached; older seasons will show calendars and standings but largely empty session classifications, circuit details, and no Pitwall data.
- **Pitwall Race Control is functional but shows its empty state for the current season.** OpenF1 paywalls its real-time-shaped endpoints (`/sessions` for the current year, and by extension `/race_control`) for the entire current season, not just live sessions — confirmed by a live 401 on `GET /v1/sessions?year=2026`. There is no FastF1 equivalent for race-control messages, so unlike Tire Stints this module has no self-heal path; it will start working once a session ages into OpenF1's free historical window.

---

*Written from the code on `main`. The repo's `DESIGN-CONTEXT.md` is stale — it describes an obsolete cyan/magenta theme that no longer exists — and was not used as a source here.*
