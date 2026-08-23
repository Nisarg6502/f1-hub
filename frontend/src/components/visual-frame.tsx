"use client";

/**
 * `VisualFrame` — the client half of generated chat visuals.
 *
 * The agent streams a `visual` frame (`CHAT-VISUALS-CONTRACT.md` §4) carrying
 * **model-written drawing code** plus **data the backend copied verbatim out of
 * the evidence ledger**. This component executes that code and presents the
 * result. Contract §5 is the spec; this file is its implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECURITY BOUNDARY IS THE MISSING `allow-same-origin`. READ THIS BEFORE
 * TOUCHING THE `sandbox` ATTRIBUTE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `sandbox="allow-scripts"` — and *only* `allow-scripts` — forces the frame to
 * an **opaque origin**. That single omission is what makes it safe to run code
 * an LLM wrote:
 *
 *   - `parent.document`, `top.document` and `frameElement` throw: the frame is
 *     cross-origin to us, so it cannot read or write a byte of the site's DOM.
 *   - `document.cookie` is empty and unwritable — an opaque origin has no
 *     cookie jar, so the session cookie `rate_limit.py` mints is unreachable.
 *   - `localStorage` / `sessionStorage` / `indexedDB` throw `SecurityError`.
 *   - `'self'` in the inherited CSP resolves against the opaque origin and
 *     therefore matches *nothing*, so no script, image or `connect-src` target
 *     is reachable. Combined with `default-src 'self'`, the frame has no
 *     network at all.
 *
 * Adding `allow-same-origin` gives the frame the site's own origin back and
 * **every one of those properties disappears at once**, silently — nothing
 * errors, nothing warns, the chart just keeps rendering while arbitrary
 * model-authored code gains full read/write access to the logged-in page. If a
 * future change appears to "need" `allow-same-origin` to fix something, the
 * thing to change is what the frame is being asked to do, not this attribute.
 * The static pre-checks the backend runs on `code` (contract §2.3) are defence
 * in depth and explicitly *not* the boundary; this is.
 *
 * `allow-scripts` without `allow-same-origin` is the one sandbox combination
 * that is NOT self-defeating (the pair together is equivalent to no sandbox,
 * because the frame could simply remove its own sandbox attribute and reload).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A FAILED CHART MUST NEVER COST THE READER THE FACTS.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every failure path — code throws, code loops forever, code never signals
 * ready, the browser has no sandbox support, scripting is off entirely — lands
 * on the same place: a short message plus a "Show the numbers" disclosure that
 * renders `data` as a plain table. The numbers came from the ledger and are
 * good regardless of whether the drawing code was.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { APEX_VISUAL_RUNTIME } from "@/lib/visual-runtime";
import LocalDateTime from "./local-datetime";
import type { AgentVisual } from "@/lib/agent-api";

/* ==========================================================================
   Escaping
   ========================================================================== */

/**
 * Serialise arbitrary JSON so it can sit inside a `<script>` in an HTML
 * document that itself sits inside an HTML *attribute* (`srcdoc`).
 *
 * `data` is whatever the ledger held. It is not hostile by construction, but it
 * is unvalidated text from race control messages, driver names and web
 * snippets, so it can contain anything. What is defended against, and why:
 *
 * - **`<`, `>`, `&` → `<` / `>` / `&`.** This is the one that
 *   matters. A `</script>` anywhere in the data would end the script element
 *   early — the HTML tokenizer does not know or care that it is inside a JS
 *   string literal — spilling the rest of the payload into the document as
 *   markup. `<!--` is the same bug wearing a different hat: it switches the
 *   tokenizer into "script data escaped" state, after which the *real*
 *   `</script>` no longer closes anything and the remainder of the document is
 *   swallowed. Escaping every `<` kills both, and `<` inside a JS string
 *   literal parses back to exactly `<`, so the value the frame receives is
 *   unchanged. `&` is escaped for the same reason applied to the attribute
 *   layer: it cannot start an entity reference if it is not there.
 *
 * - **U+2028 / U+2029.** Legal inside a JS string since ES2019, but they are
 *   line terminators to some older parsers and to a lot of tooling in between.
 *   Free to escape, so escaped.
 *
 * - **Lone surrogates.** A half of a surrogate pair is not valid UTF-8, so it
 *   cannot survive a trip through document serialisation — it degrades to
 *   U+FFFD, silently changing the data. `JSON.stringify` has escaped these
 *   since ES2019 ("well-formed JSON.stringify"), which makes the pass below a
 *   no-op on every engine we ship to; it stays because the failure it prevents
 *   is silent data corruption, and because verifying "the runtime does this for
 *   me" is not something a reader of this file can do.
 *
 * The `srcdoc` **attribute** layer needs no escaping of its own: React sets it
 * as a DOM property on the client and entity-escapes `<`, `>`, `&`, `"` and
 * `'` when it serialises on the server. Both paths are safe, so this function
 * deliberately does not try to pre-escape for the attribute — doing so would
 * double-escape on one of the two paths.
 */
export function encodeJsonForScript(value: unknown): string {
  let json: string;
  try {
    // `JSON.stringify(undefined)` is `undefined`, not `"undefined"` — an
    // absent `data` has to become the literal `null`, or the script below
    // would read `window.__apexData = ;`.
    json = JSON.stringify(value ?? null) ?? "null";
  } catch {
    // Circular structures and throwing `toJSON`s both land here. The frame
    // gets `null`, the model's code is expected to guard for empty (contract
    // §3), and if it does not, the throw path shows the table instead.
    json = "null";
  }

  return escapeLoneSurrogates(
    json
      .replace(/[<>&]/g, (c) =>
        `\\u00${c.charCodeAt(0).toString(16).padStart(2, "0")}`
      )
      // Written as escapes rather than as the literal characters: a raw
      // U+2028 in THIS file is invisible in every editor and indistinguishable
      // from a stray newline in a diff.
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")
  );
}

/** Rewrite unpaired UTF-16 code units as `\uXXXX` escapes. See above. */
function escapeLoneSurrogates(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const unit = source.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = source.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += source[i] + source[i + 1];
        i += 1;
        continue;
      }
      out += `\\u${unit.toString(16).padStart(4, "0")}`;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += `\\u${unit.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += source[i];
  }
  return out;
}

/**
 * Turn the model's ES-module source into something that can run as a classic
 * inline script, and make it safe to inline.
 *
 * **The `export default` rewrite** (contract §5). The frame has no module
 * loader and cannot get one — a `<script type="module">` inside a `srcdoc`
 * document is still a module, but `export` at top level of a *classic* script
 * is a syntax error and `eval`/`new Function` are blocked because the
 * inherited CSP grants `'unsafe-inline'` but not `'unsafe-eval'`. So the
 * declaration is rewritten to an assignment onto a global the bootstrap then
 * calls. Anchored to the start of a line, so the phrase appearing inside a
 * string or a comment in the model's own code is left alone; the unanchored
 * pass only runs if the anchored one matched nothing, which is the case where
 * being slightly too eager is better than not running at all. A stray `export`
 * on some *other* declaration is stripped for the same reason: it is a syntax
 * error in a classic script and the model was told not to write one.
 *
 * **`</script` → `<\/script`.** Same tokenizer hazard as the data, but the code
 * cannot be blanket `\u`-escaped: `<` is a real operator here, and rewriting it
 * would change `a < b` into a syntax error. The narrow rewrite is safe because
 * `</` can only legally appear in JS inside a string, a template literal, a
 * regex literal or a comment — and `\/` means exactly `/` in all four. If it
 * appears anywhere else the source was already invalid.
 *
 * **`<!--` → `<\!--`.** Neutralises the "script data escaped" state described
 * above. Same argument in the four contexts where the sequence can legitimately
 * occur (`\!` is `!`). It does *not* hold for the two pathological readings —
 * Annex B's legacy HTML-open-comment, and the expression `a <!--b` meaning
 * `a < !(--b)` — where this rewrite turns working code into a syntax error.
 * That trade is taken deliberately: neither form is something a model writing
 * chart code emits, and the cost is bounded, because a parse error in the code
 * script fires `window.onerror`, which the guard script installed *before* it
 * turns into a posted `error` and the table fallback. The cost of the other
 * choice is unbounded.
 */
export function prepareModelCode(code: string): string {
  const anchored = code.replace(
    /^[ \t]*export[ \t]+default[ \t]+/gm,
    "__apexRender = "
  );
  const assigned =
    anchored === code
      ? code.replace(/\bexport\s+default\s+/, "__apexRender = ")
      : anchored;

  return assigned
    .replace(
      /^[ \t]*export[ \t]+(?=(?:const|let|var|function|class|async)\b)/gm,
      ""
    )
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--");
}

/* ==========================================================================
   The frame document
   ========================================================================== */

/**
 * APEX tokens, restated as CSS custom properties inside the frame.
 *
 * Restated rather than inherited, because an opaque-origin frame shares nothing
 * with its parent — not a stylesheet, not a custom property, not a font. For
 * the same reason the font stacks below stop at `system-ui`: `fonts.gstatic.com`
 * is unreachable from inside the frame no matter what the parent's `font-src`
 * says, so naming Bricolage/Hanken here would just be a stack that always falls
 * through. The values are copied from `globals.css`; they are the small subset
 * a chart needs, not the whole palette.
 */
const FRAME_TOKENS = `
:root {
  color-scheme: dark;
  --background: #0a0908;
  --surface-container: #1a1613;
  --surface-container-low: #14110e;
  --on-surface: #f6f1ea;
  --on-surface-variant: #a89e90;
  --primary: #ffae6a;
  --flame: #ff7a3d;
  --flame-bright: #ff8a3d;
  --ember: #e23a0e;
  --veil: #f5ebde;
  --warm-100: #f6f1ea;
  --warm-200: #c9c0b4;
  --warm-300: #a89e90;
  --warm-400: #8f867a;
  --warm-500: #6f665b;
  --warm-600: #5c554b;
  --error: #ff9b8a;
  --radius-chip: 6px;
  --radius-control: 10px;
  --radius-tile: 14px;
  --radius-card: 18px;
  --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-headline: system-ui, -apple-system, "Segoe UI", sans-serif;
  --ease-out-apex: cubic-bezier(0.23, 1, 0.32, 1);
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  /* Transparent, not #0a0908: the parent already paints a glass panel behind
     the frame, and an opaque ground inside it would draw a hard rectangle
     across that surface. */
  background: transparent;
  color: var(--on-surface);
  font-family: var(--font-body);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
#apex-visual-mount { padding: 14px; }
svg { max-width: 100%; overflow: visible; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #3a332b; border-radius: 6px; }
`;

/**
 * Installed **before** anything else runs, which is the point of it.
 *
 * A syntax error in the model's code is not catchable by a `try/catch` in a
 * later script — it is a parse failure of a whole `<script>` element, and the
 * only thing that sees it is a `window` error listener that was already
 * attached. So this goes first, ahead of the runtime and the code, and it is
 * the reason the "code is a syntax error" case degrades to the table rather
 * than to a permanently blank frame.
 *
 * `postMessage` to `parent` is the one cross-document call an opaque-origin
 * frame is allowed. The target origin is `"*"` and must be: the parent's real
 * origin is not knowable from in here, and there is nothing secret in a height
 * number. The parent authenticates the *source*, not the origin — see
 * `onMessage` below and contract §5.
 */
function guardScript(frameId: string): string {
  return `
(function () {
  var ID = ${encodeJsonForScript(frameId)};
  var settled = false;
  function post(message) {
    try { parent.postMessage(message, "*"); } catch (e) {}
  }
  window.__apexPostHeight = function (px) {
    post({ type: "apex-visual:height", id: ID, px: px });
  };
  window.__apexReady = function () {
    if (settled) return;
    settled = true;
    post({ type: "apex-visual:ready", id: ID });
  };
  window.__apexFail = function (message) {
    if (settled) return;
    settled = true;
    post({ type: "apex-visual:error", id: ID, message: String(message || "") });
  };
  window.addEventListener("error", function (event) {
    window.__apexFail(
      (event && event.message) || "The visual could not be drawn."
    );
  });
  window.addEventListener("unhandledrejection", function () {
    window.__apexFail("The visual could not be drawn.");
  });
})();
// Declared here, at top level of a classic script, so it is one shared global
// across the three scripts below: the code script assigns it (that is what
// the export-default rewrite produces) and the bootstrap reads it. Declaring
// it in the code script instead would work only if the model actually wrote
// an export default; this way the bootstrap's typeof check sees an
// initialised binding rather than an undeclared name.
var __apexRender;
`;
}

/**
 * Calls the model's `render` once, reports the outcome, and keeps the height
 * and the width in step afterwards.
 *
 * Two loops that look similar and are not:
 *
 * - **Height** is observed and posted whenever it moves more than a pixel. The
 *   parent turns that into the iframe's height, which changes the frame's
 *   viewport, which can change the height again — so the >1px gate is what
 *   stops a two-document oscillation, not an optimisation.
 * - **Width** is the only thing that triggers a *redraw*. Redrawing on height
 *   would close the loop above through the model's code, where nothing damps
 *   it.
 */
const BOOTSTRAP_SCRIPT = `
(function () {
  var mount = document.getElementById("apex-visual-mount");
  var fn =
    typeof __apexRender === "function"
      ? __apexRender
      : typeof window.render === "function"
        ? window.render
        : null;

  if (!fn) {
    window.__apexFail("The visual did not provide a render function.");
    return;
  }

  var lastWidth = -1;
  var lastHeight = -1;

  function contentWidth() {
    return Math.max(1, document.documentElement.clientWidth);
  }

  function measure() {
    return Math.ceil(
      Math.max(
        mount.offsetHeight,
        mount.scrollHeight,
        document.documentElement.scrollHeight
      )
    );
  }

  function reportHeight() {
    var px = measure();
    if (!isFinite(px) || px <= 0) return;
    if (Math.abs(px - lastHeight) <= 1) return;
    lastHeight = px;
    window.__apexPostHeight(px);
  }

  function draw() {
    lastWidth = contentWidth();
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    fn({
      data: window.__apexData,
      apex: window.apex,
      mount: mount,
      width: lastWidth,
    });
  }

  try {
    draw();
  } catch (err) {
    window.__apexFail((err && err.message) || "The visual could not be drawn.");
    return;
  }

  reportHeight();
  window.__apexReady();

  // Measured again after a frame and after a tick, because the FIRST
  // measurement is routinely 0 and that is not a bug in the model's code.
  // The scripts run during parse, before the frame's own first layout, and
  // an <img> or a webfont-metric-dependent <text> settles later still — so
  // the height that is correct for the document is not knowable at the
  // moment render returns. The parent holds the skeleton's min-height
  // until a real number arrives, so a late correction costs nothing, while
  // trusting the first reading would size every frame to one line.
  setTimeout(reportHeight, 0);
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(function () {
      reportHeight();
      setTimeout(reportHeight, 120);
    });
  } else {
    setTimeout(reportHeight, 120);
  }

  if (typeof ResizeObserver === "function") {
    try {
      new ResizeObserver(reportHeight).observe(mount);
    } catch (e) {}
  }

  var timer = null;
  window.addEventListener("resize", function () {
    if (contentWidth() === lastWidth) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      try {
        draw();
      } catch (err) {
        // A redraw that throws keeps whatever was last drawn rather than
        // blanking the frame — the reader already has a correct chart on
        // screen, and losing it because the panel was dragged narrower would
        // be a worse outcome than a chart at a stale width.
        return;
      }
      reportHeight();
    }, 150);
  });
})();
`;

/**
 * Assemble the whole `srcdoc`.
 *
 * Order is contract §5's, with one addition: the guard script goes ahead of
 * everything so it can witness a parse failure in what follows.
 *
 *   1. `<style>` — APEX tokens
 *   2. guard — error plumbing (added; see `guardScript`)
 *   3. the `apex` runtime, inlined as a string because the frame cannot fetch
 *   4. the model's `code`, `export default` rewritten to an assignment
 *   5. `data` as a JSON literal
 *   6. the bootstrap, calling `render` inside `try/catch`
 *
 * The runtime is inlined verbatim: it is our own build-time artefact from
 * `lib/visual-runtime.ts`, not model output, so it gets the same treatment a
 * bundler would give it and none of the sanitising the model's code gets.
 */
export function buildVisualSrcDoc(options: {
  frameId: string;
  code: string;
  data: unknown;
}): string {
  const { frameId, code, data } = options;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${FRAME_TOKENS}</style>`,
    "</head><body>",
    '<div id="apex-visual-mount"></div>',
    `<script>${guardScript(frameId)}</script>`,
    `<script>${APEX_VISUAL_RUNTIME}</script>`,
    `<script>${prepareModelCode(code)}</script>`,
    `<script>window.__apexData = ${encodeJsonForScript(data)};</script>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
    "</body></html>",
  ].join("\n");
}

/* ==========================================================================
   Component
   ========================================================================== */

type FrameState = "pending" | "ready" | "error";

/**
 * Height of the pending skeleton, and the floor the ready frame is held to.
 *
 * A visual arrives mid-stream, underneath text the reader may already be
 * reading. Reserving a fixed block up front means the transcript settles once —
 * when the skeleton appears — instead of a second time when the chart resolves
 * and pushes everything below it down mid-sentence.
 */
const MIN_FRAME_HEIGHT = 220;

/**
 * How long a frame gets to say `ready` before it is treated as failed.
 *
 * The watchdog lives in the **parent**, not in the frame, and that is the whole
 * point of it. Contract §7 describes a frame-side timer, but a frame-side timer
 * cannot fire in the case it exists for: `while (true) {}` never yields, so the
 * frame's own event loop never runs another task and its `setTimeout` is still
 * queued when the heat death arrives. Only a different document can notice.
 *
 * On expiry the iframe is **unmounted**, not just hidden — that destroys the
 * document and with it the spinning script. Leaving it mounted would leave a
 * core pegged for as long as the tab is open.
 *
 * **Measured caveat, which contract §7 does not mention and which cannot be
 * fixed from page code.** "A separate document" is not "a separate main
 * thread". Chrome puts every sandboxed opaque-origin frame belonging to one
 * page into ONE shared renderer process, so a `while (true)` here does not
 * only cost its own frame: it starves every *other* visual on screen for the
 * full five seconds, and those siblings then time out too and fall back to
 * their tables. The parent page is unaffected — it is in a different process,
 * and this was verified: with the looping fixture alone on the page, the
 * transcript stayed fully responsive and its own watchdog fired on time.
 *
 * The blast radius is bounded by three things already in place: the tool caps
 * an answer at two visuals, frames are not created until they are near the
 * viewport, and the fallback loses no facts. It is worth knowing anyway,
 * because the symptom — a *good* chart timing out — points at the wrong
 * frame.
 */
const READY_TIMEOUT_MS = 5000;

let frameCounter = 0;

/**
 * Whether this browser will actually honour the sandbox.
 *
 * If it will not, the frame is not merely degraded, it is *unsafe*, so the
 * table is rendered instead. `sandbox in element` is a real feature test rather
 * than a UA sniff; `srcdoc` is tested alongside it because an implementation
 * with one and not the other would run the document without the attribute
 * doing anything.
 */
function sandboxSupported(): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("iframe");
  return "sandbox" in probe && "srcdoc" in probe;
}

/** Companion feature test for the near-viewport gate. See `canObserve`. */
function hasIntersectionObserver(): boolean {
  return typeof IntersectionObserver === "function";
}

/** The stores behind both feature tests never emit — see their call sites. */
function subscribeNever(): () => void {
  return () => {};
}

export default memo(function VisualFrame({ visual }: { visual: AgentVisual }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const reducedMotion = useReducedMotion();

  // Stable for the life of the component, and unique across the transcript.
  // `visual_id` is NOT used for this: it restarts at `vis_1` every turn, so
  // two answers on screen would both answer to the same id.
  const [frameId] = useState(() => `apex-visual-${(frameCounter += 1)}`);

  const [state, setState] = useState<FrameState>("pending");
  const [height, setHeight] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Whether the frame is close enough to the viewport to be worth running.
   *
   * This replaces `loading="lazy"`, which contract §5 shows on the iframe and
   * which is **actively wrong here** — the two features are incompatible in a
   * way that only shows up below the fold. A lazily-loaded iframe does not
   * load until the browser decides to, but the watchdog starts the moment the
   * component mounts, so a visual further down the transcript reliably failed
   * its five seconds without ever having executed a line: skeleton, then
   * "took too long", for a frame that was never asked to draw anything. It
   * looked exactly like slow model code.
   *
   * Doing the deferral ourselves fixes it, because then the two clocks start
   * together: the srcdoc is attached and the watchdog is armed in the same
   * commit. `rootMargin` is generous on purpose — a chart that finishes
   * drawing just before it scrolls into view is the whole point, and the cost
   * of being early is one cheap document.
   */
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Read the same way `supported` is, and for the same reason: a browser with
  // no IntersectionObserver must run every frame immediately (the failure mode
  // of being eager is a wasted document; the failure mode of being lazy is a
  // visual that never draws), and that decision has to survive hydration
  // without the server and the client disagreeing about the srcdoc attribute.
  const canObserve = useSyncExternalStore(
    subscribeNever,
    hasIntersectionObserver,
    () => true
  );
  const near = inView || !canObserve;
  // Whether this browser will honour the sandbox — a fact about the platform,
  // read through `useSyncExternalStore` rather than latched into state from an
  // effect.
  //
  // The store never changes (`subscribe` returns a no-op unsubscribe), so this
  // is not really a subscription; it is used for the one thing it does that a
  // `useState` + `useEffect` pair cannot, which is having a **separate server
  // snapshot**. The server has no `document` to feature-test, so it answers
  // "supported" and renders the frame; React then re-renders with the client
  // snapshot after hydration if the real answer differs. Setting state from an
  // effect would produce the same pixels and a cascading render, which is what
  // `react-hooks/set-state-in-effect` is for.
  const supported = useSyncExternalStore(
    subscribeNever,
    sandboxSupported,
    () => true
  );

  const fail = useCallback((message: string) => {
    setState((prev) => (prev === "error" ? prev : "error"));
    setFailure((prev) => prev ?? message);
  }, []);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  const asOfMs = useMemo(() => {
    if (!visual.as_of) return null;
    const ms = Date.parse(visual.as_of);
    return Number.isFinite(ms) ? ms : null;
  }, [visual.as_of]);

  const srcDoc = useMemo(
    () =>
      buildVisualSrcDoc({
        frameId,
        code: visual.code,
        data: visual.data,
      }),
    [frameId, visual.code, visual.data]
  );

  useEffect(() => {
    if (!supported) return;

    function onMessage(event: MessageEvent) {
      // ── The only authentication that works here ──────────────────────────
      // `event.origin` is the string "null" for an opaque origin, so comparing
      // it to the site's origin rejects every legitimate message — and
      // comparing it to "null" accepts every *other* sandboxed frame on the
      // page, plus anything a cross-origin document can post. Identity of the
      // window is the check that actually distinguishes our frame from
      // everyone else's, and it cannot be forged: no other document can
      // produce a `source` equal to this `contentWindow`.
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object") return;
      if (payload.id !== frameId) return;

      switch (payload.type) {
        case "apex-visual:height": {
          const px = Number(payload.px);
          if (!Number.isFinite(px) || px <= 0) return;
          setHeight(Math.max(MIN_FRAME_HEIGHT, Math.ceil(px)));
          break;
        }
        case "apex-visual:ready":
          setState((prev) => (prev === "pending" ? "ready" : prev));
          break;
        case "apex-visual:error":
          fail(
            typeof payload.message === "string" && payload.message.trim()
              ? payload.message
              : "The chart could not be drawn."
          );
          break;
        default:
          // Anything else on the page is free to postMessage; ignoring it is
          // the whole of the handling it deserves.
          break;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [supported, frameId, fail]);

  // The watchdog. See `READY_TIMEOUT_MS`. Armed only once the frame is
  // actually running — see `near`.
  useEffect(() => {
    if (!supported || !near || state !== "pending") return;
    const timer = setTimeout(
      () => fail("The chart took too long to draw."),
      READY_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [supported, near, state, fail]);

  const showFrame = supported && state !== "error";
  const cappedHeight = state === "ready" && height ? height : MIN_FRAME_HEIGHT;

  return (
    <motion.figure
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.23, 1, 0.32, 1] }}
      className="m-0 flex w-full max-w-[85%] min-w-0 flex-col gap-1.5 overflow-hidden rounded-2xl border border-white/10 bg-surface-container/98 px-3 py-3"
    >
      <figcaption className="flex flex-col gap-0.5 px-1">
        <span className="text-xs font-semibold tracking-wide text-warm-100">
          {visual.title}
        </span>
        {visual.caption && (
          <span className="text-[11px] leading-snug text-[var(--color-on-surface-variant)]">
            {visual.caption}
          </span>
        )}
      </figcaption>

      {showFrame ? (
        <div ref={wrapRef} className="relative w-full min-w-0">
          <iframe
            ref={iframeRef}
            // ⚠️ NO `allow-same-origin`. See the module docstring — this
            // omission is the entire isolation boundary, and adding it back
            // removes the isolation without producing a single error.
            sandbox="allow-scripts"
            // Deliberately NOT `loading="lazy"`, and deliberately empty until
            // `near` — see that field for why the attribute and the watchdog
            // cannot coexist. An empty srcdoc is an empty document, which
            // costs nothing.
            srcDoc={near ? srcDoc : ""}
            title={visual.title}
            // The frame paints its own ground; a default white iframe
            // background would flash through before first paint.
            className="block w-full border-0 bg-transparent"
            style={{
              height: `${cappedHeight}px`,
              // Contract §5: capped at 70vh, and the iframe's own document
              // scrolls inside that cap — no wrapper needed, a short iframe
              // over a tall document is already a scroll container.
              maxHeight: "70vh",
              opacity: state === "ready" ? 1 : 0,
              transition: reducedMotion ? "none" : "opacity 220ms var(--ease-out-apex)",
            }}
          />
          {state === "pending" && <PendingSkeleton reduced={Boolean(reducedMotion)} />}
        </div>
      ) : (
        <VisualFallback
          data={visual.data}
          message={
            !supported
              ? "This browser can't run sandboxed visuals, so here are the numbers instead."
              : (failure ?? "The chart could not be drawn.")
          }
        />
      )}

      {/*
        Scripting off entirely: nothing above this ever paints, because the
        panel is a client component. `<noscript>` is the only branch a
        non-scripting reader reaches, so it carries the numbers too — the same
        promise every other failure path makes.
      */}
      <noscript>
        <DataTable data={visual.data} />
      </noscript>

      {/* `as_of` arrives as an ISO instant. Rendering it raw would be the one
          thing on this card that does not look like the rest of the site, and
          `LocalDateTime` is already how every other surface here turns an
          instant into a reader's local time without a hydration mismatch.
          Guarded on a parseable value: `as_of` is optional on the wire and an
          unparseable one would render "Invalid Date". */}
      {asOfMs != null && (
        <span className="px-1 text-[10px] text-[var(--color-on-surface-variant)]">
          Data as of <LocalDateTime timestampMs={asOfMs} />
        </span>
      )}
    </motion.figure>
  );
});

/**
 * Occupies exactly the space the frame will, so the resolve is a cross-fade
 * rather than a reflow. Absolutely positioned over the (transparent) iframe so
 * both share one box.
 */
function PendingSkeleton({ reduced }: { reduced: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 flex flex-col justify-end gap-2 rounded-xl bg-surface-container-low/40 p-4"
    >
      <div className="flex flex-1 items-end gap-2">
        {[0.45, 0.8, 0.6, 0.95, 0.35, 0.7].map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-[3px] bg-[rgb(var(--rgb-primary)/0.13)]"
            style={{
              height: `${h * 100}%`,
              animation: reduced
                ? undefined
                : `apexVisualPulse 1.6s ${i * 0.09}s ease-in-out infinite`,
            }}
          />
        ))}
      </div>
      <div className="h-px w-full bg-white/10" />
      <style>{`@keyframes apexVisualPulse { 0%,100% { opacity: 0.45 } 50% { opacity: 1 } }`}</style>
    </div>
  );
}

/**
 * The error / unsupported presentation: one sentence of plain explanation, and
 * the numbers behind a disclosure.
 *
 * Closed by default rather than open, because the common reader is not looking
 * for a table — they are looking at an answer that happens to be missing an
 * illustration, and a wall of raw ledger data under every failure would be
 * louder than the failure deserves. The affordance is what matters: the facts
 * are one click away and are visibly still there.
 */
function VisualFallback({ data, message }: { data: unknown; message: string }) {
  return (
    <div className="flex flex-col gap-2 px-1">
      <p className="text-xs leading-relaxed text-[var(--color-on-surface-variant)]">
        <span className="text-[var(--color-error)]">Chart unavailable.</span>{" "}
        {message}
      </p>
      <details className="group">
        <summary
          className="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg border border-white/10 bg-surface-container-low/50 px-2.5 py-1 text-[11px] font-medium text-warm-200 transition-[background-color] duration-150 hover:bg-surface-container-low/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          // `list-none` alone does not remove the marker in every engine.
          style={{ listStyle: "none" }}
        >
          <svg
            viewBox="0 0 12 12"
            width="10"
            height="10"
            aria-hidden
            className="transition-transform duration-150 group-open:rotate-90"
          >
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Show the numbers
        </summary>
        <div className="mt-2">
          <DataTable data={data} />
        </div>
      </details>
    </div>
  );
}

/* ==========================================================================
   The table fallback
   ========================================================================== */

type TableShape = {
  columns: string[];
  rows: (string | null)[][];
} | null;

/** Render one JSON scalar the way the rest of the site would write it. */
function cell(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

/**
 * Find something table-shaped in arbitrary JSON.
 *
 * `data` is a ledger entry's payload verbatim, and the ledger holds whatever
 * the tool that filled it returned — an array of rows, an object wrapping an
 * array of rows under some key, or a flat bag of scalars. All three are common,
 * so all three get a table rather than a `<pre>` of JSON. Anything that fits
 * none of them falls through to the raw dump, which is still the facts.
 */
function toTable(data: unknown): TableShape {
  const rowsOf = (list: unknown[]): TableShape => {
    if (list.length === 0) return null;
    const objects = list.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object" && !Array.isArray(r)
    );
    if (objects.length === list.length) {
      const columns: string[] = [];
      for (const row of objects) {
        for (const key of Object.keys(row)) {
          if (!columns.includes(key)) columns.push(key);
        }
      }
      if (columns.length === 0) return null;
      return {
        columns,
        rows: objects.map((row) => columns.map((c) => cell(row[c]))),
      };
    }
    return { columns: ["value"], rows: list.map((v) => [cell(v)]) };
  };

  if (Array.isArray(data)) return rowsOf(data);

  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    // Prefer a nested array of records over the wrapper's own key/value pairs:
    // `{available: true, rows: [...]}` is a table with two bits of metadata
    // attached, not a two-row table.
    const nested = entries.find(
      ([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object"
    );
    if (nested) {
      const table = rowsOf(nested[1] as unknown[]);
      if (table) return table;
    }
    if (entries.length === 0) return null;
    return {
      columns: ["field", "value"],
      rows: entries.map(([k, v]) => [k, cell(v)]),
    };
  }

  const scalar = cell(data);
  return scalar == null ? null : { columns: ["value"], rows: [[scalar]] };
}

function DataTable({ data }: { data: unknown }) {
  const table = useMemo(() => toTable(data), [data]);

  if (!table) {
    return (
      <p className="text-[11px] text-[var(--color-on-surface-variant)]">
        No numbers were attached to this visual.
      </p>
    );
  }

  // The panel is 480px wide at its narrowest and a ledger row can carry a
  // dozen fields, so the table scrolls inside its own box rather than
  // stretching the bubble.
  return (
    <div className="max-h-[40vh] overflow-auto rounded-[10px] border border-white/10">
      <table className="w-full border-collapse text-left text-[11px]">
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th
                key={c}
                scope="col"
                className="sticky top-0 whitespace-nowrap border-b border-white/10 bg-surface-container-high px-2 py-1.5 font-semibold text-warm-200"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0">
              {row.map((value, j) => (
                <td
                  key={j}
                  className="px-2 py-1 align-top text-[var(--color-on-surface)]"
                >
                  {value ?? (
                    <span className="text-[var(--color-on-surface-variant)]">—</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
