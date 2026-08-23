/**
 * The `apex` runtime that is injected into a chat visual's sandboxed frame.
 *
 * This is a STRING, not a module the frame imports, and that is forced rather
 * than stylistic: the frame runs at an opaque origin (`sandbox="allow-scripts"`
 * with no `allow-same-origin`), so `'self'` in the inherited CSP matches
 * nothing and the frame cannot fetch a single byte. Everything it needs has to
 * arrive inside the `srcdoc` it is created with.
 *
 * See `CHAT-VISUALS-CONTRACT.md` §3 for the surface this must provide and the
 * rules the model is told it can rely on.
 *
 * Two layers, deliberately:
 *
 *   - **Primitives** (`scaleLinear`, `scaleBand`, `ticks`, `el`, `svg`, `axis`,
 *     `gridlines`, `legend`, `tooltip`, `animate`, `panel`, `caption`) so an
 *     unusual chart is still possible from a blank `<svg>`.
 *   - **Marks** (`apex.plot(...)` and its `.bars/.hbars/.lines/.area/.dots/
 *     .rule/.text` methods, plus the one-call `apex.bars/hbars/lines/dots/
 *     table` wrappers) so the *common* chart is five lines rather than eighty
 *     of scale wiring.
 *
 * It is generic marks with good defaults, NOT a closed set of chart types —
 * there is no `renderStandingsChart()` here and there must never be one.
 *
 * Everything below is written without template literals on purpose: the whole
 * thing lives inside `String.raw` and a stray backtick or `${` would end the
 * literal or interpolate.
 */

/** Source of the `apex` object, evaluated inside the frame before the model's code. */
export const APEX_VISUAL_RUNTIME = String.raw`
;(function (global) {
  'use strict';

  if (global.apex && global.apex.__runtime) return;

  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ==========================================================================
     Tokens — mirrors frontend/src/app/globals.css. If a value changes there it
     must change here; the frame cannot read the parent stylesheet.
     ========================================================================== */

  var FONT_BODY = '"Hanken Grotesk", system-ui, -apple-system, sans-serif';
  var FONT_HEAD = '"Bricolage Grotesque", system-ui, -apple-system, sans-serif';

  var tokens = {
    background: '#0a0908',
    onBackground: '#f6f1ea',
    surface: '#0a0908',
    surfaceContainerLowest: '#070605',
    surfaceContainerLow: '#14110e',
    surfaceContainer: '#1a1613',
    surfaceContainerHigh: '#221c17',
    surfaceContainerHighest: '#2a231d',
    surfaceVariant: '#2a231d',
    onSurfaceVariant: '#a89e90',

    primary: '#ffae6a',
    onPrimary: '#0a0908',
    primaryContainer: '#ff5a1f',
    flame: '#ff7a3d',
    flameBright: '#ff8a3d',
    flameLight: '#ffae6a',
    ember: '#e23a0e',
    veil: '#f5ebde',

    warm100: '#f6f1ea',
    warm200: '#c9c0b4',
    warm300: '#a89e90',
    warm400: '#8f867a',
    warm500: '#6f665b',
    warm600: '#5c554b',
    warm700: '#4a4239',

    outline: '#8f867a',
    outlineVariant: '#3a332b',
    error: '#ff9b8a',
    errorContainer: '#7a1c0a',
    onError: '#470c00',

    /* Hairlines. Grid sits at 7% so it reads as structure, not as a mark. */
    grid: 'rgba(255,255,255,0.07)',
    gridStrong: 'rgba(255,255,255,0.13)',
    hairline: 'rgba(255,255,255,0.10)',

    /* .apex-glass-soft, minus the backdrop-filter (there is nothing behind the
       frame to blur, so a filter would only cost paint time). */
    glassBg: 'rgba(40,32,26,0.34)',
    glassBorder: 'rgba(255,255,255,0.08)',
    glassInset: 'inset 0 1px 0 rgba(255,255,255,0.14)',

    radius: {
      hairline: 2, chip: 6, control: 10, tile: 14, card: 18, panel: 22
    },
    radiusHairline: '2px',
    radiusChip: '6px',
    radiusControl: '10px',
    radiusTile: '14px',
    radiusCard: '18px',
    radiusPanel: '22px',

    font: { headline: FONT_HEAD, body: FONT_BODY, label: FONT_BODY,
            mono: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    fontHeadline: FONT_HEAD,
    fontBody: FONT_BODY,
    fontLabel: FONT_BODY,

    ease: 'cubic-bezier(0.23, 1, 0.32, 1)',
    easeModal: 'cubic-bezier(0.2, 0.9, 0.2, 1)'
  };

  /* ==========================================================================
     Team colours — same matching rules as lib/team-colors.ts. Order matters:
     more specific names first so "Red Bull" does not fall through to "rb".
     ========================================================================== */

  var TEAM_COLORS = [
    ['mercedes', '#00D7B6'],
    ['ferrari', '#E80020'],
    ['mclaren', '#FF8000'],
    ['red bull', '#3671C6'],
    ['alpine', '#FF87BC'],
    ['williams', '#64C4FF'],
    ['aston martin', '#229971'],
    ['haas', '#B6BABD'],
    ['audi', '#52E252'],
    ['sauber', '#52E252'],
    ['cadillac', '#C4C4C4'],
    ['racing bulls', '#6692FF'],
    ['rb', '#6692FF']
  ];
  var TEAM_FALLBACK = '#FF5A1F';

  function teamColor(name) {
    var n = String(name == null ? '' : name).toLowerCase();
    for (var i = 0; i < TEAM_COLORS.length; i++) {
      if (n.indexOf(TEAM_COLORS[i][0]) !== -1) {
        return { hex: TEAM_COLORS[i][1], glow: TEAM_COLORS[i][1] + '66' };
      }
    }
    return { hex: TEAM_FALLBACK, glow: TEAM_FALLBACK + '66' };
  }

  /* Tyre compounds, matching components/tire-stints-chart.tsx. */
  var COMPOUNDS = {
    SOFT: '#FF3333', MEDIUM: '#FFE700', HARD: '#F0F0F0',
    INTERMEDIATE: '#39D54B', WET: '#0078FF', UNKNOWN: '#555555'
  };
  function compoundColor(c) {
    var k = String(c == null ? '' : c).toUpperCase();
    if (k === 'INTER') k = 'INTERMEDIATE';
    return COMPOUNDS[k] || COMPOUNDS.UNKNOWN;
  }

  /* Categorical series palette. Warm-led so it reads as APEX, then widened to
     hues that hold their own on #0a0908; past twelve it walks the hue circle
     at the golden angle with lightness fixed where dark-ground contrast is
     still comfortable. */
  var PALETTE = [
    '#ffae6a', '#ff5a1f', '#ffd26e', '#e23a0e', '#f5ebde', '#8fd8c4',
    '#6692ff', '#ff87bc', '#c9c0b4', '#52e252', '#64c4ff', '#b98aff'
  ];
  function seriesColor(i) {
    var n = Math.floor(Math.abs(Number(i) || 0));
    if (n < PALETTE.length) return PALETTE[n];
    var h = (n * 137.508) % 360;
    return 'hsl(' + h.toFixed(1) + ' 62% 68%)';
  }

  /* ==========================================================================
     Colour helpers
     ========================================================================== */

  function withAlpha(color, a) {
    var c = String(color || '');
    if (c.charAt(0) === '#') {
      var hex = c.slice(1);
      if (hex.length === 3) {
        hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) +
              hex.charAt(2) + hex.charAt(2);
      }
      if (hex.length === 8) hex = hex.slice(0, 6);
      if (hex.length === 6) {
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    if (c.indexOf('hsl(') === 0) return c.replace(')', ' / ' + a + ')');
    if (c.indexOf('rgb(') === 0) return c.replace('rgb(', 'rgba(').replace(')', ',' + a + ')');
    return c;
  }

  /* ==========================================================================
     Element helpers
     ========================================================================== */

  var SVG_KEEP_CAMEL = {
    viewBox: 1, preserveAspectRatio: 1, gradientUnits: 1, gradientTransform: 1,
    patternUnits: 1, patternContentUnits: 1, spreadMethod: 1, clipPathUnits: 1,
    markerWidth: 1, markerHeight: 1, refX: 1, refY: 1, startOffset: 1,
    baseFrequency: 1, numOctaves: 1, stdDeviation: 1, textLength: 1
  };

  function kebab(k) {
    if (SVG_KEEP_CAMEL[k]) return k;
    return k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); });
  }

  function applyStyle(node, style) {
    if (typeof style === 'string') { node.setAttribute('style', style); return; }
    for (var k in style) {
      if (!Object.prototype.hasOwnProperty.call(style, k)) continue;
      var v = style[k];
      if (v == null) continue;
      if (k.indexOf('--') === 0) node.style.setProperty(k, String(v));
      else node.style[k] = typeof v === 'number' && k !== 'zIndex' && k !== 'opacity'
        ? v + 'px' : String(v);
    }
  }

  function appendChildren(node, children) {
    if (children == null) return;
    var list = Array.isArray(children) ? children : [children];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) { appendChildren(node, c); continue; }
      node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }

  /** apex.el(tag, attrs, children) — an HTML element. */
  function el(tag, attrs, children) {
    var node = document.createElement(tag || 'div');
    var a = attrs || {};
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      var v = a[k];
      if (v == null || v === false) continue;
      if (k === 'style') { applyStyle(node, v); }
      else if (k === 'class' || k === 'className') { node.setAttribute('class', String(v)); }
      else if (k === 'text') { node.textContent = String(v); }
      else if (k === 'children') { appendChildren(node, v); }
      else if (k.indexOf('on') === 0 && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else { node.setAttribute(k, v === true ? '' : String(v)); }
    }
    appendChildren(node, children);
    return node;
  }

  /** apex.svg(tag, attrs, children) — an SVG element, camelCase attrs allowed. */
  function svgEl(tag, attrs, children) {
    var node = document.createElementNS(SVGNS, tag || 'g');
    var a = attrs || {};
    for (var k in a) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
      var v = a[k];
      if (v == null || v === false) continue;
      if (k === 'style') { applyStyle(node, v); }
      else if (k === 'text') { node.textContent = String(v); }
      else if (k === 'children') { appendChildren(node, v); }
      else if (k.indexOf('on') === 0 && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else { node.setAttribute(kebab(k), v === true ? '' : String(v)); }
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ==========================================================================
     Text measurement — a real canvas measurement where possible, because
     guessing is what makes axis labels collide.
     ========================================================================== */

  var measureCtx = null;
  function measureText(text, size, weight, family) {
    var s = size || 11;
    var w = weight || 600;
    var str = String(text == null ? '' : text);
    try {
      if (measureCtx === null) {
        var canvas = document.createElement('canvas');
        measureCtx = canvas.getContext ? canvas.getContext('2d') : false;
      }
      if (measureCtx) {
        measureCtx.font = w + ' ' + s + 'px ' + (family || FONT_BODY);
        return measureCtx.measureText(str).width;
      }
    } catch (e) { /* fall through to the estimate */ }
    return str.length * s * 0.58;
  }

  function truncateToWidth(text, maxPx, size, weight) {
    var str = String(text == null ? '' : text);
    if (measureText(str, size, weight) <= maxPx) return str;
    var lo = 0, hi = str.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (measureText(str.slice(0, mid) + '…', size, weight) <= maxPx) lo = mid;
      else hi = mid - 1;
    }
    return lo <= 1 ? '…' : str.slice(0, lo) + '…';
  }

  /* ==========================================================================
     Scales and ticks
     ========================================================================== */

  function niceNum(v) {
    var r = Number(v.toFixed(10));
    return r === 0 ? 0 : r;
  }

  function tickStep(min, max, count) {
    var n = Math.max(1, count || 5);
    var step0 = Math.abs(max - min) / n;
    if (!isFinite(step0) || step0 === 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var err = step0 / mag;
    if (err >= 7.5) mag *= 10;
    else if (err >= 3.5) mag *= 5;
    else if (err >= 1.5) mag *= 2;
    return mag;
  }

  /** apex.ticks(min, max, count) */
  function ticks(min, max, count) {
    var lo = Number(min), hi = Number(max);
    if (!isFinite(lo) || !isFinite(hi)) return [];
    if (lo === hi) return [niceNum(lo)];
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    var step = tickStep(lo, hi, count);
    var out = [];
    var start = Math.ceil(lo / step - 1e-9);
    var stop = Math.floor(hi / step + 1e-9);
    if (stop - start > 400) return [niceNum(lo), niceNum(hi)];
    for (var i = start; i <= stop; i++) out.push(niceNum(i * step));
    if (!out.length) out = [niceNum(lo), niceNum(hi)];
    return out;
  }

  function niceDomain(min, max, count) {
    var lo = Number(min), hi = Number(max);
    if (!isFinite(lo) || !isFinite(hi)) return [0, 1];
    if (lo === hi) {
      var pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.25 : 1;
      return [niceNum(lo - pad), niceNum(hi + pad)];
    }
    var step = tickStep(lo, hi, count || 5);
    return [niceNum(Math.floor(lo / step) * step), niceNum(Math.ceil(hi / step) * step)];
  }

  /** apex.scaleLinear({domain, range, clamp}) */
  function scaleLinear(cfg) {
    var c = cfg || {};
    var dom = (c.domain && c.domain.length === 2) ? [Number(c.domain[0]), Number(c.domain[1])] : [0, 1];
    var rng = (c.range && c.range.length === 2) ? [Number(c.range[0]), Number(c.range[1])] : [0, 1];
    var clamp = !!c.clamp;

    function s(v) {
      var t = (dom[1] === dom[0]) ? 0.5 : (Number(v) - dom[0]) / (dom[1] - dom[0]);
      if (clamp) t = Math.max(0, Math.min(1, t));
      return rng[0] + t * (rng[1] - rng[0]);
    }
    s.kind = 'linear';
    s.domain = dom;
    s.range = rng;
    s.invert = function (px) {
      var t = (rng[1] === rng[0]) ? 0 : (Number(px) - rng[0]) / (rng[1] - rng[0]);
      return dom[0] + t * (dom[1] - dom[0]);
    };
    s.ticks = function (n) { return ticks(dom[0], dom[1], n == null ? 5 : n); };
    s.nice = function (n) {
      return scaleLinear({ domain: niceDomain(dom[0], dom[1], n), range: rng, clamp: clamp });
    };
    s.center = s;
    return s;
  }

  /** apex.scaleBand({domain, range, padding, paddingOuter}) */
  function scaleBand(cfg) {
    var c = cfg || {};
    var dom = (c.domain || []).slice();
    var rng = (c.range && c.range.length === 2) ? [Number(c.range[0]), Number(c.range[1])] : [0, 1];
    var inner = c.padding == null ? 0.26 : Number(c.padding);
    var outer = c.paddingOuter == null ? inner : Number(c.paddingOuter);
    var n = dom.length;

    /* A reversed range is normal — SVG y grows downward, so a plot that wants
       its first category at the top hands this [bottom, top]. Compute on the
       sorted range and walk the domain backwards, so 'bandwidth()' is never
       negative. Getting this wrong drew every horizontal bar at height 0. */
    var reversed = rng[1] < rng[0];
    var lo = Math.min(rng[0], rng[1]);
    var hi = Math.max(rng[0], rng[1]);
    var span = hi - lo;
    var step = n ? span / Math.max(1, n - inner + outer * 2) : 0;
    var bw = Math.max(0, step * (1 - inner));
    var start = lo + (span - step * (n - inner)) / 2;

    var index = {};
    for (var i = 0; i < n; i++) index['k' + String(dom[i])] = i;

    function s(v) {
      var i2 = index['k' + String(v)];
      if (i2 === undefined) return undefined;
      return start + (reversed ? (n - 1 - i2) : i2) * step;
    }
    s.kind = 'band';
    s.domain = dom;
    s.range = rng;
    s.step = function () { return step; };
    s.bandwidth = function () { return bw; };
    s.padding = inner;
    s.center = function (v) { var p = s(v); return p === undefined ? undefined : p + bw / 2; };
    s.ticks = function () { return dom.slice(); };
    s.invert = function (px) {
      if (!n || step === 0) return undefined;
      var i3 = Math.floor((Number(px) - start) / step);
      i3 = Math.max(0, Math.min(n - 1, i3));
      return dom[reversed ? (n - 1 - i3) : i3];
    };
    s.nice = function () { return s; };
    return s;
  }

  /* ==========================================================================
     Formatting — mirrors the rest of the site.
     ========================================================================== */

  var DASH = '—';
  var MINUS = '−';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                     'August', 'September', 'October', 'November', 'December'];

  function isNum(v) { return v != null && v !== '' && isFinite(Number(v)); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** m:ss.mmm above a minute, ss.sss + "s" below it — same rule as pit-stops-chart.tsx. */
  function fmtLapTime(seconds) {
    if (!isNum(seconds)) return DASH;
    var v = Number(seconds);
    var sign = v < 0 ? MINUS : '';
    v = Math.abs(v);
    if (v < 60) return sign + v.toFixed(3) + 's';
    var m = Math.floor(v / 60);
    if (m < 60) return sign + m + ':' + (v - m * 60).toFixed(3).padStart(6, '0');
    var h = Math.floor(m / 60);
    return sign + h + ':' + pad2(m - h * 60) + ':' + (v - m * 60).toFixed(3).padStart(6, '0');
  }

  /** A gap behind: "+1.284s", "+1:02.415". Zero reads as a dash (the leader). */
  function fmtGap(seconds, opts) {
    if (!isNum(seconds)) return DASH;
    var v = Number(seconds);
    var o = opts || {};
    if (v === 0 && o.zero !== false) return o.zeroLabel || DASH;
    var body = fmtLapTime(Math.abs(v));
    return (v < 0 ? MINUS : '+') + body;
  }

  /** A signed difference: "+0.284", "−0.113". No unit — deltas get axis labels. */
  function fmtDelta(value, digits) {
    if (!isNum(value)) return DASH;
    var v = Number(value);
    var d = digits == null ? 3 : digits;
    if (v === 0) return '0' + (d > 0 ? '.' + '0'.repeat(d) : '');
    return (v < 0 ? MINUS : '+') + Math.abs(v).toFixed(d);
  }

  function fmtOrdinal(n) {
    if (!isNum(n)) return DASH;
    var v = Math.round(Number(n));
    var abs = Math.abs(v) % 100;
    var suffix = 'th';
    if (abs < 11 || abs > 13) {
      var last = abs % 10;
      suffix = last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
    }
    return v + suffix;
  }

  /** Championship points: integers stay integers, half-points keep their half. */
  function fmtPoints(n) {
    if (!isNum(n)) return DASH;
    var v = Number(n);
    var s = (Math.abs(v % 1) < 1e-9) ? String(Math.round(v)) : v.toFixed(1);
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function toDate(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') { var d0 = new Date(v); return isNaN(d0.getTime()) ? null : d0; }
    if (typeof v === 'string') {
      var s = v.trim();
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (m && s.length === 10) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      var d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  /** date(v) -> "23 Aug 2026"; styles: short | long | month | year | time | iso */
  function fmtDate(v, style) {
    var d = toDate(v);
    if (!d) return DASH;
    var st = style || 'medium';
    if (st === 'short') return d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (st === 'long') return d.getDate() + ' ' + MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();
    if (st === 'month') return MONTHS[d.getMonth()];
    if (st === 'year') return String(d.getFullYear());
    if (st === 'time') return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (st === 'iso') return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtNumber(v, digits) {
    if (!isNum(v)) return DASH;
    var n = Number(v);
    var s = digits == null
      ? (Math.abs(n % 1) < 1e-9 ? String(Math.round(n)) : String(niceNum(n)))
      : n.toFixed(digits);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function fmtPct(v, digits) {
    if (!isNum(v)) return DASH;
    return Number(v).toFixed(digits == null ? 0 : digits) + '%';
  }

  /** Compact axis labels: 1.2k, 3.4M. Used automatically on big linear axes. */
  function fmtCompact(v) {
    if (!isNum(v)) return DASH;
    var n = Number(v);
    var a = Math.abs(n);
    if (a >= 1e9) return niceNum(n / 1e9) + 'B';
    if (a >= 1e6) return niceNum(n / 1e6) + 'M';
    if (a >= 1e4) return niceNum(n / 1e3) + 'k';
    return fmtNumber(n);
  }

  var fmt = {
    lapTime: fmtLapTime,
    gap: fmtGap,
    delta: fmtDelta,
    ordinal: fmtOrdinal,
    points: fmtPoints,
    date: fmtDate,
    number: fmtNumber,
    pct: fmtPct,
    compact: fmtCompact
  };

  /* ==========================================================================
     Motion
     ========================================================================== */

  function reducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /**
   * apex.animate(node, keyframes, opts)
   *
   * A NO-OP under prefers-reduced-motion, not a shortened animation: marks draw
   * themselves at their final state and use this only for the entrance, so
   * skipping it entirely leaves the correct picture on screen.
   */
  function animate(node, keyframes, opts) {
    if (!node || !keyframes) return null;
    if (reducedMotion()) return null;
    if (typeof node.animate !== 'function') return null;
    var o = opts || {};
    try {
      return node.animate(keyframes, {
        duration: Math.min(4000, o.duration == null ? 640 : Number(o.duration) || 0),
        delay: Math.min(3000, Math.max(0, Number(o.delay) || 0)),
        easing: o.easing || tokens.ease,
        fill: o.fill || 'both',
        iterations: o.iterations == null ? 1 : o.iterations
      });
    } catch (e) { return null; }
  }

  /* ==========================================================================
     Chrome: panel, caption, legend, tooltip
     ========================================================================== */

  /** apex.panel({mount, title, subtitle, padding, tone}) -> the glass surface div. */
  function panel(opts) {
    var o = opts || {};
    var pad = o.padding == null ? 18 : o.padding;
    var box = el('div', {
      class: 'apex-panel',
      style: {
        position: 'relative',
        boxSizing: 'border-box',
        background: o.background || tokens.glassBg,
        border: '1px solid ' + (o.border || tokens.glassBorder),
        borderRadius: (o.radius == null ? tokens.radius.card : o.radius) + 'px',
        boxShadow: tokens.glassInset,
        padding: pad + 'px',
        color: tokens.warm100,
        fontFamily: FONT_BODY,
        overflow: 'hidden'
      }
    });

    if (o.sheen !== false) {
      box.appendChild(el('div', {
        style: {
          position: 'absolute', inset: '0', borderRadius: 'inherit',
          pointerEvents: 'none',
          background: 'linear-gradient(140deg, rgba(255,255,255,0.07), transparent 46%)'
        }
      }));
    }

    if (o.title || o.subtitle) {
      var head = el('div', { style: { position: 'relative', marginBottom: '14px' } });
      if (o.title) {
        head.appendChild(el('div', {
          text: o.title,
          style: {
            fontFamily: FONT_HEAD, fontWeight: '700', fontSize: '15px',
            letterSpacing: '-0.2px', color: tokens.warm100, lineHeight: '1.25'
          }
        }));
      }
      if (o.subtitle) {
        head.appendChild(el('div', {
          text: o.subtitle,
          style: {
            marginTop: '4px', fontSize: '12px', lineHeight: '1.5', color: tokens.warm400
          }
        }));
      }
      box.appendChild(head);
    }

    if (o.mount) o.mount.appendChild(box);
    return box;
  }

  /** apex.caption(text, {mount, tone}) -> the small uppercase caption line. */
  function caption(text, opts) {
    var o = opts || {};
    var node = el('div', {
      text: text == null ? '' : String(text),
      style: {
        marginTop: o.marginTop == null ? '10px' : o.marginTop + 'px',
        fontSize: '10px',
        fontWeight: '600',
        letterSpacing: '0.09em',
        textTransform: o.upper === false ? 'none' : 'uppercase',
        color: o.tone === 'bright' ? tokens.warm300 : tokens.warm500,
        lineHeight: '1.5'
      }
    });
    if (o.mount) o.mount.appendChild(node);
    return node;
  }

  /**
   * apex.legend(items, {mount, shape})
   * items: [{label, color, shape}] or ["a","b"] (palette-coloured in order).
   * Wraps; never scrolls; never clipped.
   */
  function legend(items, opts) {
    var o = opts || {};
    var list = items || [];
    var wrap = el('div', {
      class: 'apex-legend',
      style: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center',
        gap: '6px 14px',
        marginTop: o.marginTop == null ? '12px' : o.marginTop + 'px',
        fontSize: '10.5px', fontWeight: '700',
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: tokens.warm300, lineHeight: '1.4'
      }
    });
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var label = typeof it === 'string' ? it : (it && it.label != null ? it.label : '');
      var color = (it && it.color) || seriesColor(i);
      var shape = (it && it.shape) || o.shape || 'swatch';
      var swatch;
      if (shape === 'line') {
        swatch = el('span', { style: {
          width: '14px', height: '2.5px', borderRadius: '2px',
          background: color, flex: '0 0 auto'
        } });
      } else if (shape === 'dot') {
        swatch = el('span', { style: {
          width: '8px', height: '8px', borderRadius: '999px',
          background: color, flex: '0 0 auto'
        } });
      } else {
        swatch = el('span', { style: {
          width: '9px', height: '9px', borderRadius: '3px',
          background: color, flex: '0 0 auto',
          boxShadow: '0 0 10px ' + withAlpha(color, 0.35)
        } });
      }
      wrap.appendChild(el('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }
      }, [swatch, el('span', { text: String(label) })]));
    }
    if (o.mount) o.mount.appendChild(wrap);
    return wrap;
  }

  /**
   * apex.tooltip(container) -> {node, show(x, y, content), hide(), destroy()}
   *
   * 'content' may be a string, a Node, or an array of rows
   * ({label, value, color} | string). Positioned against 'container', which is
   * forced to position:relative, and clamped so it cannot clip at frame edges.
   */
  function tooltip(container) {
    var host = container || document.body;
    if (host && host.style && !host.style.position) host.style.position = 'relative';

    var node = el('div', {
      class: 'apex-tooltip',
      style: {
        position: 'absolute', top: '0px', left: '0px',
        pointerEvents: 'none', opacity: '0',
        transform: 'translate(-9999px, -9999px)',
        zIndex: '20',
        maxWidth: '260px',
        boxSizing: 'border-box',
        padding: '9px 11px',
        borderRadius: tokens.radiusControl,
        background: 'rgba(26,22,19,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 18px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.10)',
        color: tokens.warm100,
        fontFamily: FONT_BODY,
        fontSize: '12px',
        lineHeight: '1.45',
        transition: reducedMotion() ? 'none' : 'opacity 120ms ' + tokens.ease
      }
    });
    host.appendChild(node);

    function render(content) {
      clear(node);
      if (content == null) return;
      if (content.nodeType) { node.appendChild(content); return; }
      if (!Array.isArray(content)) {
        var lines = String(content).split('\n');
        for (var li = 0; li < lines.length; li++) {
          node.appendChild(el('div', {
            text: lines[li],
            style: li === 0
              ? { fontWeight: '700', fontFamily: FONT_HEAD, fontSize: '13px', marginBottom: lines.length > 1 ? '5px' : '0' }
              : { color: tokens.warm300, fontVariantNumeric: 'tabular-nums' }
          }));
        }
        return;
      }
      for (var i = 0; i < content.length; i++) {
        var row = content[i];
        if (row == null) continue;
        if (typeof row === 'string' || row.nodeType) {
          node.appendChild(row.nodeType ? row : el('div', {
            text: row,
            style: i === 0
              ? { fontWeight: '700', fontFamily: FONT_HEAD, fontSize: '13px', marginBottom: '5px' }
              : { color: tokens.warm300 }
          }));
          continue;
        }
        if (row.title) {
          node.appendChild(el('div', {
            text: row.title,
            style: { fontWeight: '700', fontFamily: FONT_HEAD, fontSize: '13px', marginBottom: '5px' }
          }));
          continue;
        }
        var line = el('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '7px',
            marginTop: i === 0 ? '0' : '3px', whiteSpace: 'nowrap'
          }
        });
        if (row.color) {
          line.appendChild(el('span', { style: {
            width: '8px', height: '8px', borderRadius: '2px',
            background: row.color, flex: '0 0 auto'
          } }));
        }
        line.appendChild(el('span', {
          text: row.label == null ? '' : String(row.label),
          style: { color: tokens.warm400, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }
        }));
        line.appendChild(el('span', {
          text: row.value == null ? '' : String(row.value),
          style: { fontWeight: '700', color: tokens.warm100, fontVariantNumeric: 'tabular-nums' }
        }));
        node.appendChild(line);
      }
    }

    var api = {
      node: node,
      show: function (x, y, content) {
        if (content !== undefined) render(content);
        node.style.opacity = '1';
        var w = node.offsetWidth || 0;
        var h = node.offsetHeight || 0;
        var hostW = host.clientWidth || w;
        var hostH = host.clientHeight || h;
        var left = x + 14;
        var topPx = y - h - 12;
        if (left + w > hostW - 4) left = x - w - 14;
        if (left < 4) left = 4;
        if (topPx < 4) topPx = y + 18;
        if (topPx + h > hostH - 4) topPx = Math.max(4, hostH - h - 4);
        node.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(topPx) + 'px)';
        return api;
      },
      hide: function () {
        node.style.opacity = '0';
        node.style.transform = 'translate(-9999px,-9999px)';
        return api;
      },
      set: function (content) { render(content); return api; },
      destroy: function () { if (node.parentNode) node.parentNode.removeChild(node); }
    };
    return api;
  }

  /* ==========================================================================
     Axes and gridlines
     ========================================================================== */

  var TICK_SIZE = 11;
  var TICK_WEIGHT = 600;

  function axisTickValues(scale, cfg) {
    if (cfg.values) return cfg.values.slice();
    if (scale.kind === 'band') return scale.domain.slice();
    return scale.ticks(cfg.count == null ? 5 : cfg.count);
  }

  function defaultFormat(scale) {
    if (scale.kind === 'band') return function (v) { return String(v); };
    return function (v) { return fmtCompact(v); };
  }

  /**
   * Decide, once, how bottom-axis labels fit: straight, every-nth, or rotated.
   * Both 'axis()' and 'plot()' call this so the margin the plot reserves is the
   * one the axis actually needs.
   */
  function planBottomLabels(scale, values, format, availableWidth) {
    var slot = scale.kind === 'band'
      ? scale.step()
      : (values.length > 1 ? Math.abs(availableWidth / values.length) : availableWidth);
    var widest = 0;
    var texts = [];
    for (var i = 0; i < values.length; i++) {
      var t = format(values[i]);
      texts.push(t);
      var w = measureText(t, TICK_SIZE, TICK_WEIGHT);
      if (w > widest) widest = w;
    }
    var plan = { texts: texts, widest: widest, step: 1, rotate: 0, height: 16, maxWidth: Infinity };
    if (!values.length) { plan.height = 0; return plan; }

    if (widest + 8 <= slot) return plan;

    /* Thin first — dropping every other tick keeps labels horizontal, which is
       always easier to read than a rotated one. Band scales are not thinned:
       a category axis with half its names missing is a worse chart. */
    if (scale.kind !== 'band') {
      var stepN = Math.ceil((widest + 10) / Math.max(1, slot));
      if (stepN <= 4) { plan.step = stepN; return plan; }
    }

    plan.rotate = -38;
    plan.maxWidth = 96;
    var shown = Math.min(widest, plan.maxWidth);
    plan.height = Math.round(Math.sin(38 * Math.PI / 180) * shown + 12);
    if (scale.kind === 'band' && slot < 11) {
      plan.step = Math.ceil(11 / Math.max(1, slot));
    }
    return plan;
  }

  /**
   * apex.axis({scale, orient, at, length, values, count, format, label,
   *            tickSize, line, plan}) -> <g>
   */
  function axis(cfg) {
    var c = cfg || {};
    var scale = c.scale;
    var g = svgEl('g', { class: 'apex-axis' });
    if (!scale) return g;

    var orient = c.orient || 'bottom';
    var horizontal = orient === 'bottom' || orient === 'top';
    var at = Number(c.at) || 0;
    var format = c.format || defaultFormat(scale);
    var values = axisTickValues(scale, c);
    var tickSize = c.tickSize == null ? 4 : c.tickSize;
    var color = c.color || tokens.warm500;

    if (c.line !== false) {
      var r0 = scale.range[0], r1 = scale.range[1];
      g.appendChild(svgEl('line', horizontal
        ? { x1: r0, y1: at, x2: r1, y2: at, stroke: tokens.hairline, strokeWidth: 1, shapeRendering: 'crispEdges' }
        : { x1: at, y1: r0, x2: at, y2: r1, stroke: tokens.hairline, strokeWidth: 1, shapeRendering: 'crispEdges' }
      ));
    }

    var pos = function (v) {
      return scale.kind === 'band' ? scale.center(v) : scale(v);
    };

    if (horizontal) {
      var plan = c.plan || planBottomLabels(scale, values, format,
        Math.abs(scale.range[1] - scale.range[0]));
      for (var i = 0; i < values.length; i++) {
        if (i % plan.step !== 0 && i !== values.length - 1) continue;
        if (plan.step > 1 && i === values.length - 1 && i % plan.step !== 0 &&
            values.length > 1 && (i - Math.floor(i / plan.step) * plan.step) < plan.step / 2) continue;
        var px = pos(values[i]);
        if (px === undefined || !isFinite(px)) continue;
        var text = plan.texts[i];
        if (plan.maxWidth !== Infinity) text = truncateToWidth(text, plan.maxWidth, TICK_SIZE, TICK_WEIGHT);
        var dir = orient === 'bottom' ? 1 : -1;
        if (tickSize > 0) {
          g.appendChild(svgEl('line', {
            x1: px, y1: at, x2: px, y2: at + dir * tickSize,
            stroke: tokens.hairline, strokeWidth: 1, shapeRendering: 'crispEdges'
          }));
        }
        var ty = at + dir * (tickSize + (orient === 'bottom' ? 12 : 4));
        var attrs = {
          x: px, y: ty,
          textAnchor: plan.rotate ? 'end' : 'middle',
          fill: color, fontSize: TICK_SIZE, fontWeight: TICK_WEIGHT,
          fontFamily: FONT_BODY,
          style: { fontVariantNumeric: 'tabular-nums' }
        };
        if (plan.rotate) {
          attrs.transform = 'rotate(' + plan.rotate + ' ' + px.toFixed(1) + ' ' + ty.toFixed(1) + ')';
        }
        g.appendChild(svgEl('text', attrs, text));
      }
      if (c.label) {
        var mid = (scale.range[0] + scale.range[1]) / 2;
        g.appendChild(svgEl('text', {
          x: mid,
          y: at + (orient === 'bottom' ? 1 : -1) * ((c.plan ? c.plan.height : 16) + tickSize + 16),
          textAnchor: 'middle', fill: tokens.warm600,
          fontSize: 10, fontWeight: 700, fontFamily: FONT_BODY,
          letterSpacing: '0.09em', style: { textTransform: 'uppercase' }
        }, String(c.label).toUpperCase()));
      }
      return g;
    }

    /* Vertical */
    var dirV = orient === 'left' ? -1 : 1;
    for (var j = 0; j < values.length; j++) {
      var py = pos(values[j]);
      if (py === undefined || !isFinite(py)) continue;
      var label = format(values[j]);
      if (c.maxLabelWidth) label = truncateToWidth(label, c.maxLabelWidth, TICK_SIZE, TICK_WEIGHT);
      if (tickSize > 0) {
        g.appendChild(svgEl('line', {
          x1: at, y1: py, x2: at + dirV * tickSize, y2: py,
          stroke: tokens.hairline, strokeWidth: 1, shapeRendering: 'crispEdges'
        }));
      }
      g.appendChild(svgEl('text', {
        x: at + dirV * (tickSize + 6), y: py + 4,
        textAnchor: orient === 'left' ? 'end' : 'start',
        fill: color, fontSize: TICK_SIZE, fontWeight: TICK_WEIGHT, fontFamily: FONT_BODY,
        style: { fontVariantNumeric: 'tabular-nums' }
      }, label));
    }
    if (c.label) {
      var midV = (scale.range[0] + scale.range[1]) / 2;
      var lx = at + dirV * ((c.labelOffset == null ? 46 : c.labelOffset));
      g.appendChild(svgEl('text', {
        x: lx, y: midV,
        textAnchor: 'middle', fill: tokens.warm600,
        fontSize: 10, fontWeight: 700, fontFamily: FONT_BODY,
        letterSpacing: '0.09em',
        transform: 'rotate(-90 ' + lx.toFixed(1) + ' ' + midV.toFixed(1) + ')'
      }, String(c.label).toUpperCase()));
    }
    return g;
  }

  /**
   * apex.gridlines({scale, orient, length, values, count, from})
   * Hairlines only. Append this layer BEFORE the marks layer — it must sit
   * behind everything it is measuring.
   */
  function gridlines(cfg) {
    var c = cfg || {};
    var scale = c.scale;
    var g = svgEl('g', { class: 'apex-grid' });
    if (!scale) return g;
    var orient = c.orient || 'left';
    var values = c.values || (scale.kind === 'band' ? [] : scale.ticks(c.count == null ? 5 : c.count));
    var from = Number(c.from) || 0;
    var to = c.length == null ? 100 : from + Number(c.length);
    for (var i = 0; i < values.length; i++) {
      var p = scale.kind === 'band' ? scale.center(values[i]) : scale(values[i]);
      if (p === undefined || !isFinite(p)) continue;
      var isZero = c.zero !== false && Math.abs(Number(values[i])) < 1e-9;
      var attrs = (orient === 'left' || orient === 'right')
        ? { x1: from, y1: p, x2: to, y2: p }
        : { x1: p, y1: from, x2: p, y2: to };
      attrs.stroke = isZero ? tokens.gridStrong : (c.color || tokens.grid);
      attrs.strokeWidth = 1;
      attrs.shapeRendering = 'crispEdges';
      if (c.dashed) attrs.strokeDasharray = '3 4';
      g.appendChild(svgEl('line', attrs));
    }
    return g;
  }

  /* ==========================================================================
     Accessors, extents
     ========================================================================== */

  function accessor(spec, fallback) {
    if (typeof spec === 'function') return spec;
    if (typeof spec === 'string') {
      return function (d) { return d == null ? undefined : d[spec]; };
    }
    if (spec == null && fallback !== undefined) return accessor(fallback);
    return function (d) { return d; };
  }

  function extent(values) {
    var lo = Infinity, hi = -Infinity, seen = false;
    for (var i = 0; i < values.length; i++) {
      var v = Number(values[i]);
      if (!isFinite(v)) continue;
      seen = true;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return seen ? [lo, hi] : [0, 1];
  }

  /* ==========================================================================
     plot() — the layout engine every mark hangs off.
     ========================================================================== */

  var EMPTY_TEXT = 'No data to plot';

  function emptyState(mount, message, opts) {
    var o = opts || {};
    var box = panel({
      padding: 0,
      background: 'transparent',
      border: 'rgba(255,255,255,0.06)',
      sheen: false
    });
    box.style.display = 'flex';
    box.style.alignItems = 'center';
    box.style.justifyContent = 'center';
    box.style.minHeight = (o.height || 140) + 'px';
    box.style.backgroundImage =
      'repeating-linear-gradient(135deg, rgba(245,235,222,0.035) 0 8px, transparent 8px 16px)';
    box.appendChild(el('div', {
      text: message || EMPTY_TEXT,
      style: {
        position: 'relative', fontSize: '12px', fontWeight: '600',
        letterSpacing: '0.06em', color: tokens.warm500, textAlign: 'center',
        padding: '0 16px'
      }
    }));
    if (mount) mount.appendChild(box);
    return box;
  }

  function buildScale(spec, range, values) {
    var s = spec || {};
    var type = s.type;
    if (!type) {
      var allNum = values.length > 0;
      for (var i = 0; i < values.length; i++) {
        if (!isNum(values[i])) { allNum = false; break; }
      }
      type = allNum ? 'linear' : 'band';
    }
    if (type === 'band') {
      var dom = s.domain;
      if (!dom) {
        dom = [];
        var seen = {};
        for (var j = 0; j < values.length; j++) {
          var k = String(values[j]);
          if (!seen[k]) { seen[k] = 1; dom.push(values[j]); }
        }
      }
      return scaleBand({ domain: dom, range: range, padding: s.padding, paddingOuter: s.paddingOuter });
    }
    /* 'zero' is opt-IN. A bar chart must be anchored at zero and asks for it;
       a lap-time or gap axis anchored at zero is a wasted plot. */
    var d = s.domain;
    var tickCount = null;
    if (!d) {
      d = extent(values);
      if (s.zero === true && d[0] > 0) d[0] = 0;
      if (s.zero === true && d[1] < 0) d[1] = 0;
      if (d[0] === d[1]) {
        /* One distinct value. Widen by a unit so it is not on the axis line,
           and ask for few ticks so the padding does not read as fake precision. */
        var unit = Math.abs(d[0]) >= 1 && Math.abs(d[0] % 1) < 1e-9 ? 1 : Math.max(1e-6, Math.abs(d[0]) * 0.1 || 1);
        d = [d[0] - unit, d[1] + unit];
        tickCount = 2;
      } else if (s.nice !== false) {
        d = niceDomain(d[0], d[1], s.count == null ? 5 : s.count);
      }
    }
    var sc = scaleLinear({ domain: d, range: range, clamp: !!s.clamp });
    if (tickCount) sc.tickCount = tickCount;
    return sc;
  }

  /**
   * apex.plot(cfg) -> chart context
   *
   * cfg: { mount, width, height, title, subtitle, note, padding, frame,
   *        x: {type,domain,values,label,format,count,zero,nice,padding},
   *        y: {...}, margin: {top,right,bottom,left} }
   *
   * Returns { root, svg, grid, marks, overlay, x, y, w, h, margin, tip,
   *           bars, hbars, lines, area, dots, rule, text, legend, caption,
   *           empty, px, py, color }
   */
  function plot(cfg) {
    var c = cfg || {};
    var mount = c.mount;
    var outerWidth = Math.max(200, Math.floor(
      c.width || (mount && mount.clientWidth) || 600
    ));

    var pad = c.padding == null ? 18 : c.padding;
    var framed = c.frame !== false;
    var root = framed
      ? panel({ padding: pad, title: c.title, subtitle: c.subtitle })
      : el('div', { style: { position: 'relative', fontFamily: FONT_BODY, color: tokens.warm100 } });
    if (!framed && (c.title || c.subtitle)) {
      if (c.title) root.appendChild(el('div', { text: c.title, style: {
        fontFamily: FONT_HEAD, fontWeight: '700', fontSize: '15px', marginBottom: '4px'
      } }));
      if (c.subtitle) root.appendChild(el('div', { text: c.subtitle, style: {
        fontSize: '12px', color: tokens.warm400, marginBottom: '10px'
      } }));
    }
    root.style.width = '100%';
    root.style.maxWidth = '100%';

    var innerWidth = Math.max(160, outerWidth - (framed ? pad * 2 + 2 : 0));
    var svgHeight = Math.round(c.height == null
      ? Math.max(200, Math.min(400, innerWidth * 0.56))
      : c.height);

    /* --- margins ---------------------------------------------------------
       Reserve exactly what the axis labels will occupy, measured rather than
       guessed, so nothing collides at 320px and nothing floats at 900px. */

    var xSpec = c.x || {};
    var ySpec = c.y || {};

    /* Provisional ranges so scales exist for the measuring pass. */
    var yScale0 = buildScale(ySpec, [svgHeight, 0], ySpec.values || []);
    var yCount = ySpec.count == null ? (yScale0.tickCount || 5) : ySpec.count;
    var yFormat = ySpec.format || defaultFormat(yScale0);
    var yVals0 = axisTickValues(yScale0, { count: yCount, values: ySpec.tickValues });
    var yLabelW = 0;
    for (var i = 0; i < yVals0.length; i++) {
      yLabelW = Math.max(yLabelW, measureText(yFormat(yVals0[i]), TICK_SIZE, TICK_WEIGHT));
    }
    yLabelW = Math.min(yLabelW, 120);

    var m = c.margin || {};
    var mLeft = m.left == null
      ? Math.ceil((ySpec.axis === false ? 2 : yLabelW + 12) + (ySpec.label ? 16 : 0))
      : m.left;
    var mRight = m.right == null ? 12 : m.right;
    var mTop = m.top == null ? (c.valueLabels === false ? 10 : 16) : m.top;

    var xRange = [mLeft, Math.max(mLeft + 20, innerWidth - mRight)];
    var xValues = xSpec.values || [];
    var xScale = buildScale(xSpec, xRange, xValues);
    var xFormat = xSpec.format || defaultFormat(xScale);
    var xCount = xSpec.count == null ? (xScale.tickCount || 6) : xSpec.count;
    var xVals = axisTickValues(xScale, { count: xCount, values: xSpec.tickValues });
    var xPlan = planBottomLabels(xScale, xVals, xFormat, xRange[1] - xRange[0]);

    /* A rotated label leans LEFT of its tick, so the first one runs off the
       panel unless the left margin knows about it. Widen once, then re-plan
       against the room that actually exists — and cap the label width to that
       room, so anything still too long is ellipsised rather than clipped. */
    if (xPlan.rotate && m.left == null) {
      var COS38 = 0.788, halfSlot = (xScale.kind === 'band' ? xScale.step() : 0) / 2;
      var leftReach = COS38 * Math.min(xPlan.widest, 96);
      var room = mLeft + halfSlot - 4;
      if (leftReach > room) {
        mLeft += Math.min(44, Math.ceil(leftReach - room));
        xRange = [mLeft, Math.max(mLeft + 20, innerWidth - mRight)];
        xScale = buildScale(xSpec, xRange, xValues);
        xVals = axisTickValues(xScale, { count: xCount, values: xSpec.tickValues });
        xPlan = planBottomLabels(xScale, xVals, xFormat, xRange[1] - xRange[0]);
        halfSlot = (xScale.kind === 'band' ? xScale.step() : 0) / 2;
      }
      if (xPlan.rotate) {
        var fits = Math.max(28, (mLeft + halfSlot - 4) / COS38);
        xPlan.maxWidth = Math.min(xPlan.maxWidth, fits);
        var shown = Math.min(xPlan.widest, xPlan.maxWidth);
        xPlan.height = Math.round(Math.sin(38 * Math.PI / 180) * shown + 12);
      }
    }

    var mBottom = m.bottom == null
      ? Math.ceil((xSpec.axis === false ? 6 : xPlan.height + 8) + (xSpec.label ? 18 : 0))
      : m.bottom;

    var innerH = Math.max(60, svgHeight - mTop - mBottom);
    /* Categories read downward from the top; magnitudes grow upward. */
    var yRange = yScale0.kind === 'band' ? [mTop, mTop + innerH] : [mTop + innerH, mTop];
    var yScale = buildScale(ySpec, yRange, ySpec.values || []);

    var svg = svgEl('svg', {
      width: '100%',
      height: svgHeight,
      viewBox: '0 0 ' + innerWidth + ' ' + svgHeight,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      style: { display: 'block', overflow: 'visible', maxWidth: '100%' }
    });
    if (c.ariaLabel || c.title) {
      svg.appendChild(svgEl('title', {}, String(c.ariaLabel || c.title)));
    }

    var defs = svgEl('defs');
    var gridLayer = svgEl('g', { class: 'apex-layer-grid' });
    var axisLayer = svgEl('g', { class: 'apex-layer-axis' });
    var markLayer = svgEl('g', { class: 'apex-layer-marks' });
    var overlayLayer = svgEl('g', { class: 'apex-layer-overlay' });
    svg.appendChild(defs);
    svg.appendChild(gridLayer);   /* behind */
    svg.appendChild(axisLayer);
    svg.appendChild(markLayer);
    svg.appendChild(overlayLayer);

    var svgWrap = el('div', { style: { position: 'relative', width: '100%' } }, [svg]);
    root.appendChild(svgWrap);

    if (ySpec.grid !== false && yScale.kind !== 'band') {
      gridLayer.appendChild(gridlines({
        scale: yScale, orient: 'left', from: xRange[0], length: xRange[1] - xRange[0],
        count: yCount, values: ySpec.tickValues
      }));
    }
    if (xSpec.grid === true) {
      gridLayer.appendChild(gridlines({
        scale: xScale, orient: 'bottom', from: mTop, length: innerH,
        values: xVals, zero: false
      }));
    }

    if (ySpec.axis !== false) {
      axisLayer.appendChild(axis({
        scale: yScale, orient: 'left', at: xRange[0], tickSize: 0,
        format: yFormat, values: ySpec.tickValues,
        count: yCount,
        label: ySpec.label, labelOffset: yLabelW + 22,
        maxLabelWidth: 120
      }));
    }
    if (xSpec.axis !== false) {
      axisLayer.appendChild(axis({
        scale: xScale, orient: 'bottom', at: mTop + innerH,
        format: xFormat, values: xVals, plan: xPlan, label: xSpec.label,
        tickSize: xScale.kind === 'band' ? 0 : 4
      }));
    }

    var tip = tooltip(svgWrap);
    var ctx = {
      root: root,
      wrap: svgWrap,
      svg: svg,
      defs: defs,
      grid: gridLayer,
      axes: axisLayer,
      marks: markLayer,
      overlay: overlayLayer,
      x: xScale,
      y: yScale,
      width: innerWidth,
      height: svgHeight,
      w: xRange[1] - xRange[0],
      h: innerH,
      margin: { top: mTop, right: mRight, bottom: mBottom, left: mLeft },
      tip: tip
    };

    ctx.px = function (v) { return xScale.kind === 'band' ? xScale.center(v) : xScale(v); };
    ctx.py = function (v) { return yScale.kind === 'band' ? yScale.center(v) : yScale(v); };

    ctx.legend = function (items, opts) {
      var o = opts || {};
      o.mount = root;
      return legend(items, o);
    };
    ctx.caption = function (text, opts) {
      var o = opts || {};
      o.mount = root;
      return caption(text, o);
    };
    ctx.empty = function (message) {
      clear(root);
      emptyState(root, message, { height: svgHeight });
      return ctx;
    };

    /* --- pointer plumbing shared by the marks ------------------------- */
    function svgPoint(event) {
      var rect = svg.getBoundingClientRect();
      var sx = rect.width ? innerWidth / rect.width : 1;
      var sy = rect.height ? svgHeight / rect.height : 1;
      return {
        x: (event.clientX - rect.left) * sx,
        y: (event.clientY - rect.top) * sy,
        localX: event.clientX - rect.left,
        localY: event.clientY - rect.top
      };
    }
    ctx.point = svgPoint;

    function bindTip(node, contentFor) {
      node.style.cursor = 'default';
      node.addEventListener('pointerenter', function () {
        if (node.setAttribute) node.setAttribute('data-hover', '1');
      });
      node.addEventListener('pointermove', function (ev) {
        var p = svgPoint(ev);
        tip.show(p.localX, p.localY, contentFor(ev));
      });
      node.addEventListener('pointerleave', function () { tip.hide(); });
    }
    ctx.bindTip = bindTip;

    /* --- marks -------------------------------------------------------- */

    /** ctx.bars(data, {x, y, color, label, tip, radius, base}) */
    ctx.bars = function (data, opts) {
      var o = opts || {};
      var rows = data || [];
      var gx = accessor(o.x, 'x');
      var gy = accessor(o.y, 'y');
      var colorOf = typeof o.color === 'function' ? o.color
        : function (d, i) { return o.color || seriesColor(i); };
      var labelOf = o.label === false ? null
        : (typeof o.label === 'function' ? o.label
          : (o.label === true ? function (d) { return fmtNumber(gy(d)); } : null));
      var base = o.base == null ? 0 : o.base;
      var baseY = yScale.kind === 'band' ? mTop + innerH : yScale(base);
      var bw = xScale.kind === 'band' ? xScale.bandwidth() : Math.max(4, (xRange[1] - xRange[0]) / Math.max(1, rows.length) * 0.7);
      var maxBw = o.maxBarWidth == null ? 64 : o.maxBarWidth;
      var drawW = Math.min(bw, maxBw);
      var g = svgEl('g', { class: 'apex-bars' });

      for (var i = 0; i < rows.length; i++) {
        var d = rows[i];
        var v = Number(gy(d));
        if (!isFinite(v)) continue;
        var cx = ctx.px(gx(d));
        if (cx === undefined || !isFinite(cx)) continue;
        var yv = yScale(v);
        var barTop = Math.min(baseY, yv);
        var hgt = Math.max(1.5, Math.abs(baseY - yv));
        var fill = colorOf(d, i);
        var x0 = cx - drawW / 2;
        var rr = Math.min(o.radius == null ? 5 : o.radius, drawW / 2, hgt / 2);

        var rect = svgEl('rect', {
          x: x0.toFixed(2), y: barTop.toFixed(2),
          width: drawW.toFixed(2), height: hgt.toFixed(2),
          rx: rr, ry: rr,
          fill: withAlpha(fill, o.fillOpacity == null ? 0.9 : o.fillOpacity),
          stroke: withAlpha(fill, 1), strokeWidth: 1,
          style: { transformOrigin: cx.toFixed(2) + 'px ' + baseY.toFixed(2) + 'px' }
        });
        g.appendChild(rect);
        animate(rect, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
          { duration: 620, delay: Math.min(500, i * 26) });

        if (labelOf) {
          var text = String(labelOf(d, i));
          if (measureText(text, 11, 700) <= drawW + 10 && barTop - mTop > 12) {
            var lab = svgEl('text', {
              x: cx.toFixed(2), y: (barTop - 6).toFixed(2), textAnchor: 'middle',
              fill: tokens.warm200, fontSize: 11, fontWeight: 700, fontFamily: FONT_BODY,
              style: { fontVariantNumeric: 'tabular-nums' }
            }, text);
            g.appendChild(lab);
            animate(lab, [{ opacity: 0 }, { opacity: 1 }],
              { duration: 420, delay: 320 + Math.min(500, i * 26) });
          }
        }

        (function (datum, idx, colour) {
          bindTip(rect, function () {
            if (typeof o.tip === 'function') return o.tip(datum, idx);
            return [
              { title: String(gx(datum)) },
              { label: o.valueLabel || 'Value', value: fmtNumber(gy(datum)), color: colour }
            ];
          });
          rect.addEventListener('pointerenter', function () { rect.setAttribute('fill', withAlpha(colour, 1)); });
          rect.addEventListener('pointerleave', function () {
            rect.setAttribute('fill', withAlpha(colour, o.fillOpacity == null ? 0.9 : o.fillOpacity));
          });
        })(d, i, fill);
      }
      markLayer.appendChild(g);
      return ctx;
    };

    /** ctx.hbars(data, {x, y, ...}) — categories on y, values on x. */
    ctx.hbars = function (data, opts) {
      var o = opts || {};
      var rows = data || [];
      var gx = accessor(o.x, 'x');   /* value */
      var gy = accessor(o.y, 'y');   /* category */
      var colorOf = typeof o.color === 'function' ? o.color
        : function (d, i) { return o.color || seriesColor(i); };
      var labelOf = o.label === false ? null
        : (typeof o.label === 'function' ? o.label
          : function (d) { return fmtNumber(gx(d)); });
      var baseX = xScale.kind === 'band' ? xRange[0] : xScale(o.base == null ? 0 : o.base);
      var bh = yScale.kind === 'band' ? yScale.bandwidth() : 14;
      var drawH = Math.min(bh, o.maxBarWidth == null ? 34 : o.maxBarWidth);
      var g = svgEl('g', { class: 'apex-hbars' });

      for (var i = 0; i < rows.length; i++) {
        var d = rows[i];
        var v = Number(gx(d));
        if (!isFinite(v)) continue;
        var cy = ctx.py(gy(d));
        if (cy === undefined || !isFinite(cy)) continue;
        var xv = xScale(v);
        var left = Math.min(baseX, xv);
        var wdt = Math.max(1.5, Math.abs(xv - baseX));
        var fill = colorOf(d, i);
        var rr = Math.min(o.radius == null ? 5 : o.radius, drawH / 2, wdt / 2);
        var rect = svgEl('rect', {
          x: left.toFixed(2), y: (cy - drawH / 2).toFixed(2),
          width: wdt.toFixed(2), height: drawH.toFixed(2),
          rx: rr, ry: rr,
          fill: withAlpha(fill, o.fillOpacity == null ? 0.9 : o.fillOpacity),
          stroke: withAlpha(fill, 1), strokeWidth: 1,
          style: { transformOrigin: baseX.toFixed(2) + 'px ' + cy.toFixed(2) + 'px' }
        });
        g.appendChild(rect);
        animate(rect, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
          { duration: 640, delay: Math.min(500, i * 26) });

        if (labelOf) {
          var text = String(labelOf(d, i));
          var tw = measureText(text, 11, 700);
          var outside = left + wdt + 6 + tw < xRange[1];
          var lab = svgEl('text', {
            x: (outside ? left + wdt + 6 : left + wdt - 6).toFixed(2),
            y: (cy + 4).toFixed(2),
            textAnchor: outside ? 'start' : 'end',
            fill: outside ? tokens.warm200 : tokens.background,
            fontSize: 11, fontWeight: 700, fontFamily: FONT_BODY,
            style: { fontVariantNumeric: 'tabular-nums' }
          }, text);
          if (outside || wdt > tw + 14) g.appendChild(lab);
          animate(lab, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 340 });
        }

        (function (datum, idx, colour) {
          bindTip(rect, function () {
            if (typeof o.tip === 'function') return o.tip(datum, idx);
            return [
              { title: String(gy(datum)) },
              { label: o.valueLabel || 'Value', value: fmtNumber(gx(datum)), color: colour }
            ];
          });
        })(d, i, fill);
      }
      markLayer.appendChild(g);
      return ctx;
    };

    function pointsOf(series, o) {
      var gx = accessor(o.x, 'x');
      var gy = accessor(o.y, 'y');
      var raw = series.points || series.values || series.data || [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var p = raw[i];
        var xv, yv;
        if (Array.isArray(p)) { xv = p[0]; yv = p[1]; }
        else { xv = gx(p); yv = gy(p); }
        var px = ctx.px(xv);
        var py = isNum(yv) ? yScale(Number(yv)) : null;
        out.push({ datum: p, xv: xv, yv: yv, px: px, py: py });
      }
      return out;
    }

    function pathFrom(pts, curve) {
      var d = '';
      var open = false;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p.py === null || p.px === undefined || !isFinite(p.px)) { open = false; continue; }
        d += (open ? 'L' : 'M') + p.px.toFixed(2) + ',' + p.py.toFixed(2);
        open = true;
      }
      return d;
    }

    /**
     * ctx.lines(series, {x, y, color, dots, area, tip, width})
     * series: [{name, color, points:[{x,y}] | [[x,y]]}]
     */
    ctx.lines = function (series, opts) {
      var o = opts || {};
      var list = series || [];
      var g = svgEl('g', { class: 'apex-lines' });
      var prepared = [];

      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var colour = s.color || (typeof o.color === 'function' ? o.color(s, i) : o.color) || seriesColor(i);
        var pts = pointsOf(s, o);
        prepared.push({ series: s, color: colour, pts: pts, name: s.name == null ? 'Series ' + (i + 1) : s.name });

        var d = pathFrom(pts);
        if (!d) continue;

        if (o.area && list.length === 1) {
          var gid = 'apex-area-' + Math.random().toString(36).slice(2, 9);
          var grad = svgEl('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' }, [
            svgEl('stop', { offset: '0%', stopColor: colour, stopOpacity: '0.42' }),
            svgEl('stop', { offset: '60%', stopColor: colour, stopOpacity: '0.12' }),
            svgEl('stop', { offset: '100%', stopColor: colour, stopOpacity: '0' })
          ]);
          defs.appendChild(grad);
          var first = null, last = null;
          for (var q = 0; q < pts.length; q++) {
            if (pts[q].py === null) continue;
            if (first === null) first = pts[q];
            last = pts[q];
          }
          if (first && last) {
            var areaPath = svgEl('path', {
              d: d + 'L' + last.px.toFixed(2) + ',' + (mTop + innerH) + 'L' + first.px.toFixed(2) + ',' + (mTop + innerH) + 'Z',
              fill: 'url(#' + gid + ')'
            });
            g.appendChild(areaPath);
            animate(areaPath, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 220 });
          }
        }

        var line = svgEl('path', {
          d: d, fill: 'none', stroke: colour,
          strokeWidth: o.width == null ? 2 : o.width,
          strokeLinejoin: 'round', strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
          style: { filter: 'drop-shadow(0 0 6px ' + withAlpha(colour, 0.28) + ')' }
        });
        g.appendChild(line);

        if (!reducedMotion()) {
          var len = 0;
          try { len = line.getTotalLength(); } catch (e) { len = 0; }
          if (len > 0 && len < 40000) {
            line.style.strokeDasharray = len + ' ' + len;
            line.style.strokeDashoffset = String(len);
            var anim = animate(line,
              [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
              { duration: 900, delay: Math.min(400, i * 60), easing: tokens.ease });
            if (anim) {
              anim.onfinish = (function (node2) {
                return function () { node2.style.strokeDasharray = 'none'; node2.style.strokeDashoffset = '0'; };
              })(line);
            } else { line.style.strokeDasharray = 'none'; line.style.strokeDashoffset = '0'; }
          }
        }

        var showDots = o.dots === true || (o.dots !== false && pts.length <= 24 && list.length <= 6);
        if (showDots) {
          for (var k = 0; k < pts.length; k++) {
            if (pts[k].py === null) continue;
            var dot = svgEl('circle', {
              cx: pts[k].px.toFixed(2), cy: pts[k].py.toFixed(2),
              r: o.dotRadius == null ? 3 : o.dotRadius,
              fill: tokens.background, stroke: colour, strokeWidth: 1.8
            });
            g.appendChild(dot);
            animate(dot, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 700 });
          }
        }

        /* A single-point series has no line to see, so it gets a real marker. */
        var visible = 0;
        for (var z = 0; z < pts.length; z++) if (pts[z].py !== null) visible++;
        if (visible === 1 && !showDots) {
          for (var z2 = 0; z2 < pts.length; z2++) {
            if (pts[z2].py === null) continue;
            g.appendChild(svgEl('circle', {
              cx: pts[z2].px.toFixed(2), cy: pts[z2].py.toFixed(2), r: 4,
              fill: colour, stroke: tokens.background, strokeWidth: 1.5
            }));
          }
        }
      }

      markLayer.appendChild(g);
      if (o.hover !== false) attachNearestX(prepared, o);
      return ctx;
    };

    ctx.area = function (series, opts) {
      var o = opts || {};
      o.area = true;
      return ctx.lines(Array.isArray(series) ? series : [series], o);
    };

    /** A shared crosshair + multi-series readout, bisecting on x. */
    function attachNearestX(prepared, o) {
      if (!prepared.length) return;
      var guide = svgEl('line', {
        x1: 0, y1: mTop, x2: 0, y2: mTop + innerH,
        stroke: 'rgba(246,241,234,0.28)', strokeWidth: 1,
        opacity: 0, shapeRendering: 'crispEdges'
      });
      overlayLayer.appendChild(guide);
      var focus = svgEl('g', { opacity: 0 });
      overlayLayer.appendChild(focus);

      var capture = svgEl('rect', {
        x: xRange[0], y: mTop, width: Math.max(1, xRange[1] - xRange[0]), height: innerH,
        fill: 'transparent', style: { cursor: 'crosshair' }
      });
      overlayLayer.appendChild(capture);

      capture.addEventListener('pointerleave', function () {
        guide.setAttribute('opacity', '0');
        focus.setAttribute('opacity', '0');
        tip.hide();
      });
      capture.addEventListener('pointermove', function (ev) {
        var p = ctx.point(ev);
        var best = null;
        for (var i = 0; i < prepared.length; i++) {
          var pts = prepared[i].pts;
          for (var j = 0; j < pts.length; j++) {
            if (pts[j].py === null || !isFinite(pts[j].px)) continue;
            var dx = Math.abs(pts[j].px - p.x);
            if (best === null || dx < best.dx) best = { dx: dx, px: pts[j].px, xv: pts[j].xv };
          }
        }
        if (!best) return;
        guide.setAttribute('x1', best.px.toFixed(2));
        guide.setAttribute('x2', best.px.toFixed(2));
        guide.setAttribute('opacity', '1');
        clear(focus);

        var rows = [{ title: (o.xLabel ? o.xLabel + ' ' : '') + formatMaybe(best.xv, o.xFormat, xFormat) }];
        for (var s = 0; s < prepared.length; s++) {
          var hit = null;
          var ps = prepared[s].pts;
          for (var t = 0; t < ps.length; t++) {
            if (ps[t].py === null) continue;
            if (Math.abs(ps[t].px - best.px) < 0.6) { hit = ps[t]; break; }
          }
          if (!hit) continue;
          focus.appendChild(svgEl('circle', {
            cx: hit.px.toFixed(2), cy: hit.py.toFixed(2), r: 4.5,
            fill: prepared[s].color, stroke: tokens.background, strokeWidth: 2
          }));
          rows.push({
            label: prepared[s].name,
            value: formatMaybe(hit.yv, o.yFormat, function (v) { return fmtNumber(v); }),
            color: prepared[s].color
          });
        }
        focus.setAttribute('opacity', '1');
        if (typeof o.tip === 'function') rows = o.tip(best.xv, rows) || rows;
        tip.show(p.localX, p.localY, rows);
      });
    }

    function formatMaybe(v, fn, fallbackFn) {
      if (typeof fn === 'function') return fn(v);
      if (fallbackFn) return fallbackFn(v);
      return String(v);
    }

    /** ctx.dots(data, {x, y, color, r, size, label, tip}) — scatter. */
    ctx.dots = function (data, opts) {
      var o = opts || {};
      var rows = data || [];
      var gx = accessor(o.x, 'x');
      var gy = accessor(o.y, 'y');
      var colorOf = typeof o.color === 'function' ? o.color
        : function (d, i) { return o.color || tokens.primary; };
      var sizeOf = typeof o.size === 'function' ? o.size : function () { return o.r == null ? 4.5 : o.r; };
      var g = svgEl('g', { class: 'apex-dots' });

      for (var i = 0; i < rows.length; i++) {
        var d = rows[i];
        var cx = ctx.px(gx(d));
        var yv = gy(d);
        if (cx === undefined || !isFinite(cx) || !isNum(yv)) continue;
        var cy = yScale(Number(yv));
        var colour = colorOf(d, i);
        var dot = svgEl('circle', {
          cx: cx.toFixed(2), cy: cy.toFixed(2), r: sizeOf(d, i),
          fill: withAlpha(colour, o.fillOpacity == null ? 0.82 : o.fillOpacity),
          stroke: withAlpha(colour, 1), strokeWidth: 1.2,
          style: { transformOrigin: cx.toFixed(2) + 'px ' + cy.toFixed(2) + 'px' }
        });
        g.appendChild(dot);
        animate(dot, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
          { duration: 480, delay: Math.min(600, i * 14) });

        (function (datum, idx, colour2, node) {
          bindTip(node, function () {
            if (typeof o.tip === 'function') return o.tip(datum, idx);
            return [
              { title: o.name ? String(o.name(datum)) : String(gx(datum)) },
              { label: o.yLabel || 'Value', value: fmtNumber(gy(datum)), color: colour2 }
            ];
          });
          node.addEventListener('pointerenter', function () { node.setAttribute('r', String((o.r == null ? 4.5 : o.r) + 2)); });
          node.addEventListener('pointerleave', function () { node.setAttribute('r', String(sizeOf(datum, idx))); });
        })(d, i, colour, dot);
      }
      markLayer.appendChild(g);
      return ctx;
    };

    /** ctx.rule({y | x, label, color, dashed}) — a reference line. */
    ctx.rule = function (opts) {
      var o = opts || {};
      var g = svgEl('g', { class: 'apex-rule' });
      var colour = o.color || tokens.flame;
      if (o.y != null) {
        var py = yScale(Number(o.y));
        g.appendChild(svgEl('line', {
          x1: xRange[0], y1: py.toFixed(2), x2: xRange[1], y2: py.toFixed(2),
          stroke: withAlpha(colour, 0.6), strokeWidth: 1.25,
          strokeDasharray: o.dashed === false ? 'none' : '4 4'
        }));
        if (o.label) {
          g.appendChild(svgEl('text', {
            x: xRange[1], y: (py - 6).toFixed(2), textAnchor: 'end',
            fill: withAlpha(colour, 0.85), fontSize: 10, fontWeight: 700,
            fontFamily: FONT_BODY, letterSpacing: '0.08em'
          }, String(o.label).toUpperCase()));
        }
      }
      if (o.x != null) {
        var px = ctx.px(o.x);
        g.appendChild(svgEl('line', {
          x1: px.toFixed(2), y1: mTop, x2: px.toFixed(2), y2: mTop + innerH,
          stroke: withAlpha(colour, 0.6), strokeWidth: 1.25,
          strokeDasharray: o.dashed === false ? 'none' : '4 4'
        }));
        if (o.label) {
          g.appendChild(svgEl('text', {
            x: (px + 5).toFixed(2), y: mTop + 10, textAnchor: 'start',
            fill: withAlpha(colour, 0.85), fontSize: 10, fontWeight: 700,
            fontFamily: FONT_BODY, letterSpacing: '0.08em'
          }, String(o.label).toUpperCase()));
        }
      }
      gridLayer.appendChild(g);
      return ctx;
    };

    /** ctx.text(str, {x, y, anchor, size, color, weight}) — free annotation. */
    ctx.text = function (str, opts) {
      var o = opts || {};
      overlayLayer.appendChild(svgEl('text', {
        x: o.x == null ? xRange[0] : o.x,
        y: o.y == null ? mTop : o.y,
        textAnchor: o.anchor || 'start',
        fill: o.color || tokens.warm400,
        fontSize: o.size == null ? 11 : o.size,
        fontWeight: o.weight == null ? 600 : o.weight,
        fontFamily: o.headline ? FONT_HEAD : FONT_BODY,
        style: { fontVariantNumeric: 'tabular-nums' }
      }, String(str)));
      return ctx;
    };

    if (c.note) caption(c.note, { mount: root });
    if (mount) mount.appendChild(root);
    return ctx;
  }

  /* ==========================================================================
     One-call wrappers. These exist so the common chart is five lines; each one
     is only 'plot(...)' plus one mark, and each returns the plot context so the
     caller can keep composing.
     ========================================================================== */

  function pick(o, keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) {
      if (o[keys[i]] !== undefined) out[keys[i]] = o[keys[i]];
    }
    return out;
  }

  var PLOT_KEYS = ['mount', 'width', 'height', 'title', 'subtitle', 'note', 'padding',
                   'frame', 'margin', 'ariaLabel', 'valueLabels'];

  function values(rows, fn) {
    var out = [];
    for (var i = 0; i < rows.length; i++) out.push(fn(rows[i], i));
    return out;
  }

  /** apex.bars({mount, width, data, x, y, color, ...}) */
  function bars(cfg) {
    var c = cfg || {};
    var rows = c.data || [];
    if (!rows.length) {
      return { root: emptyState(c.mount, c.emptyMessage, { height: c.height }), empty: true };
    }
    var gx = accessor(c.x, 'x');
    var gy = accessor(c.y, 'y');
    var p = pick(c, PLOT_KEYS);
    p.x = Object.assign({ type: 'band', values: values(rows, gx), label: c.xLabel }, c.xAxis || {});
    p.y = Object.assign({ type: 'linear', values: values(rows, gy), label: c.yLabel,
                          format: c.yFormat, zero: true }, c.yAxis || {});
    var ctx = plot(p);
    ctx.bars(rows, {
      x: c.x, y: c.y, color: c.color, label: c.label, tip: c.tip,
      radius: c.radius, valueLabel: c.valueLabel, maxBarWidth: c.maxBarWidth
    });
    if (c.legend) ctx.legend(c.legend);
    if (c.caption) ctx.caption(c.caption);
    return ctx;
  }

  /** apex.hbars({...}) — the right default when category names are long. */
  function hbars(cfg) {
    var c = cfg || {};
    var rows = c.data || [];
    if (!rows.length) {
      return { root: emptyState(c.mount, c.emptyMessage, { height: c.height }), empty: true };
    }
    var gx = accessor(c.x, 'x');   /* value */
    var gy = accessor(c.y, 'y');   /* category */
    var p = pick(c, PLOT_KEYS);
    if (p.height == null) p.height = Math.max(140, rows.length * 30 + 46);
    p.x = Object.assign({ type: 'linear', values: values(rows, gx), label: c.xLabel,
                          format: c.xFormat, grid: true, zero: true }, c.xAxis || {});
    p.y = Object.assign({ type: 'band', domain: values(rows, gy), label: c.yLabel,
                          padding: 0.3 }, c.yAxis || {});
    var ctx = plot(p);
    ctx.hbars(rows, {
      x: c.x, y: c.y, color: c.color, label: c.label, tip: c.tip,
      radius: c.radius, valueLabel: c.valueLabel, maxBarWidth: c.maxBarWidth
    });
    if (c.legend) ctx.legend(c.legend);
    if (c.caption) ctx.caption(c.caption);
    return ctx;
  }

  /** apex.lines({mount, width, series, x, y, ...}) */
  function lines(cfg) {
    var c = cfg || {};
    var series = c.series || [];
    var allX = [], allY = [];
    var gx = accessor(c.x, 'x');
    var gy = accessor(c.y, 'y');
    var count = 0;
    for (var i = 0; i < series.length; i++) {
      var pts = series[i].points || series[i].values || series[i].data || [];
      for (var j = 0; j < pts.length; j++) {
        var pt = pts[j];
        var xv = Array.isArray(pt) ? pt[0] : gx(pt);
        var yv = Array.isArray(pt) ? pt[1] : gy(pt);
        allX.push(xv);
        if (isNum(yv)) { allY.push(yv); count++; }
      }
    }
    if (!count) {
      return { root: emptyState(c.mount, c.emptyMessage, { height: c.height }), empty: true };
    }
    var p = pick(c, PLOT_KEYS);
    /* nice:false — a line's x is usually a lap or round number, and rounding
       "1…15" out to "0…16" invents a round zero that never happened. */
    p.x = Object.assign({ values: allX, label: c.xLabel, format: c.xFormat, nice: false },
                        c.xAxis || {});
    p.y = Object.assign({ type: 'linear', values: allY, label: c.yLabel,
                          format: c.yFormat, zero: c.zero === true }, c.yAxis || {});
    var ctx = plot(p);
    ctx.lines(series, {
      x: c.x, y: c.y, color: c.color, dots: c.dots, area: c.area,
      width: c.width_, tip: c.tip, xLabel: c.xLabel,
      xFormat: c.xFormat, yFormat: c.yFormat
    });
    if (c.legend !== false && series.length > 1) {
      var items = [];
      for (var k = 0; k < series.length; k++) {
        items.push({
          label: series[k].name == null ? 'Series ' + (k + 1) : series[k].name,
          color: series[k].color || seriesColor(k),
          shape: 'line'
        });
      }
      ctx.legend(items);
    }
    if (c.caption) ctx.caption(c.caption);
    return ctx;
  }

  /** apex.dots({mount, width, data, x, y, ...}) — scatter. */
  function dots(cfg) {
    var c = cfg || {};
    var rows = c.data || [];
    if (!rows.length) {
      return { root: emptyState(c.mount, c.emptyMessage, { height: c.height }), empty: true };
    }
    var gx = accessor(c.x, 'x');
    var gy = accessor(c.y, 'y');
    var p = pick(c, PLOT_KEYS);
    p.x = Object.assign({ values: values(rows, gx), label: c.xLabel, format: c.xFormat,
                          zero: false, grid: true }, c.xAxis || {});
    p.y = Object.assign({ type: 'linear', values: values(rows, gy), label: c.yLabel,
                          format: c.yFormat, zero: c.zero === true }, c.yAxis || {});
    var ctx = plot(p);
    ctx.dots(rows, {
      x: c.x, y: c.y, color: c.color, r: c.r, size: c.size, tip: c.tip,
      name: c.name, yLabel: c.yLabel
    });
    if (c.legend) ctx.legend(c.legend);
    if (c.caption) ctx.caption(c.caption);
    return ctx;
  }

  /**
   * apex.table({mount, data, columns, title, caption})
   * A chart is often the wrong answer; this is here so the right one is just as
   * cheap to reach for. columns: [{key|value, label, align, format, color}]
   */
  function table(cfg) {
    var c = cfg || {};
    var rows = c.data || [];
    if (!rows.length) {
      return emptyState(c.mount, c.emptyMessage, { height: 120 });
    }
    var cols = c.columns || Object.keys(rows[0]).map(function (k) { return { key: k, label: k }; });
    var root = panel({ padding: c.padding == null ? 16 : c.padding, title: c.title, subtitle: c.subtitle });
    var wrap = el('div', { style: { position: 'relative', overflowX: 'auto', maxWidth: '100%' } });
    var t = el('table', { style: {
      width: '100%', borderCollapse: 'collapse', fontSize: '13px', fontFamily: FONT_BODY
    } });

    var thead = el('thead');
    var trh = el('tr');
    for (var i = 0; i < cols.length; i++) {
      trh.appendChild(el('th', {
        text: String(cols[i].label == null ? cols[i].key : cols[i].label),
        style: {
          textAlign: cols[i].align || (i === 0 ? 'left' : 'right'),
          fontWeight: '700', fontSize: '10px', letterSpacing: '0.12em',
          textTransform: 'uppercase', color: tokens.warm500,
          padding: '0 12px 8px 0',
          borderBottom: '1px solid rgba(255,255,255,0.09)', whiteSpace: 'nowrap'
        }
      }));
    }
    thead.appendChild(trh);
    t.appendChild(thead);

    var tbody = el('tbody');
    for (var r = 0; r < rows.length; r++) {
      var tr = el('tr');
      for (var k2 = 0; k2 < cols.length; k2++) {
        var col = cols[k2];
        var raw = typeof col.value === 'function' ? col.value(rows[r], r) : rows[r][col.key];
        var txt = typeof col.format === 'function' ? col.format(raw, rows[r], r)
          : (raw == null ? DASH : String(raw));
        var cell = el('td', {
          text: txt,
          style: {
            textAlign: col.align || (k2 === 0 ? 'left' : 'right'),
            padding: '9px 12px 9px 0',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
            color: k2 === 0 ? tokens.warm100 : tokens.warm200,
            fontWeight: k2 === 0 ? '600' : '500',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap'
          }
        });
        if (typeof col.color === 'function') {
          var cc = col.color(rows[r], r);
          if (cc) cell.style.color = cc;
        }
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
      animate(tr, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 420, delay: Math.min(400, r * 22) });
    }
    t.appendChild(tbody);
    wrap.appendChild(t);
    root.appendChild(wrap);
    if (c.caption) caption(c.caption, { mount: root });
    if (c.mount) c.mount.appendChild(root);
    return root;
  }

  /* ==========================================================================
     Export
     ========================================================================== */

  var apex = {
    __runtime: '1',
    tokens: tokens,
    palette: PALETTE.slice(),
    seriesColor: seriesColor,
    teamColor: teamColor,
    compoundColor: compoundColor,
    withAlpha: withAlpha,

    scaleLinear: scaleLinear,
    scaleBand: scaleBand,
    ticks: ticks,
    niceDomain: niceDomain,
    extent: extent,

    el: el,
    svg: svgEl,
    clear: clear,
    measureText: measureText,
    truncate: truncateToWidth,

    axis: axis,
    gridlines: gridlines,
    legend: legend,
    tooltip: tooltip,
    panel: panel,
    caption: caption,
    empty: emptyState,

    fmt: fmt,
    animate: animate,
    reducedMotion: reducedMotion,

    plot: plot,
    bars: bars,
    hbars: hbars,
    lines: lines,
    area: function (cfg) { var c = cfg || {}; c.area = true; return lines(c); },
    dots: dots,
    scatter: dots,
    table: table
  };

  global.apex = apex;
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;

export default APEX_VISUAL_RUNTIME;
