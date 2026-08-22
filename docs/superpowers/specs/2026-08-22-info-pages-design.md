# Trust & Information Pages — Design

**Date:** 2026-08-22
**Status:** Implemented (commit `dfdd1e3`)

## Problem

APEX has no About, no Privacy, no statement of where its data comes from, and
no disclosure that part of it is AI-generated. The only trust signal on the
site is a nine-word footer line ("Concept prototype · not affiliated with
Formula 1") that links nowhere.

Three of these gaps are real rather than cosmetic:

1. Five upstream data providers with different settle times means users *will*
   see APEX disagree with the official timing screen, and nothing on the site
   explains why.
2. The Pitwall assistant sends what users type to a third-party model provider
   and stores conversation threads server-side. That is currently undisclosed.
3. F1/FIA marks are aggressively protected. The non-affiliation claim exists
   but is a footer whisper.

## Scope

Six static pages plus a footer restructure. Written in APEX's own voice —
plain-English, specific, no legal boilerplate.

### Included

| Route | Purpose |
|---|---|
| `/data-sources` | Per-upstream provenance, freshness, why numbers differ |
| `/ai-disclosure` | What the assistant computes vs. generates; no live access |
| `/privacy` | No cookies/analytics/accounts; the chat disclosure |
| `/disclaimer` | Non-affiliation, no accuracy guarantee, not for betting |
| `/about` | What/who/why + Contact (GitHub Issues) |
| `/faq` | Eight questions routing into the pages above |

### Explicitly excluded, with reasons

- **Cookie Policy / consent banner.** The site sets **exactly one cookie**,
  and it is strictly necessary: `f1_agent_sid` (`rate_limit.py:195`), an
  HMAC-signed rate-limiting identity minted by the agent backend on
  `/api/chat`, TTL 7 days (`config.py:208`). It carries no profile and is not
  used for analytics or advertising — it exists so a returning visitor keeps
  their own request allowance instead of inheriting their CGNAT neighbours'.
  Strictly-necessary cookies do not require consent, so a banner would still
  be theater and a UX tax; but the cookie **must be disclosed** on `/privacy`
  rather than denied. **Revisit the moment analytics is added.**
- **Terms of Service.** ToS governs a service relationship — accounts,
  suspension, user content, payment. APEX has none. Everything a ToS would
  actually do here (no accuracy guarantee, non-affiliation, unofficial) is
  `/disclaimer`. Boilerplate ToS on a no-account read-only site reads as
  copy-paste and weakens the project.
- **Changelog.** The repo has clean PR-per-change git history and a
  `ROADMAP.md`. A hand-maintained changelog page goes stale and then signals
  *un*maintained — the opposite of intent. If wanted later, generate from git
  tags.
- **Licenses / Attributions — deferred, not dismissed.** Jolpica/Ergast and
  OpenF1 attribution terms, Wikipedia's CC BY-SA on `/teams` heritage prose,
  and the imagery in `f1_driver_images/` and `teams/` are genuinely
  unresolved. This design adds only a stub line on `/data-sources` ("data used
  under each provider's terms"). Fabricating license claims would be worse
  than having none. **Own follow-up pass.**
- **Contact page.** Folded into `/about` as a section. No email: there is no
  custom domain, and publishing a personal Gmail invites scrapers. GitHub
  Issues + Discussions on `Nisarg6502/f1-hub`.
- **Report a Bug page.** A link to GitHub Issues, not a page.

## Architecture

Route group `src/app/(info)/` with a shared `layout.tsx`:

```
(info)/layout.tsx        prose shell: reading column, heading scale,
                         "Last reviewed" stamp
  about/page.tsx
  data-sources/page.tsx
  ai-disclosure/page.tsx
  privacy/page.tsx
  disclaimer/page.tsx
  faq/page.tsx
```

**Route group, not `/legal/*`.** Parentheses give all six one shared layout
while keeping URLs short (`/privacy`, not `/legal/privacy`). These are the
URLs people type and link.

**Fully static, zero client JS.** No `force-dynamic`, no `"use client"`. These
are the only routes in APEX with no data dependency and should be the fastest
and cheapest in the app.

**One shared prose layout.** Six independently styled pages drift
typographically. The layout owns the reading column (~68ch), heading rhythm,
and the `Last reviewed: <date>` line — the last being what makes a policy page
credible and what everyone forgets.

### Navigation — footer only, NOT the main nav

The nav bar already carries nine links and, per the comment in
`frontend/src/app/layout.tsx`, overflowed its own container at 768–900px until
the breakpoint was moved to `lg` (measured: scrollWidth 880 vs clientWidth
768; "History" clipped to "Histor"; season badge off-screen). Adding six links
would re-break exactly that. Any change here must keep `NavLinks` and
`MobileNav` breakpoints in agreement.

The footer grows from a one-row strip into three link groups:

- **Project** — About · FAQ · GitHub · Report a bug (→ Issues)
- **Data** — Data Sources · AI Disclosure
- **Legal** — Privacy · Disclaimer

The existing "Concept prototype · not affiliated with Formula 1" line stays in
place but becomes a link to `/disclaimer`.

Footer links must carry a 40px hit area. Per the existing GitHub-link comment
in `layout.tsx`: use four separate negative offsets
(`before:-top-3 before:-bottom-3 before:-left-1 before:-right-1`), **not** a
compound negative inset — `-inset-y-3` silently generated no CSS in this
codebase and the failure is invisible.

## Page content

### `/data-sources`

Table, one row per upstream: *Source · What it provides · How fresh · Terms*.

| Source | Provides | Freshness |
|---|---|---|
| FastF1 | Telemetry, lap times, tyre stints, pit stops, session classifications | After a session ends — not live |
| OpenF1 | Near-live timing for `/telemetry` and `/watch` | Seconds-to-minutes lag |
| Jolpica (Ergast successor) | Standings, results, schedule, historical constructor seasons | Post-session, rate-limited |
| Wikipedia | Constructor heritage prose on `/teams` | Static, CC BY-SA |

**Weather is not a separate provider.** It comes from OpenF1's `/weather`
endpoint (`session_results.py:370`) and is a **single mid-race sample**, not a
session average or a forecast. The page must say so — see the weather
accuracy work, which this page's copy depends on.

The browser also contacts, directly: `api.openf1.org`, `opentopodata.org`,
`commons.wikimedia.org`, `fonts.googleapis.com`, and `calendar.google.com`
(add-to-calendar links). These see the visitor's IP and belong in `/privacy`.

Plus two prose sections that are the page's real reason to exist:

- **"Why numbers here may differ from the official timing screen"** —
  different upstreams, different settle times, plus APEX's own sync cadence.
- **"How often this updates"** — the `f1-data-sync` Cloud Run Job runs
  **hourly** via Cloud Scheduler (`README.md:53`). The exact minute lives in
  the scheduler config, not the repo, so the page says "hourly" and does not
  invent a minute.

Also: a known-limitation line that FastF1's livetiming source is
intermittently unreachable from Cloud Run and fails soft, so a round can be
briefly incomplete.

### `/ai-disclosure`

1. **Computed vs. generated.** The codebase already draws this line: the
   evidence/citation system (`frontend/src/components/source-strip.tsx`,
   backend anchor resolution) means underlined values in an answer trace to a
   retrieved record; unmarked prose is model interpretation. State exactly
   that.
2. **It can be wrong** — specifically, it can misread a record it did
   retrieve, and can assert things with no record behind them.
3. **No live race access.** It reads the same synced data as the rest of the
   site. It is not watching the race.
4. **What happens to what you type** — one paragraph, links to `/privacy`.

### `/privacy`

- **No analytics, no ad tech, no tracking pixels.**
- **No accounts.** Nothing to sign up for or log into.
- **One cookie, and what it is for.** `f1_agent_sid` — an HMAC-signed
  rate-limiting identity, set by the agent backend when you use the Pitwall
  chat, expiring after 7 days. It holds no profile and tracks nothing across
  sites; it exists so your request allowance is yours rather than shared with
  everyone behind the same IP. Name it explicitly so anyone who opens devtools
  finds it described here.
- **In your browser only:** watch display preferences (`localStorage`,
  `lib/watch-preferences.ts`) and a session-resume marker (`sessionStorage`,
  `lib/watch-session.ts:283`). Clearing site data removes both.
- **The real disclosure — chat.** Pitwall conversations are stored
  server-side (MongoDB checkpointer, `backend/agent/checkpointer.py`) so the
  assistant remembers context within a thread. Thumbs feedback is stored in
  the `agent_feedback` collection (`backend/agent/main.py:792`). Advise
  against typing personal information.
- **Where chat data goes — name all three:**
  - **Ollama Cloud** (`https://ollama.com`, `config.py:39`) — runs the model;
    receives what you type.
  - **LangSmith** — receives traces of chat runs. **State this flatly, not
    conditionally.** The code defaults to off (`config.py:215`), but the
    deployed service sets `_LANGSMITH_TRACING: 'true'`
    (`cloudbuild-agent.yaml:90`) with `LANGSMITH_API_KEY` mounted from Secret
    Manager (`cloudbuild-agent.yaml:71`), so tracing **is on in production**.
  - **Tavily** (`https://api.tavily.com`, `tools/web.py:58`) — receives
    search queries derived from your question when the agent uses its web
    search tool.
- **MongoDB Atlas** hosts the stored threads.
- **Google Fonts** is the only third-party asset request the *frontend* makes.

### `/disclaimer`

Not affiliated with, endorsed by, or connected to Formula 1, the FIA, FOM,
Liberty Media, or any team or driver. F1 marks belong to their owners. No
guarantee of accuracy, completeness, or availability. Not for betting,
wagering, or any decision with money on it. Unofficial fan project.

### `/about`

What APEX is, that it is a personal project by Nisarg, why it was built, and
what is distinctive — the evidence-cited assistant, telemetry, historical
depth. Ends with a **Contact** section: GitHub Issues for bugs and feature
requests, Discussions for questions, both linking to `Nisarg6502/f1-hub`. No
email address.

### `/faq`

Each answer is short and links into the page that covers it properly:

- Why is live data delayed?
- Does the assistant watch the race live?
- Why doesn't this match F1TV / the official app?
- Where does telemetry come from?
- Is this official?
- Do you track me?
- Is my chat private?
- How do I report a bug?

## Correctness constraint

These pages are worthless if inaccurate, and an inaccurate privacy page is
worse than none. Every factual claim must be verified against the code at
implementation time, not written from plausibility. Claims already verified
during design:

- No `gtag`/`posthog`/analytics references in `frontend/src` — verified.
- No auth/accounts in `backend/` — verified.
- Chat threads persisted via MongoDB checkpointer — verified.
- Feedback stored in `agent_feedback` — verified.
- Sync job runs hourly — verified (`README.md:53`).
- **One cookie exists** — `f1_agent_sid`, strictly necessary, 7-day TTL
  (`rate_limit.py:195`, `config.py:208`) — verified.
- **LangSmith tracing is ON in production** — verified
  (`cloudbuild-agent.yaml:90` + `:71`).
- Third parties receiving chat data: Ollama Cloud, LangSmith, Tavily,
  MongoDB Atlas — verified.

If any claim turns out to be conditional, the page states the condition.

### Two corrections made during design — do not regress them

Both came from checking deployment config rather than trusting application
defaults, and both would have shipped a false privacy page:

1. **"No cookies" was wrong.** Grepping `frontend/src` for `document.cookie`
   finds nothing because the cookie is set by the *backend* via
   `Set-Cookie` on `/api/chat`, never by client JS. Any future audit must
   check the server, not just the browser bundle.
2. **"LangSmith off by default" was wrong about production.** The code
   default is off; the deployed service turns it on. A claim about behaviour
   must be checked against `cloudbuild-*.yaml`, not `config.py` defaults.

## Testing

- Build passes; all six routes prerender as static (confirm in build output —
  no route should be marked dynamic).
- No `"use client"` in the route group.
- Footer links resolve; no 404s.
- Keyboard: every footer link reachable and focus-visible.
- Hit areas: measure the footer links at 40px rather than trusting the
  Tailwind classes, per the compound-inset failure documented in
  `layout.tsx`.
- Responsive: footer's three groups stack cleanly at mobile widths; main nav
  unchanged at 768–900px (regression guard on the overflow fixed in #133).

## Out of scope

Licenses/attributions page; any changelog; cookie consent UI; ToS; email
contact; adding any of these routes to the main nav.


## Implementation notes (added after the work landed)

Two more facts changed during implementation, both found by checking rather
than assuming, and both now reflected in the pages:

- **Weather is not a separate provider.** It is OpenF1, and it is a single
  mid-session sample. `/data-sources` says so. This also produced a separate
  fix (`d2c62fe`): conditions are now read per session rather than the race's
  being shown for all of them.
- **Google Fonts is not the only third-party request the browser makes.** It
  also contacts `api.openf1.org`, `opentopodata.org`, `commons.wikimedia.org`
  and `calendar.google.com`, all of which see the visitor's IP. `/privacy`
  lists them.

Two things worth stating that were better than expected, and are now said on
the pages rather than left implicit: a PII guard rejects card numbers, national
ID numbers and phone numbers before they reach a model or a trace, and
rate-limit records carry a Mongo TTL index.

### Still outstanding

- **Licences and attributions page.** Deferred deliberately, as recorded above.
  `/data-sources` carries the stub line in the meantime.
- **A contact route other than GitHub.** Revisit if a custom domain appears;
  `NEXT_PUBLIC_SITE_URL` already exists for that day.
