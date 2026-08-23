/**
 * Hand-written `visual` payloads for `/visual-check`.
 *
 * There is no way to develop `VisualFrame` against a live model: the agent has
 * to be running, it has to decide a chart is warranted, and it has to happen to
 * write the failing kind of code you need to see. Every state below is instead
 * reachable in one click, deterministically, offline.
 *
 * These are shaped exactly like what `dispatch` builds from a `visual` SSE
 * frame — `code` as the model would write it (an ES module with a default
 * export), `data` as the backend would attach it (a ledger entry's payload,
 * verbatim).
 *
 * They deliberately do NOT depend on the real `apex` runtime surface, which
 * another agent is still filling in (`lib/visual-runtime.ts` currently exports
 * a placeholder). Each fixture guards its use of `apex` so the harness keeps
 * exercising the frame's own states rather than failing on a runtime that is
 * not there yet.
 */

import type { AgentVisual } from "./agent-api";

/**
 * The happy path: a real chart, drawn from the data, at whatever width the
 * frame is given.
 *
 * Written the way the model is asked to write — guards before indexing,
 * reflows on `width`, colours from tokens — so it doubles as a check that the
 * contract's own rules are satisfiable.
 */
const GOOD_CHART = `
export default function render({ data, mount, width }) {
  const rows = Array.isArray(data && data.rows) ? data.rows : [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No points on record for this season yet.";
    empty.style.color = "var(--warm-300)";
    mount.appendChild(empty);
    return;
  }

  const H = 26, GAP = 8, LABEL = Math.min(120, Math.max(74, width * 0.26));
  const w = Math.max(220, width - 28);
  const plot = Math.max(40, w - LABEL - 46);
  const max = Math.max.apply(null, rows.map((r) => Number(r.points) || 0)) || 1;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const height = rows.length * (H + GAP);
  svg.setAttribute("viewBox", "0 0 " + w + " " + height);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(height));

  rows.forEach((row, i) => {
    const y = i * (H + GAP);
    const value = Number(row.points) || 0;
    const barW = Math.max(2, (value / max) * plot);

    const name = document.createElementNS(NS, "text");
    name.setAttribute("x", String(LABEL - 10));
    name.setAttribute("y", String(y + H * 0.7));
    name.setAttribute("text-anchor", "end");
    name.setAttribute("fill", "var(--warm-200)");
    name.setAttribute("font-size", "12");
    name.textContent = String(row.driver == null ? "—" : row.driver);
    svg.appendChild(name);

    const bar = document.createElementNS(NS, "rect");
    bar.setAttribute("x", String(LABEL));
    bar.setAttribute("y", String(y + 3));
    bar.setAttribute("width", String(barW));
    bar.setAttribute("height", String(H - 6));
    bar.setAttribute("rx", "4");
    bar.setAttribute("fill", i === 0 ? "var(--primary)" : "var(--flame)");
    bar.setAttribute("opacity", i === 0 ? "1" : String(0.85 - i * 0.06));
    svg.appendChild(bar);

    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", String(LABEL + barW + 8));
    label.setAttribute("y", String(y + H * 0.7));
    label.setAttribute("fill", "var(--warm-100)");
    label.setAttribute("font-size", "12");
    label.setAttribute("font-weight", "600");
    label.textContent = String(value);
    svg.appendChild(label);
  });

  mount.appendChild(svg);
}
`;

/** Throws on the first statement — contract §7's "code throws at render time". */
const THROWS = `
export default function render({ data, mount }) {
  // The single most common way model-written chart code fails: it assumes a
  // shape the ledger entry does not have and indexes into nothing.
  return data.standings.rows[0].driver.name.toUpperCase();
}
`;

/**
 * Contract §7's "code loops forever".
 *
 * A frame-side watchdog cannot catch this — the loop never yields, so no timer
 * in this document will ever run again. Only the parent can notice, which is
 * why `READY_TIMEOUT_MS` lives there.
 */
const LOOPS = `
export default function render() {
  let n = 0;
  while (true) { n += 1; }
}
`;

/** `data` is present but carries nothing — the "guard before indexing" case. */
const EMPTY_DATA = `
export default function render({ data, mount }) {
  const rows = Array.isArray(data && data.rows) ? data.rows : [];
  const p = document.createElement("p");
  p.style.margin = "0";
  p.style.color = "var(--warm-300)";
  p.style.fontSize = "12px";
  p.textContent =
    rows.length === 0
      ? "Nothing to plot — this session has no recorded stops."
      : rows.length + " rows";
  mount.appendChild(p);
}
`;

/**
 * Renders the hostile strings straight into the document as **text**, so a
 * screenshot shows whether they survived the trip intact.
 *
 * If the escaping in `encodeJsonForScript` were wrong, this fixture would not
 * render a chart with odd labels — the `</script>` in the data would have
 * closed the script element and the frame would be blank or broken. The point
 * of drawing the values is that "it looks right" and "it is right" are the
 * same observation here.
 */
const SHOWS_RAW_STRINGS = `
export default function render({ data, mount }) {
  const items = Array.isArray(data && data.rows) ? data.rows : [];
  const list = document.createElement("ul");
  list.style.margin = "0";
  list.style.padding = "0 0 0 16px";
  list.style.fontSize = "12px";
  list.style.lineHeight = "1.7";
  items.forEach((item) => {
    const li = document.createElement("li");
    li.style.color = "var(--warm-100)";
    // textContent, never innerHTML: the values are hostile by construction.
    li.textContent = String(item.label) + "  →  " + String(item.value);
    list.appendChild(li);
  });
  mount.appendChild(list);
}
`;

/**
 * The isolation probe.
 *
 * Contract §1's claim — "it cannot reach the parent DOM, cookies, storage, or
 * the network" — is a claim about the browser, and a comment asserting it is
 * worth nothing. This fixture attempts each one from inside the frame and draws
 * the outcome, so the isolation is something you can look at rather than
 * something you have to believe.
 *
 * The `fetch` is fired but not awaited into the verdict synchronously: an
 * opaque origin's CSP refusal rejects the promise, and the row is updated when
 * it does. If any row ever reads "REACHED", the sandbox has been broken.
 */
const ISOLATION_PROBE = `
export default function render({ mount }) {
  const results = [];
  function probe(name, fn) {
    try {
      const value = fn();
      results.push([name, "REACHED: " + String(value).slice(0, 40), false]);
    } catch (err) {
      results.push([name, "blocked (" + (err && err.name) + ")", true]);
    }
  }

  probe("parent.document", function () { return parent.document.title; });
  probe("top.document", function () { return top.document.title; });
  probe("frameElement", function () {
    var el = window.frameElement;
    if (el === null) throw new DOMException("cross-origin", "SecurityError");
    return el.tagName;
  });
  probe("document.cookie", function () {
    var c = document.cookie;
    if (!c) throw new DOMException("empty cookie jar", "SecurityError");
    return c;
  });
  probe("localStorage", function () { return localStorage.length; });
  probe("sessionStorage", function () { return sessionStorage.length; });
  probe("origin", function () {
    if (location.origin === "null" || origin === "null") {
      throw new DOMException("opaque origin", "SecurityError");
    }
    return location.origin;
  });
  probe("eval", function () { return eval("1+1"); });

  const table = document.createElement("table");
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "12px";
  table.style.width = "100%";
  results.forEach(function (row) {
    const tr = document.createElement("tr");
    const k = document.createElement("td");
    k.textContent = row[0];
    k.style.padding = "3px 10px 3px 0";
    k.style.color = "var(--warm-200)";
    k.style.fontFamily = "ui-monospace, monospace";
    const v = document.createElement("td");
    v.textContent = row[2] ? "✓ " + row[1] : "✗ " + row[1];
    v.style.color = row[2] ? "var(--primary)" : "var(--error)";
    v.style.fontWeight = "600";
    tr.appendChild(k);
    tr.appendChild(v);
    table.appendChild(tr);
  });

  const netRow = document.createElement("tr");
  const netK = document.createElement("td");
  netK.textContent = "fetch(site)";
  netK.style.padding = "3px 10px 3px 0";
  netK.style.color = "var(--warm-200)";
  netK.style.fontFamily = "ui-monospace, monospace";
  const netV = document.createElement("td");
  netV.textContent = "… pending";
  netV.style.color = "var(--warm-300)";
  netV.style.fontWeight = "600";
  netRow.appendChild(netK);
  netRow.appendChild(netV);
  table.appendChild(netRow);
  mount.appendChild(table);

  try {
    fetch("/api/health")
      .then(function (r) {
        netV.textContent = "✗ REACHED: " + r.status;
        netV.style.color = "var(--error)";
      })
      .catch(function (e) {
        netV.textContent = "✓ blocked (" + (e && e.name) + ")";
        netV.style.color = "var(--primary)";
      });
  } catch (e) {
    netV.textContent = "✓ blocked (" + (e && e.name) + ")";
    netV.style.color = "var(--primary)";
  }
}
`;

function visual(
  partial: Omit<AgentVisual, "visual_id" | "evidence_id" | "as_of"> &
    Partial<Pick<AgentVisual, "visual_id" | "evidence_id" | "as_of">>,
  index: number
): AgentVisual {
  return {
    visual_id: partial.visual_id ?? `vis_${index + 1}`,
    evidence_id: partial.evidence_id ?? `ev_${index + 1}`,
    as_of: partial.as_of ?? "2026-08-23T01:00:00Z",
    title: partial.title,
    caption: partial.caption,
    code: partial.code,
    data: partial.data,
  };
}

/** The hostile-string row set, built in code so the escapes are unambiguous. */
const HOSTILE_ROWS = [
  { label: "closes the script", value: '</script><img src=x onerror="alert(1)">' },
  { label: "opens an html comment", value: "<!-- and never closes" },
  { label: "quotes", value: `he said "hi" and 'bye' and \`tick\`` },
  { label: "backslash + newline", value: "a\\b\nsecond line" },
  // A high surrogate with no low surrogate after it. Without the escaping pass
  // this becomes U+FFFD somewhere between here and the frame — silently, which
  // is why it is in the fixture set at all.
  { label: "lone surrogate", value: "before\uD83D after" },
  { label: "line separator", value: "one two" },
  { label: "ampersand entity", value: "&lt;not-a-tag&gt; &amp; &#x3c;" },
];

export const VISUAL_FIXTURES: AgentVisual[] = [
  {
    title: "Points gap to the leader",
    caption: "Drivers' championship, after 15 rounds.",
    code: GOOD_CHART,
    data: {
      available: true,
      season: 2026,
      rows: [
        { driver: "Verstappen", points: 331 },
        { driver: "Norris", points: 297 },
        { driver: "Piastri", points: 268 },
        { driver: "Leclerc", points: 214 },
        { driver: "Russell", points: 189 },
        { driver: "Hamilton", points: 152 },
      ],
    },
  },
  {
    title: "Stint pace by compound",
    caption: "This one throws on its first statement.",
    code: THROWS,
    data: {
      available: true,
      rows: [
        { compound: "SOFT", laps: 14, avg_s: 81.4 },
        { compound: "MEDIUM", laps: 22, avg_s: 82.9 },
        { compound: "HARD", laps: 21, avg_s: 83.6 },
      ],
    },
  },
  {
    title: "Gap evolution, lap by lap",
    caption: "This one never returns — the parent watchdog has to end it.",
    code: LOOPS,
    data: { available: true, rows: [{ lap: 1, gap_s: 0.0 }, { lap: 2, gap_s: 0.4 }] },
  },
  {
    title: "Pit stops this session",
    caption: "Empty data, guarded by the model's own code.",
    code: EMPTY_DATA,
    data: { available: false, rows: [] },
  },
  {
    title: "Strings that break naive escaping",
    caption: "Every value below made a round trip through the srcdoc intact.",
    code: SHOWS_RAW_STRINGS,
    data: { available: true, rows: HOSTILE_ROWS },
  },
  {
    title: "Sandbox isolation probe",
    caption: "Every row must read blocked. One REACHED means the boundary is gone.",
    code: ISOLATION_PROBE,
    data: { note: "this fixture ignores its data on purpose" },
  },
].map(visual);
