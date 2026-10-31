"use client";

import { buildVisualSrcDoc, encodeJsonForScript } from "@/components/visual-frame";
import type { AgentVisual } from "@/lib/agent-api";

/**
 * Turning a chat visual into something a canvas can draw.
 *
 * **Why not just capture the frame on screen.** A chat visual is model-written
 * code running in a `sandbox="allow-scripts"` iframe with an opaque origin
 * (`visual-frame.tsx`). That isolation is the security boundary, and it is
 * exactly what makes every DOM-to-image approach fail from the parent: the
 * parent cannot read the frame's document, so html2canvas and friends see an
 * empty box, and there is no browser API that screenshots a cross-origin
 * frame. Adding `allow-same-origin` would make capture trivial and would also
 * remove the isolation, without a single error — so it is not an option.
 *
 * **What this does instead.** It mounts a *second*, throwaway frame with the
 * same sandbox and the same `srcdoc` the visible frame got
 * (`buildVisualSrcDoc`), plus one extra script appended after the bootstrap.
 * That script runs inside the sandbox, after the model's `render` has drawn,
 * and serialises what was drawn to an SVG string, which it posts to the
 * parent. The parent never touches the frame's DOM; it receives a string.
 *
 * Re-running the code rather than asking the visible frame has three
 * advantages worth the duplicate execution (which is cheap — these are a few
 * hundred elements):
 *
 *   - the visible frame and `visual-frame.tsx` are untouched, so the share
 *     feature cannot regress the chart people are reading;
 *   - the chart is drawn at the card's width, not the chat panel's, and the
 *     model's code reflows for it (it is told to honour `width`);
 *   - it works for a visual that is scrolled out of view, or one whose
 *     visible frame was never mounted (`VisualFrame` defers mounting until
 *     near the viewport).
 *
 * **Two serialisations, because one browser rule bites.** The frame posts:
 *
 *   - `html`: the whole mount — panel, title, legend, tables, SVG — wrapped
 *     in an SVG `<foreignObject>` with the frame's own stylesheets embedded.
 *     This is the faithful one. Chrome and Firefox draw it onto a canvas
 *     cleanly; some WebKit builds treat any `foreignObject` image as tainting
 *     the canvas, after which `toBlob` throws.
 *   - `svg`: the largest `<svg>` element alone, with every computed paint
 *     property copied inline so it no longer depends on the frame's CSS
 *     variables. Pure SVG never taints. It loses any HTML legend or caption.
 *
 * The card tries `html` first, checks for taint on a scratch canvas, and falls
 * back to `svg`, then to no chart at all — see `answer-card.ts`.
 *
 * **Why the strings are safe to draw.** They are model output and are never
 * inserted into this document. They are only ever decoded as an `<img>`,
 * and an SVG loaded as an image runs no script and fetches no external
 * resource — the browser's own image-context restrictions, not any
 * sanitising here, are what make that safe. Size is capped so a hostile
 * visual cannot hand the page a hundred-megabyte string.
 */

export interface VisualSnapshot {
  /** Natural size of the drawn mount, in CSS px at the requested width. */
  width: number;
  height: number;
  /** The faithful serialisation (foreignObject); may taint a canvas on some engines. */
  html: string | null;
  /** The pure-SVG fallback: the largest `<svg>`, styles inlined. */
  svg: string | null;
  svgWidth: number;
  svgHeight: number;
}

/** Strings above this are dropped rather than decoded. Real charts are well under 1MB. */
export const SNAPSHOT_MAX_CHARS = 4_000_000;

/** How long the snapshot frame gets to draw and serialise. Matches the visible frame's watchdog. */
const SNAPSHOT_TIMEOUT_MS = 6000;

/**
 * The script appended to the snapshot frame's `srcdoc`. Runs inside the
 * sandbox, after the bootstrap.
 *
 * Waits for `load` plus a beat (late layout: webfont metrics, ResizeObserver
 * reflows), finishes any Web Animations so a chart that grows its bars is
 * captured at the end state rather than mid-tween, then serialises. Uses
 * timers only, never `requestAnimationFrame` — rAF does not run in a frame
 * Chrome considers hidden.
 *
 * Written in ES5 with no template literals, like the runtime, because it is
 * a string that executes in the frame.
 */
function snapshotScript(frameId: string, maxChars: number): string {
  return `
(function () {
  var ID = ${encodeJsonForScript(frameId)};
  var MAX = ${maxChars};
  var SVGNS = "http://www.w3.org/2000/svg";
  var XHTMLNS = "http://www.w3.org/1999/xhtml";
  var PAINT = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
    "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family",
    "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor",
    "dominant-baseline", "alignment-baseline", "visibility", "display", "color"];

  function post(m) { try { parent.postMessage(m, "*"); } catch (e) {} }

  function finishAnimations() {
    try {
      if (!document.getAnimations) return;
      var all = document.getAnimations();
      for (var i = 0; i < all.length; i++) {
        try { all[i].finish(); } catch (e) { try { all[i].cancel(); } catch (e2) {} }
      }
    } catch (e) {}
  }

  function inlinePaint(orig, copy) {
    if (orig.nodeType !== 1) return;
    var cs = getComputedStyle(orig);
    var style = "";
    for (var i = 0; i < PAINT.length; i++) {
      var v = cs.getPropertyValue(PAINT[i]);
      if (v) style += PAINT[i] + ":" + v + ";";
    }
    copy.setAttribute("style", style + (copy.getAttribute("style") || ""));
    var oc = orig.children, cc = copy.children;
    for (var j = 0; j < oc.length && j < cc.length; j++) inlinePaint(oc[j], cc[j]);
  }

  function largestSvg(root) {
    var best = null, bestArea = 0;
    var all = root.getElementsByTagNameNS(SVGNS, "svg");
    for (var i = 0; i < all.length; i++) {
      if (all[i].ownerSVGElement) continue;
      var r = all[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = all[i]; }
    }
    return best;
  }

  function cssText() {
    var out = "";
    var styles = document.querySelectorAll("style");
    for (var i = 0; i < styles.length; i++) out += styles[i].textContent + "\\n";
    return out;
  }

  function serialize() {
    var mount = document.getElementById("apex-visual-mount");
    if (!mount) { post({ type: "apex-share:snapshot", id: ID, html: null, svg: null }); return; }
    finishAnimations();
    var width = Math.ceil(Math.max(mount.scrollWidth, mount.getBoundingClientRect().width));
    var height = Math.ceil(Math.max(mount.scrollHeight, mount.getBoundingClientRect().height));
    var xs = new XMLSerializer();
    var html = null, svg = null, svgW = 0, svgH = 0;

    try {
      var body = getComputedStyle(document.body);
      // Re-hosted inside an <svg> image, the mount loses its html/body
      // ancestors, so rules and custom properties scoped to them no longer
      // reach chart marks (bars came out black, lines vanished). Two
      // belt-and-braces fixes: copy every root/body custom property onto the
      // wrapper, and bake computed paint into each chart <svg> subtree.
      var vars = "";
      var roots = [getComputedStyle(document.documentElement), body];
      for (var ri = 0; ri < roots.length; ri++) {
        for (var k = 0; k < roots[ri].length; k++) {
          var name = roots[ri][k];
          if (name.indexOf("--") === 0) {
            vars += name + ":" + roots[ri].getPropertyValue(name).replace(/"/g, "'") + ";";
          }
        }
      }
      var clone = mount.cloneNode(true);
      var origSvgs = mount.getElementsByTagNameNS(SVGNS, "svg");
      var copySvgs = clone.getElementsByTagNameNS(SVGNS, "svg");
      for (var si = 0; si < origSvgs.length && si < copySvgs.length; si++) {
        if (!origSvgs[si].ownerSVGElement) inlinePaint(origSvgs[si], copySvgs[si]);
      }
      var wrap = '<div xmlns="' + XHTMLNS + '" style="' + vars.replace(/&/g, "&amp;").replace(/</g, "&lt;") + 'width:' + width +
        'px;height:' + height +
        'px;font-family:' + body.fontFamily.replace(/"/g, "'") + ';font-size:' + body.fontSize +
        ';color:' + body.color + ';">' + xs.serializeToString(clone) + '</div>';
      html = '<svg xmlns="' + SVGNS + '" width="' + width + '" height="' + height +
        '" viewBox="0 0 ' + width + ' ' + height + '"><style>' +
        cssText().replace(/<\\//g, "<\\\\/") + '</style><foreignObject x="0" y="0" width="' + width +
        '" height="' + height + '">' + wrap + '</foreignObject></svg>';
      if (html.length > MAX) html = null;
    } catch (e) { html = null; }

    try {
      var target = largestSvg(mount);
      if (target) {
        var r = target.getBoundingClientRect();
        svgW = Math.ceil(r.width); svgH = Math.ceil(r.height);
        var copy = target.cloneNode(true);
        inlinePaint(target, copy);
        copy.setAttribute("xmlns", SVGNS);
        copy.setAttribute("width", String(svgW));
        copy.setAttribute("height", String(svgH));
        if (!copy.getAttribute("viewBox")) copy.setAttribute("viewBox", "0 0 " + svgW + " " + svgH);
        svg = xs.serializeToString(copy);
        if (svg.length > MAX || !svgW || !svgH) svg = null;
      }
    } catch (e) { svg = null; }

    post({ type: "apex-share:snapshot", id: ID, width: width, height: height,
      html: html, svg: svg, svgWidth: svgW, svgHeight: svgH });
  }

  function later() { setTimeout(serialize, 120); }
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later);
})();
`;
}

let snapshotCounter = 0;

/**
 * Draw `visual` at `width` CSS px in a throwaway sandboxed frame and return
 * its serialisations, or `null` if it failed, timed out, or drew nothing.
 *
 * `null` is a normal outcome — a visual whose code throws, or one that took
 * too long — and the card is drawn without a chart, saying so.
 */
export function snapshotVisual(visual: AgentVisual, width: number): Promise<VisualSnapshot | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  const frameId = `apex-share-snapshot-${(snapshotCounter += 1)}`;
  const doc = buildVisualSrcDoc({ frameId, code: visual.code, data: visual.data }).replace(
    "</body></html>",
    `<script>${snapshotScript(frameId, SNAPSHOT_MAX_CHARS)}</script>\n</body></html>`
  );

  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    // ⚠️ The same sandbox as the visible frame, and for the same reason: NO
    // `allow-same-origin`. See `visual-frame.tsx`.
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.title = "";
    // On screen but invisible and inert. Off screen (left: -10000px) would be
    // tidier, but Chrome throttles off-viewport cross-origin frames, and a
    // throttled frame is one that misses the deadline below.
    Object.assign(iframe.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${width}px`,
      height: "1600px",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
    });

    let settled = false;
    const finish = (result: VisualSnapshot | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(result);
    };

    function onMessage(event: MessageEvent) {
      // Window identity, not origin — the only check that works for an
      // opaque-origin frame. Same reasoning as `VisualFrame`.
      if (event.source !== iframe.contentWindow) return;
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object" || payload.id !== frameId) return;
      if (payload.type === "apex-visual:error") {
        finish(null);
        return;
      }
      if (payload.type !== "apex-share:snapshot") return;
      const asString = (v: unknown) => (typeof v === "string" && v.length <= SNAPSHOT_MAX_CHARS ? v : null);
      const asSize = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, 8000) : 0);
      const result: VisualSnapshot = {
        width: asSize(payload.width),
        height: asSize(payload.height),
        html: asString(payload.html),
        svg: asString(payload.svg),
        svgWidth: asSize(payload.svgWidth),
        svgHeight: asSize(payload.svgHeight),
      };
      const drewSomething = (result.html && result.width && result.height) || (result.svg && result.svgWidth);
      finish(drewSomething ? result : null);
    }

    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS);
    iframe.srcdoc = doc;
    document.body.appendChild(iframe);
  });
}
