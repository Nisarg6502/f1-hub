import type { NextConfig } from "next";

/**
 * Origins the browser is allowed to talk to, assembled from the same
 * environment variables the client code reads.
 *
 * Derived rather than hardcoded so a CSP can never drift out of step with the
 * hosts the app actually calls — a stale `connect-src` does not warn, it just
 * breaks every request at runtime, in production, after the deploy that
 * changed a service URL.
 *
 * Read at BUILD time, which is correct here: these are `NEXT_PUBLIC_*` values
 * that are already inlined into the client bundle at build time, so the
 * headers and the bundle are generated from one set of values.
 */
const CONNECT_ORIGINS = [
  process.env.NEXT_PUBLIC_API_BASE_URL,
  process.env.NEXT_PUBLIC_AGENT_BASE_URL,
  process.env.NEXT_PUBLIC_ASSET_BASE_URL,
]
  .filter((value): value is string => Boolean(value))
  .map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  })
  .filter((value): value is string => Boolean(value));

/**
 * Google Analytics hosts, added to the CSP only when a measurement ID exists.
 *
 * This is not optional decoration: the CSP shipped without it and silently
 * killed the entire feature. `script-src` refused gtag.js with
 * `blockedReason: "csp"`, which surfaces as a `loadingFailed` carrying an EMPTY
 * errorText -- it looks exactly like a network-level block, and was
 * misdiagnosed as one. Nothing in the app logs, nothing warns, and every one of
 * our own consent calls still queues into `dataLayer` perfectly, so the code
 * looks healthy right up until you notice Google never received anything.
 *
 * Three directives, all required, per Google's own guidance:
 *   script-src  -- gtag.js itself
 *   connect-src -- the /g/collect beacons, including the cookieless ones a
 *                  denied visitor still sends
 *   img-src     -- GA falls back to an image beacon where fetch is unavailable
 *
 * Gated on the ID so a build without analytics keeps the narrower policy it had
 * before any of this existed.
 */
const GA_ENABLED = Boolean(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);
const GA_SCRIPT = GA_ENABLED ? ["https://*.googletagmanager.com"] : [];
const GA_CONNECT = GA_ENABLED
  ? [
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com",
    ]
  : [];
const GA_IMG = GA_ENABLED
  ? ["https://*.google-analytics.com", "https://*.googletagmanager.com"]
  : [];

/**
 * Content-Security-Policy.
 *
 * Two concessions are load-bearing and should not be "tidied away":
 *
 * `script-src 'unsafe-inline'` — Next's App Router inlines the bootstrap and
 * the streamed RSC payload as inline `<script>` tags. Removing this without
 * first adopting a nonce (which requires middleware, and therefore a request
 * hook on every page) breaks hydration site-wide.
 *
 * `style-src 'unsafe-inline'` — the app sets inline `style` attributes for
 * per-team colours and animation delays, and the 3D track view generates
 * styles at runtime.
 *
 * `frame-ancestors 'none'` is the one that does real work: it is the header
 * form of clickjacking protection and, unlike `X-Frame-Options`, it is what
 * modern browsers actually honour. Both are sent, since the older header still
 * covers older clients.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // Chat visuals (`components/visual-frame.tsx`) run model-written drawing
  // code in a `srcdoc` iframe. Without this directive frames fall back to
  // `default-src 'self'`, which already permits `srcdoc` — so this is not
  // *enabling* anything, it is stating the intent so a later widening of
  // `default-src` cannot widen what may be framed as a side effect.
  //
  // Note which way the inheritance runs, because it is the opposite of the
  // instinct: a `srcdoc` frame inherits THIS policy, so inside the frame
  // `script-src` is `'self' 'unsafe-inline'`. The inline bootstrap therefore
  // runs — which is required, the frame has no other way to receive code —
  // while `'self'` is evaluated against the frame's **opaque** origin and
  // matches nothing for `script-src` or `connect-src`: verified from inside a
  // live frame, `fetch` to this origin fails with a TypeError and `eval`
  // throws an EvalError (`'unsafe-eval'` is absent). Contract §6 also claims
  // no image host is reachable, and that part is NOT what Chrome does — an
  // `<img>` pointed at this origin loads from inside the frame, because
  // `img-src 'self'` is resolved against the inherited policy's origin rather
  // than the frame's opaque one. It is a narrow channel (a credential-less GET
  // to hosts we already allow, from a document whose only inputs are the
  // ledger data it was handed) but the doc overstates the guarantee, so do not
  // rely on that line.
  //
  // None of that is the security boundary. The missing `allow-same-origin` on
  // the sandbox attribute is; see `visual-frame.tsx`. This is defence in
  // depth.
  "frame-src 'self'",
  "form-action 'self'",
  ["script-src 'self' 'unsafe-inline'", ...GA_SCRIPT].join(" "),
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  /**
   * Team-radio audio. **This directive is the feature**, not housekeeping.
   *
   * There is no `media-src` fallback chain worth relying on: `<audio>` falls
   * straight through to `default-src 'self'`, so team radio shipped blocked.
   * Both players were affected — the Pitwall feed (`radio-panel.tsx`) and the
   * watch-mode popup (`radio-popup.tsx`) — because the block is at the
   * document policy, not in either component.
   *
   * What it looks like when it is missing, measured in headless Chrome against
   * this page, because none of it says "CSP" anywhere the reader would look:
   *   - `.play()` rejects with `NotSupportedError: Failed to load because no
   *     supported source was found` — which reads as a bad URL or a codec
   *     problem, and sent the first investigation after `preload`, the shared
   *     element, and the `onPause` handler instead.
   *   - the element lands on `networkState = 3` (NETWORK_NO_SOURCE) and
   *     `error.code = 4` (MEDIA_ERR_SRC_NOT_SUPPORTED).
   *   - **no request is made at all.** The network panel is empty, so the CDN
   *     looks unreachable when it is in fact never asked. `curl` on the same
   *     URL returns 200 `audio/mpeg`, which makes the two observations look
   *     contradictory until you catch the `securitypolicyviolation` event.
   * The only honest signal is that event's `effectiveDirective: "media-src"`.
   *
   * The host is spelled out rather than derived: unlike the `connect-src`
   * origins above it comes from no `NEXT_PUBLIC_*` value — the clip URLs are
   * built server-side in `backend/app/radio_clips.py` (`LIVETIMING_BASE`), so
   * that constant and this line have to move together.
   *
   * Note this is also why the audio can only ever be played, never analysed:
   * F1's CDN sends no `Access-Control-Allow-Origin`, so `crossOrigin`, Web
   * Audio and `fetch()` all fail on these files. Allowing the origin here does
   * not change that, and adding `crossOrigin` to either player would break
   * playback outright.
   */
  "media-src 'self' https://livetiming.formula1.com",
  // `data:` and `blob:` are needed for canvas-derived and generated imagery
  // (the track renderer, the OG image route, chart exports).
  [
    "img-src 'self' data: blob: https://storage.googleapis.com https://upload.wikimedia.org https://commons.wikimedia.org",
    ...GA_IMG,
  ].join(" "),
  [
    "connect-src 'self'",
    ...CONNECT_ORIGINS,
    "https://api.openf1.org",
    "https://www.opentopodata.org",
    ...GA_CONNECT,
  ].join(" "),
  // The add-to-calendar control builds an .ics as a blob URL
  // (`session-tabs.tsx`), and the 3D track view is the kind of code that grows
  // a worker. Neither is covered by `default-src 'self'`, and a CSP that
  // silently breaks a download is worse than one that is slightly wider.
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Next advertises its version in a response header by default; it is free
  // reconnaissance and nothing depends on it.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          {
            // Cloud Run serves HTTPS only, so committing to it costs nothing
            // and closes the first-request downgrade window.
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // Send the origin cross-site but the full path same-site: enough for
          // an upstream to see who referred a request, without leaking which
          // driver or race a reader was looking at.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // This app asks for none of these; saying so explicitly means a
            // future dependency cannot quietly start asking.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        pathname: "/f1-scratch-assets/**",
      },
    ],
    // Team logos include a few SVGs from our own curated GCS bucket (not
    // arbitrary uploads), so this is safe; still locked down per Next's docs.
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
};

export default nextConfig;
