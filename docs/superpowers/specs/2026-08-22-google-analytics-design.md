# Google Analytics 4 — Design

**Date:** 2026-08-22
**Status:** Designed, not implemented

## Problem

APEX has thirteen routes, a chat assistant, a WebGL circuit viewer, a race
replay and a phone-as-second-screen pairing mode, and **no evidence that any of
them is used**. Every design decision on the site to date has been argued from
first principles, because there has never been anything else to argue from.

Four of those arguments are currently unresolvable without usage data:

1. **The mobile navigation cap.** The bottom bar stops at six items, so Teams,
   Live and History are reachable only on desktop. That is defensible if most
   traffic is desktop and indefensible if it is not. Nobody knows which.
2. **`/telemetry`.** Linked in the desktop nav as "Live", and it has never
   rendered a row of timing data in production. Whether that is a quiet
   embarrassment or an active source of bad first impressions depends entirely
   on how many people click it.
3. **Second-screen pairing.** Built for a scenario — a phone propped against a
   television — that has never been observed happening.
4. **Portfolio attribution.** APEX exists in large part to be looked at. Which
   link people arrive from, and whether they stay, is the question the project
   was built to answer, and it is the one question currently unanswered.

There is also a fifth thing, which is not a design argument but a blind spot:
every page catches its own fetch failure and renders empty rather than
erroring. A soft-failed fetch still returns HTTP 200, so **Cloud Run logs cannot
see it**. How often real users land on a degraded backend is unknown and
unknowable from the server side.

## The cost, stated plainly

Two pages currently promise the opposite of this change:

- `privacy/page.tsx` — "**No analytics.** No Google Analytics, no PostHog, no
  product-analytics tooling of any kind." It further explains that there is no
  consent banner *because* the only cookie is strictly-necessary, and that a
  banner asking permission for something you cannot decline would be theatre.
- `faq/page.tsx` — "No analytics, no ad tech, no tracking pixels, no accounts."

Both claims become false the moment this ships. Rewriting them honestly is part
of this work, not a follow-up. The privacy page's reasoning about why there is
no banner is *correct reasoning about a different set of facts*; it is replaced,
not softened, and the banner it argued against is now warranted precisely
because `_ga` is a cookie you **can** decline.

An alternative — a cookieless tool such as Plausible, or first-party event
collection in the existing MongoDB — would have avoided the banner and the
rewrite entirely. It was considered and rejected in favour of GA4's acquisition
reporting and free BigQuery export.

## Scope

### Included

- GA4 via `gtag.js`, gated behind Consent Mode v2.
- A consent banner shown **only** to EU/UK/EEA visitors.
- Page views on every route change, fired manually.
- Eight hand-picked custom events (listed below).
- Rewritten `/privacy` and `/faq` copy.
- Build-time configuration through the existing `NEXT_PUBLIC_` path.

### Explicitly excluded, with reasons

- **Fine-grained interaction events** (every modal open, every nav click, every
  season tab switch). More call sites touched, more noise in reports, and a
  real path to the 50 custom-dimension cap. The eight events below were chosen
  because each answers a question already written down; anything beyond them is
  instrumentation looking for a purpose.
- **Any chat message content.** `pitwall_message_sent` is a count. What people
  type is already disclosed as going to a model provider; sending it to Google
  as well is a second disclosure for no analytical gain.
- **User IDs, or anything resembling one.** No accounts exist, GA4's terms
  forbid PII, and the questions above are all answerable at population level.
- **Server-side / Measurement Protocol events.** The blind spot being closed is
  a client-side one; a server-side channel is a different project.
- **Geo-IP region detection.** See Architecture.

## Architecture

Three new files. Two of them are React; one deliberately is not.

```
frontend/src/lib/analytics.ts               React-free: region test, consent state, track()
frontend/src/components/analytics.tsx       Consent Mode defaults, gtag.js, page_view
frontend/src/components/consent-banner.tsx  Banner, EU/UK only
```

`analytics.ts` follows the `lib/watch-preferences.ts` idiom: no React, no DOM
beyond `localStorage`, so consent-state and region logic can be driven by a test
harness without rendering anything. Its key is namespaced
`apex.consent.analytics`, matching the existing `apex.watch.*` convention.

Both components mount once, in the root `app/layout.tsx`.

### Region detection is client-side, by timezone

The site is served from a bare `run.app` URL with no load balancer in front of
it, so **there are no geo headers available server-side**. The options were a
third-party geo-IP lookup — a network call, a latency cost, and a new
third-party disclosure on the very page being rewritten for honesty — or the
browser's own IANA timezone.

Timezone wins. `Intl.DateTimeFormat().resolvedOptions().timeZone` starting with
`Europe/`, plus the EEA outliers (`Atlantic/Reykjavik`, `Atlantic/Faroe`,
`Atlantic/Canary`, `Atlantic/Madeira`, `Atlantic/Azores`), covers the regulated
population. It is slightly over-inclusive at the margins — a European traveller
in Singapore, a VPN user — and that is the safe direction to err: the failure
mode is showing a banner to someone who did not legally need one.

### Ordering is the whole design

Most GA4 integrations get this wrong by loading `gtag.js` first and asking for
consent afterwards, by which point the cookie is already written.

1. An inline `beforeInteractive` script initialises `dataLayer` and sets Consent
   Mode v2 defaults to **denied, for everyone, unconditionally** — before
   `gtag.js` is requested. No `_ga` cookie exists at this point for any visitor
   in any region.
2. `gtag.js` loads `afterInteractive`, configured with `send_page_view: false`.
   In the denied state it still transmits **cookieless modelled pings**, so
   rough EU volume survives even from visitors who never accept.
3. On mount, client-side:
   - Not EU/UK → `consent.update({ analytics_storage: 'granted' })` immediately.
     No banner is rendered, now or ever.
   - EU/UK with a stored choice → apply it silently.
   - EU/UK with no stored choice → render the banner.
4. Accept → update to granted, persist. Decline → persist denied, banner never
   returns, cookieless pings continue.

Defaulting to denied globally and granting on mount — rather than deciding at
script-load time — is what makes step 1 possible at all: region is only knowable
once the browser is running, and consent defaults must be set before that.

### Page views are fired manually

`config` sets `send_page_view: false`, and a `usePathname` effect sends
`page_view` on each change. GA4's Enhanced Measurement claims to detect History
API navigations, but App Router's `pushState` pattern makes that unreliable and
prone to double-counting the first view. Explicit is cheaper to debug than a
discrepancy discovered three months of data later.

### Absent configuration degrades quietly

If `NEXT_PUBLIC_GA_MEASUREMENT_ID` is unset, `<Analytics/>` renders `null`: no
script, no banner, no cookie. Local development and any build without the ID
behave exactly as the site does today. This mirrors the posture already taken
for the RapidAPI key, where missing config reports a feature as unconfigured
rather than failing the build.

## The eight events

Each is a single `track()` call at a site that already exists. No new UI, no new
handlers.

| Event | Call site | Question it answers |
| --- | --- | --- |
| `pitwall_panel_open` | assistant launcher | Is the assistant discovered? |
| `pitwall_message_sent` | send handler | Opened once, or actually used? Count only |
| `watch_replay_start` | `/watch/[raceId]` play | Does anyone replay a race? |
| `watch_pair_qr` | pairing handshake | Is second-screen real, or a demo? |
| `circuit_3d_view` | `/circuits/[circuitId]` | Is the WebGL viewer reached? |
| `circuit_3d_generate` | "Generate 3D view" | How often is geometry built on demand? |
| `backend_unavailable` | existing empty-state catch | How often do users hit a soft-failed 200? |
| `search_result_selected` | global search | Is nav search used, and for what entity kind? |

Parameters are enum-ish values only — an entity kind, a circuit id, a season and
round. Nothing free-text, nothing user-authored.

One ambiguity worth settling before implementation: several pages catch fetch
failures independently, so a single degraded backend could fire
`backend_unavailable` more than once per view. It fires **at most once per route
view**, carrying the route as a parameter — the question is "how often does a
user see a degraded page", not "how many fetches failed".

## Configuration

Follows the existing build-time path exactly, with no new mechanism:

- `ARG` / `ENV NEXT_PUBLIC_GA_MEASUREMENT_ID` in `Dockerfile.frontend`
- `--build-arg` in the docker build step of `cloudbuild-frontend.yaml`
- `_NEXT_PUBLIC_GA_MEASUREMENT_ID` substitution with an **empty default**, so a
  build that has not been given an ID produces today's behaviour rather than a
  broken one

Because the value is baked into the client bundle at build time, **the frontend
must be rebuilt after the GA property is created**. Creating the property alone
will not make a running deployment start reporting — the same gotcha already
documented for `_NEXT_PUBLIC_AGENT_BASE_URL`.

### Two manual steps, outside this repo

1. Create the GA4 property and obtain the `G-XXXXXXXXXX` measurement ID.
2. **Set data retention to 14 months.** The default is 2. History lost to the
   default is not recoverable later, which makes the retention setting the
   single highest-consequence, lowest-effort decision in this entire design.

Optionally: enable the free BigQuery export at the same time, for the same
reason — it only captures events from the day it is switched on.

## Copy rewrite

`/privacy` — the "What APEX does not do" list loses its analytics bullet. A new
section states what GA4 collects (page views and engagement time per route,
device, browser, coarse location to city level, referrer and campaign, plus the
eight named events), that GA4 discards IP addresses, that `_ga` is written only
after consent, that EU/UK visitors are asked and everyone else is measured by
default, the 14-month retention, and how to opt out. The existing paragraph
explaining why there is no consent banner is removed — its premise no longer
holds.

`/faq` — "Do you track me?" is rewritten from "No analytics, no ad tech, no
tracking pixels, no accounts" into an accurate answer that links to `/privacy`.

Both page `metadata.description` strings assert "no analytics" and must change
along with the bodies.

The tone stays what it already is on these pages: specific, unhedged, and
willing to name the downside. The change here is factual, not rhetorical.

## Testing

- **DebugView** for event delivery and parameter shape, during development.
- **Consent ordering** verified by inspecting cookies before and after accept:
  no `_ga` in the denied state, `_ga` present after grant, and never before the
  banner is answered.
- **Region gating** verified by overriding the timezone in headless Chrome — a
  `Europe/*` zone must produce a banner, a non-EU zone must not.
- **Absent-ID path** verified by building without the substitution: no network
  request to `googletagmanager.com`, no banner, no console noise.
- **Route-change page views** verified as one event per navigation, not two.

Verification is via headless Chrome, not the Claude browser preview pane: routes
with `loading.tsx` stall there because a hidden tab starves the rAF-gated
reveal, which looks like a bug and is not one.

## Out of scope

Server-side events, session recording, heatmaps, A/B testing, any second
analytics tool, and acting on the findings. This design ships the instrument.
What the numbers turn out to say — including, plausibly, that `/telemetry`
should be unlinked — is a later decision, made with data that does not exist
yet.

---

## Implementation notes (added after the work landed)

Implemented on `feat/google-analytics`. Seven commits, following
`docs/superpowers/plans/2026-08-22-google-analytics.md`.

### What was verified, and how

Chrome ignores the `TZ` environment variable on Windows -- it reads the OS
timezone, which made the first region test silently meaningless (a
`TZ=Europe/Berlin` browser reported `Asia/Calcutta` and showed no banner, which
looked exactly like a bug in the region gate). Verification was redone over the
DevTools Protocol using `Emulation.setTimezoneOverride`, driven from Node 22's
global `WebSocket` so it needed no new dependency.

Everything below was measured against a **production build** (`next build` +
`next start`), not the dev server. That distinction turned out to matter -- see
the next section.

| Check | Result |
| --- | --- |
| Consent defaults present in served HTML, ahead of gtag.js | Yes -- inline block at offset ~5217; **zero** executing `gtag/js` tags in the initial HTML |
| EU (`Europe/Berlin`): banner shown | Yes |
| EU: any consent grant before the click | **None** -- `consent update` list was empty |
| EU + Allow | `analytics_storage: granted`, banner gone, `apex.consent.analytics = "granted"` |
| EU + Decline | No grant, banner gone, stored as `"denied"` |
| Non-EU (`Asia/Kolkata`): banner | Never rendered |
| Non-EU: grant on mount | Exactly one |
| `page_view` per navigation | Exactly one each: `/`, `/standings`, `/drivers` |
| `backend_unavailable` | Once per route view, correct route parameter |
| `pitwall_panel_open` | Fires with `{ via: "button" }` and nothing else |
| No measurement ID | Zero `googletagmanager` references, no consent script, no banner |

One correction to a first reading: an early check reported gtag.js appearing
*before* the consent defaults. That was a `<link rel="preload" as="script">`,
which fetches but never executes. The ordering was correct.

### The dev server double-counts everything, and it is not a bug

Against `next dev`, `page_view`, the consent grant and `backend_unavailable` each
fired **twice**. That is React Strict Mode double-invoking effects in
development, which Next enables by default. The same run against a production
build produced exactly one of each.

Worth writing down because the doubling looks precisely like the
double-counting this design set out to avoid by sending `page_view` by hand.
**Any future check of event counts must run against a production build**, or it
will report a bug that does not exist.

### What could NOT be verified here

`googletagmanager.com` is blocked at the network level in this environment --
requests reach `Network.loadingFailed` while `fonts.googleapis.com` returns 200,
so it is tracker-specific filtering rather than a lack of connectivity. gtag.js
therefore never executed locally.

The consequence: **the real `_ga` cookie was never observed being written**, so
"cookie appears after consent" is confirmed only as far as "APEX asks for the
grant correctly and withholds it until consent". Everything upstream of Google's
own script is verified; Google's script itself has not run.

It also means no `/g/collect` request was ever sent, so the claim in this
document that a denied visitor still produces cookieless modelled pings is
Google's documented behaviour, taken on trust, not something measured here.

**Confirm both against the live deployment once a real measurement ID exists**:
`_ga` present after consent and absent before it, and traffic arriving in
DebugView.

### Two departures from the spec, both forced by the code

1. **`backend_unavailable` needed a component.** The spec put it in "the
   existing empty-state catch", but those catches are in `async` server
   components, which have no `gtag`. `components/degraded-beacon.tsx` renders on
   the empty branch of `/standings`, `/schedule`, `/drivers`, `/teams` and
   `/circuits` instead.
2. **`circuit_3d_view` moved** from `track-viewer-mount.tsx` -- a bare
   `dynamic()` re-export with no hooks -- to `track-viewer.tsx`, which already
   calls `useWebglSupported()`. The event now carries `webgl_supported`. This
   document listed "whether the WebGL viewer rendered successfully" as a gap
   needing its own event; it cost a parameter instead.

Also: `RaceReplay` has no `race_id`, so `watch_replay_start` carries `season`
and `round`.

### One lint rule suppressed, deliberately

`@next/next/no-before-interactive-script-outside-document` fires on
`analytics.tsx`. It is a Pages Router rule that wants `pages/_document.js`, which
does not exist in an App Router app; the root layout is the documented location.
Suppressed inline with the reasoning, and the emitted HTML was checked rather
than trusted.

### Still outstanding

Neither can be done from the codebase:

1. Create the GA4 property, take its `G-XXXXXXXXXX` ID, and set
   `_NEXT_PUBLIC_GA_MEASUREMENT_ID` in `cloudbuild-frontend.yaml`. **The frontend
   must be rebuilt afterwards** -- the ID is baked in at build time.
2. **Set data retention to 14 months.** The default is 2, and the privacy page
   now states 14 in writing. Enable the free BigQuery export at the same time;
   it only captures events from the day it is switched on.
