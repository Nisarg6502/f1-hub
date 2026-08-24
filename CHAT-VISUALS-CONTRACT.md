# APEX chat visuals — the wire contract

This file is the single source of truth for the boundary between the agent
backend and the chat frontend. Backend and frontend are built against **this**,
not against each other. If a change is needed, change it here first.

Background and the option analysis live in `CHAT-VISUALS-PLAN.md`. This file
records the decision that was actually taken, which **differs from that
document's recommendation** and supersedes it.

---

## 1. The decision

`CHAT-VISUALS-PLAN.md` recommended a closed registry: the model picks a `kind`
from a fixed list and the frontend maps it to a pre-built React component. That
was rejected. The requirement is a chat that can visualise **whatever was
asked**, not a chat that can visualise nine things.

So: **the model writes the drawing code. The backend supplies the numbers.**

That split is the whole design, and it is what makes generative visuals
compatible with an agent that already has an `EvidenceLedger` and a
`verifier.py`:

- The model emits **code only** — no data literals. It receives an
  `evidence_id` it has already retrieved, and writes a function that renders
  whatever is in that bundle.
- The **backend** looks up the ledger entry and attaches `entry.data` verbatim.
  The model is structurally incapable of drawing a number it did not retrieve,
  which is the same guarantee `verifier.py` gives the prose.
- The code runs in a **sandboxed iframe with no `allow-same-origin`**, i.e. an
  opaque origin. It cannot reach the parent DOM, cookies, storage, or the
  network.

The house style is not enforced by restricting what can be drawn. It is
supplied: an `apex` runtime is injected into the frame with tokens, scales,
axes, tooltips, team colours and motion already in APEX's voice. The model
composes with those primitives instead of starting from a blank `<svg>`, which
is what keeps output from looking like default matplotlib.

---

## 2. The tool

Registered alongside the existing fact tools. It is **not** a fact tool — it
retrieves nothing and appends nothing to the ledger.

```python
render_visual(
    evidence_id: str,   # must already exist in the ledger
    title: str,         # short caption, <= 80 chars, shown above the frame
    code: str,          # ES module source, see §3
    caption: str = "",  # optional one-clause description, <= 200 chars
) -> dict
```

### Backend responsibilities

1. **Resolve `evidence_id` against the ledger.** Unknown id → return
   `{"ok": false, "reason": "unknown_evidence"}` and emit nothing. Do not
   guess a nearby entry.
2. **Reject oversized code.** `len(code) > 24_000` → `{"ok": false,
   "reason": "code_too_large"}`.
3. **Static pre-checks** on `code`, as defence in depth only — the sandbox is
   the real control, and these must never be described as the security
   boundary. Reject on any of: `import `, `require(`, `fetch(`,
   `XMLHttpRequest`, `WebSocket`, `eval(`, `new Function`, `document.cookie`,
   `localStorage`, `sessionStorage`, `parent.`, `top.`, `window.open`.
4. **Attach the data.** `entry.data` verbatim — no reshaping, no truncation.
   If it exceeds 256KB when serialised, return `{"ok": false, "reason":
   "data_too_large"}` rather than sending a payload the frame will choke on.
5. **Emit the SSE frame** (§4) and return `{"ok": true, "visual_id": ...}` to
   the model so it knows the call landed and does not retry.

The tool **never raises** — same rule as every other tool in the package.

### Prompt instruction (summary; exact wording lives in the prompt module)

The model is told: call this at most twice per answer, always after
retrieving the evidence, never with invented data, and that the `apex`
runtime exists with the surface in §3.

The bias is toward drawing, not away from it — this is a deliberate reversal
from this document's first version, made after real use showed the
conservative default meant a chart-shaped answer usually got no chart at all.
The model is told to default to offering a picture whenever the evidence
bundle has more than one comparable value in it (a ranking, a series, a
head-to-head, anything with more than one row or point), and that the prose
and the picture are not alternatives — answer in words first, and it is
expected and fine for the chart to still be rendering when the words are
already on screen, since it streams in asynchronously below the answer (§5).
The two things that still say "don't": a single scalar with nothing to
compare it to, and the two-per-answer cap. A table remains worth adding
alongside a chart, not just instead of one, when the reader wants exact
values row by row.

This is a `PROMPT_VERSION` bump (see the version history in
`backend/agent/config.py`) — the cache is keyed on prompt version precisely
so a policy change like this one cannot be served stale out of a
pre-reversal cache row.

---

## 3. What the model writes

`code` is the body of an ES module with a single default export:

```js
export default function render({ data, apex, mount, width }) {
  // `data`  — the ledger entry's `data`, verbatim
  // `apex`  — the runtime, see below
  // `mount` — an empty <div> already in the document
  // `width` — the frame's current content width in CSS px
}
```

It is called once on load and again on resize (debounced). It must be safe to
call repeatedly: clear `mount` or rebuild into it.

### The `apex` runtime surface

Injected into the frame; no imports, no network, no build step. Two layers —
see `frontend/src/lib/visual-runtime.ts`'s own top-of-file docstring, which
states this split explicitly: **marks** for the common chart, **primitives**
for everything else. The model is told to prefer marks (§2's prompt summary
now says so explicitly, after the incident below).

**Marks — one call, house-styled, covers the common case:**

| Member | Purpose |
|---|---|
| `apex.bars({mount, width, data, x, y, ...})` | vertical bar chart, one row per category |
| `apex.hbars({...})` | horizontal bars — prefer this over `bars` when category names are long |
| `apex.lines({mount, width, series, x, y, ...})` / `apex.area({...})` | one or more series over a continuous axis |
| `apex.dots({mount, width, data, x, y, ...})` (alias `apex.scatter`) | scatter |
| `apex.table({mount, data, columns, ...})` | styled data table |
| `apex.plot({...})` | the primitive plot builder underneath all five above — returns scales, the `<svg>`, and `.bars/.hbars/.lines/.dots/.legend/.caption` methods, for a chart that is *almost* one of the marks above but needs a tweak |

**Primitives — for a chart shape none of the marks above cover:**

| Member | Purpose |
|---|---|
| `apex.tokens` | the APEX CSS custom properties as a plain object (`primary`, `ember`, `flame`, `warm100…warm600`, `veil`, `background`, `error`, radii, font stacks) |
| `apex.teamColor(name)` | `{hex, glow}` via the same matching rules as `lib/team-colors.ts` |
| `apex.scaleLinear({domain, range})` / `apex.scaleBand({domain, range, padding})` | scales, d3-free |
| `apex.ticks(min, max, count)` | nice tick values |
| `apex.el(tag, attrs, children)` / `apex.svg(tag, attrs, children)` | element helpers. Prefer passing every attribute in `attrs` up front. The returned element also has a `.attr(name, value)` method (chainable) and `apex.rect`/`circle`/`ellipse`/`line`/`path`/`text`/`g` exist as per-tag shorthands over `apex.svg`, added as defence in depth after the incident below — the model still generally should not need them if a mark builder fits. |
| `apex.axis({...})`, `apex.gridlines({...})` | house-styled axes and grid |
| `apex.legend(items)`, `apex.tooltip(...)` | house-styled legend and hover readout |
| `apex.fmt.lapTime / gap / delta / ordinal / points / date` | formatting that matches the rest of the site |
| `apex.animate(el, keyframes, opts)` | honours `prefers-reduced-motion`; a no-op reduced |
| `apex.panel(...)`, `apex.caption(text, opts)` | glass surface and caption chrome. `caption`'s `text` (and any `{text: ...}` in `apex.el`/`apex.svg` attrs) must be a string — passing an object throws rather than rendering "[object Object]" |

The runtime is a **single self-contained JS string** built at frontend build
time and inlined into the frame — it must not be fetched, because the frame's
opaque origin cannot fetch anything.

**Incident, 2026-08-24 (part 1):** a live answer comparing two drivers'
points called `render_visual` with hand-built SVG that called `apex.rect(...)`
(did not exist yet) and `apex.svg(...).attr(...)` (the return value was not
chainable yet) — both errors traced to this section previously documenting
only the primitives row and never mentioning `apex.bars`/`apex.hbars`, the
calls actually built for exactly that comparison shape. The frame's error
path degraded correctly (§7 — table fallback, no lost facts), but the chart
the reader asked for never rendered. Root cause was documentation
completeness, not a runtime bug or a model failing to follow instructions it
was given — this table and the prompt in `backend/agent/graph.py` both
omitted the marks layer entirely. Fixed by documenting it here and in the
prompt, `PROMPT_VERSION` bumped (`backend/agent/config.py`).

**Incident, 2026-08-24 (part 2):** immediately after that fix deployed, the
same question (asked again, landing fresh due to the version bump) produced
one working `apex.bars` chart and one broken one showing the literal text
"[OBJECT OBJECT]" with axes but no bars. Root cause this time was two
separate runtime gaps, not a prompt gap: (1) `apex.caption`/the `text` attrs
key did a bare `String(value)`, so a call passing the `data` bundle itself
(or a row) instead of a built string silently produced the literal string
"object Object" rather than failing; (2) `apex.bars`/`hbars`/`dots` drew
axes and category ticks even when every row's value accessor returned a
non-numeric result (most likely a wrong field name guessed for `x`/`y`),
which `apex.lines` already guarded against but the other three did not.
Both are now defended in the runtime itself — a non-string `text` throws
(caught by the frame, degrades to the table fallback, same as any other
thrown error), and an all-invalid value column degrades to the same
no-data empty state a genuinely empty `data` array gets, instead of a
correctly-labelled chart with nothing drawn on it. `PROMPT_VERSION` bumped
again so cached answers under either prior incident are not replayed as
settled.

Prompting alone cannot fully prevent a model from inventing plausible but
wrong API calls or misreading a field name (§7 already says as much for
data literals) — after two production incidents in the same session hit
different instances of that same underlying risk, the runtime itself grew a
second line of defence rather than continuing to patch the prompt one
hallucination at a time. The prompt fix remains the primary control: it is
what a model actually reads before writing code, and it is why the very
next question in the same conversation drew one correct `apex.bars` chart
before hitting the second, previously-undiscovered gap.

### Rules the model must follow

- No `import` / `require` — everything needed is on `apex`.
- No network, no timers longer than 5s, no `while(true)`.
- Must render something for **every** shape `data` can take, including empty.
  Guard before indexing; a thrown error becomes a visible failure state.
- Must respect `width` and reflow; no fixed pixel widths above 640.
- Text must use `apex.tokens` colours so it stays legible on the dark ground.

---

## 4. The SSE frame

A new event type. `agent-api.ts`'s `dispatch` has a `default:` case that
ignores unknown events, so older clients are unaffected by construction.

```
event: visual
data: {
  "visual_id":   "vis_1",
  "evidence_id": "ev_3",
  "title":       "Points gap to the leader",
  "caption":     "",
  "as_of":       "2026-08-23T01:00:00Z",
  "code":        "export default function render({...}) {...}",
  "data":        { ... }          // verbatim ledger data
}
```

Emitted **after** the last `token` of the answer and **before** `sources`.
Multiple `visual` frames may appear; render them in arrival order.

Registered in `agent/sse.py` next to the other constructors, because that
module is explicitly the place the event vocabulary is defined rather than
described.

---

## 5. Frontend rendering

`VisualFrame` renders:

```jsx
<iframe
  sandbox="allow-scripts"          // NO allow-same-origin — that is the boundary
  srcDoc={...}
  title={title}
  loading="lazy"
/>
```

`srcdoc` contains, in order: a `<style>` block of APEX tokens; the `apex`
runtime; the model's `code` with its `export default` rewritten to an
assignment; the frame's `data` as a JSON literal; and a bootstrap that calls
`render` inside `try/catch` and reports back.

### Messages from frame → parent

```
{ type: "apex-visual:height", id, px }
{ type: "apex-visual:error",  id, message }
{ type: "apex-visual:ready",  id }
```

The parent **must** verify `event.source === iframe.contentWindow` before
acting on a message, and must ignore anything else. Origin will be `"null"`
(opaque) — do not check it against the site's origin.

### States

- **pending** — skeleton at a stable min-height, so the transcript does not jump
- **ready** — auto-sized to the reported height, capped at 70vh with internal scroll
- **error** — a short APEX-styled message plus a **"Show the numbers"** disclosure
  that renders `data` as a plain table. A failed chart must never mean the user
  loses the facts.
- **no-js / unsupported** — same table fallback

### Placement

Below the answer text, above the source strip. Not inline in the prose — an
inline marker scheme is deferred deliberately.

---

## 6. CSP

The current header has **no `frame-src`**, so frames fall back to
`default-src 'self'`. Add an explicit directive in `frontend/next.config.ts`:

```
frame-src 'self'
```

`srcdoc` frames inherit the parent policy, so the frame's own `script-src`
becomes `'self' 'unsafe-inline'`. Inline scripts therefore run — which is what
we need — while `'self'` resolves against an **opaque** origin and so matches
nothing, meaning no external script, no `connect-src` target, and no image host
is reachable from inside the frame. The sandbox attribute, not the CSP, is what
prevents parent access.

This must be **verified against the built `routes-manifest.json`**, not just
the source: `headers()` is baked in at build time.

---

## 7. Failure modes to handle explicitly

| Mode | Required behaviour |
|---|---|
| Model calls with an `evidence_id` it never retrieved | tool returns `unknown_evidence`; nothing renders |
| Model writes data literals instead of using `data` | cannot be prevented; the numbers are still the ledger's for anything it reads from `data`. Prompt against it, and note it in the doc rather than claiming a guarantee that does not hold |
| Code throws at render time | frame catches, posts `error`, parent shows the table fallback |
| Code loops forever | frame is a separate document; a watchdog posts `error` after 5s and the parent falls back |
| `data` is empty / `available: false` | model is instructed to guard; if it did not, the throw path covers it |
| Two visuals for one answer | allowed, capped at 2 by the tool |
| Answer cache replay | visuals are cached with the answer and replayed; they are pure functions of `(code, data)` |

---

## 8. Out of scope for this slice

Inline `[vis_N]` markers in prose. Export-to-PNG. User-editable charts.
Visuals on the `/pitwall-chat` dev preview page.
