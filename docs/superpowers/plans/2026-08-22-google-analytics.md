# Google Analytics 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GA4 measurement to the APEX frontend, gated behind Consent Mode v2, with a consent banner shown only to EU/UK visitors, eight custom events, and honest privacy copy.

**Architecture:** A React-free `lib/analytics.ts` holds the region test, the consent state machine and a `track()` wrapper. Two client components mounted in the root layout do the DOM work: `<Analytics/>` sets Consent Mode defaults to denied before `gtag.js` loads and then grants on mount for non-EU visitors, and `<ConsentBanner/>` renders only for EU/UK visitors with no stored choice. Everything is inert when the measurement ID is unset.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind 4, `next/script`, Vitest (new to this frontend).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-22-google-analytics-design.md`. Read it before Task 1.
- Env var name is exactly `NEXT_PUBLIC_GA_MEASUREMENT_ID`. Cloud Build substitution is exactly `_NEXT_PUBLIC_GA_MEASUREMENT_ID`, default empty string.
- `localStorage` key is exactly `apex.consent.analytics`, matching the existing `apex.watch.*` namespace convention in `src/lib/watch-preferences.ts`.
- **No `_ga` cookie may be written before consent is granted.** Consent Mode defaults must be set in a `beforeInteractive` script, ahead of `gtag.js`.
- **No PII, no free-text, no user-authored strings** in any event parameter. Event parameters are enum-ish values only.
- When `NEXT_PUBLIC_GA_MEASUREMENT_ID` is empty, the app must behave exactly as it does today: no script tag, no banner, no cookie, no console output.
- All work happens on a branch named `feat/google-analytics`, not on `main`.
- Follow the surrounding code's comment density: this codebase explains *why* in docblocks, and non-obvious decisions are expected to carry their reasoning.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `frontend/vitest.config.ts` | Vitest runner config. Node environment, no jsdom. |
| `frontend/src/lib/analytics.ts` | React-free, DOM-light: measurement ID, region test, consent read/write, `track()`. |
| `frontend/src/lib/analytics.test.ts` | Unit tests for the above. |
| `frontend/src/components/analytics.tsx` | Consent Mode defaults, `gtag.js`, grant-on-mount, `page_view` per route. |
| `frontend/src/components/consent-banner.tsx` | EU/UK-only consent banner. |
| `frontend/src/components/degraded-beacon.tsx` | Client component that fires `backend_unavailable` once per route view. |

**Modify:**

| File | Change |
| --- | --- |
| `frontend/package.json` | Add `vitest` devDependency and a `test` script. |
| `frontend/src/app/layout.tsx` | Mount `<Analytics/>` and `<ConsentBanner/>`. |
| `frontend/src/components/pitwall-assistant-launcher.tsx:52` | `pitwall_panel_open` |
| `frontend/src/components/pitwall-assistant-panel.tsx:490` | `pitwall_message_sent` |
| `frontend/src/components/race-replay.tsx:247` | `watch_replay_start` |
| `frontend/src/components/watch-view.tsx` | `watch_pair_qr` |
| `frontend/src/components/track3d/track-viewer-mount.tsx` | `circuit_3d_view` |
| `frontend/src/components/track3d/generate-geometry.tsx:234` | `circuit_3d_generate` |
| `frontend/src/components/global-search.tsx:267` | `search_result_selected` |
| `frontend/src/app/standings/page.tsx` and peers | Render `<DegradedBeacon/>` on the empty-data path |
| `frontend/Dockerfile.frontend` | `ARG`/`ENV NEXT_PUBLIC_GA_MEASUREMENT_ID` |
| `cloudbuild-frontend.yaml` | `--build-arg` and substitution |
| `frontend/src/app/(info)/privacy/page.tsx` | Rewrite: remove the no-analytics claim, describe GA4 |
| `frontend/src/app/(info)/faq/page.tsx:74-79` | Rewrite "Do you track me?" |

### Why a beacon component exists

The spec says `backend_unavailable` fires from "the existing empty-state catch". Those catches are in **server** components — `app/standings/page.tsx:52` is `async` and runs on the server, where `gtag` does not exist. A server component cannot call `track()`.

`<DegradedBeacon route="..."/>` is a one-line client component the server page renders on its empty-data path. It fires once on mount and nothing else. This keeps the "at most once per route view" guarantee from the spec without threading client state through every page.

---

## Task 1: Analytics library and test harness

**Files:**
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/lib/analytics.ts`
- Test: `frontend/src/lib/analytics.test.ts`
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MEASUREMENT_ID: string` — `""` when unset
  - `CONSENT_KEY: "apex.consent.analytics"`
  - `type ConsentChoice = "granted" | "denied"`
  - `isRegulatedRegion(timeZone: string): boolean`
  - `resolveTimeZone(): string`
  - `readConsent(storage?: StorageLike | null): ConsentChoice | null`
  - `writeConsent(choice: ConsentChoice, storage?: StorageLike | null): void`
  - `track(event: string, params?: Record<string, string | number>): boolean`
  - `type StorageLike = Pick<Storage, "getItem" | "setItem">`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/google-analytics
```

- [ ] **Step 2: Add Vitest**

Run from `frontend/`:

```bash
npm install --save-dev vitest@^3
```

Then add the script to `frontend/package.json`, in the `scripts` block, after `"lint": "eslint"`:

```json
    "lint": "eslint",
    "test": "vitest run"
```

- [ ] **Step 3: Create the Vitest config**

Create `frontend/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

/**
 * Node environment, not jsdom, and deliberately so.
 *
 * The only frontend module with logic worth unit-testing is `lib/analytics.ts`,
 * and it was written to take its storage as an argument precisely so it can be
 * driven without a DOM. Adding jsdom to get `localStorage` would pull a large
 * dependency into a frontend that has never had a test runner at all, to test
 * code that does not need it.
 *
 * Only `lib/` is included. Component testing would need jsdom and React
 * Testing Library; the components here are verified in a real browser instead,
 * per the design doc's testing section.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write the failing tests**

Create `frontend/src/lib/analytics.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CONSENT_KEY,
  isRegulatedRegion,
  readConsent,
  track,
  writeConsent,
  type ConsentChoice,
} from "./analytics";

/** A localStorage stand-in, so these tests need no DOM. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    dump: () => ({ ...data }),
  };
}

describe("isRegulatedRegion", () => {
  it("treats every Europe/* zone as regulated", () => {
    expect(isRegulatedRegion("Europe/Berlin")).toBe(true);
    expect(isRegulatedRegion("Europe/London")).toBe(true);
    expect(isRegulatedRegion("Europe/Dublin")).toBe(true);
  });

  it("treats the EEA Atlantic outliers as regulated", () => {
    // These are EEA/EU territory but do not sort under Europe/.
    expect(isRegulatedRegion("Atlantic/Reykjavik")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Canary")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Madeira")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Azores")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Faroe")).toBe(true);
  });

  it("does not treat non-EEA zones as regulated", () => {
    expect(isRegulatedRegion("Asia/Kolkata")).toBe(false);
    expect(isRegulatedRegion("America/New_York")).toBe(false);
    expect(isRegulatedRegion("Australia/Melbourne")).toBe(false);
    // Atlantic, but not EEA.
    expect(isRegulatedRegion("Atlantic/Bermuda")).toBe(false);
  });

  it("is not fooled by a zone that merely starts with the same letters", () => {
    expect(isRegulatedRegion("Europeans/Nowhere")).toBe(false);
  });

  it("returns false for an empty or unknown zone", () => {
    expect(isRegulatedRegion("")).toBe(false);
  });
});

describe("consent persistence", () => {
  it("returns null when nothing has been stored", () => {
    expect(readConsent(fakeStorage())).toBeNull();
  });

  it("round-trips a granted choice", () => {
    const storage = fakeStorage();
    writeConsent("granted", storage);
    expect(storage.dump()[CONSENT_KEY]).toBe("granted");
    expect(readConsent(storage)).toBe("granted");
  });

  it("round-trips a denied choice", () => {
    const storage = fakeStorage();
    writeConsent("denied", storage);
    expect(readConsent(storage)).toBe("denied");
  });

  it("ignores a corrupted stored value rather than trusting it", () => {
    // A stray value must not be read as consent. Anything unrecognised is
    // treated as "never asked", which re-prompts rather than assuming yes.
    expect(readConsent(fakeStorage({ [CONSENT_KEY]: "yes-please" }))).toBeNull();
  });

  it("returns null when there is no storage at all", () => {
    expect(readConsent(null)).toBeNull();
  });

  it("does not throw when writing with no storage", () => {
    expect(() => writeConsent("granted", null)).not.toThrow();
  });
});

describe("track", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("no-ops and reports false when there is no window", () => {
    expect(track("pitwall_panel_open")).toBe(false);
  });

  it("no-ops and reports false when gtag is absent", () => {
    (globalThis as Record<string, unknown>).window = {};
    expect(track("pitwall_panel_open")).toBe(false);
  });

  it("forwards the event and params to gtag", () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).window = {
      gtag: (...args: unknown[]) => calls.push(args),
    };
    expect(track("search_result_selected", { entity_kind: "driver" })).toBe(true);
    expect(calls).toEqual([
      ["event", "search_result_selected", { entity_kind: "driver" }],
    ]);
  });

  it("sends an empty params object when none is given", () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).window = {
      gtag: (...args: unknown[]) => calls.push(args),
    };
    track("watch_pair_qr");
    expect(calls).toEqual([["event", "watch_pair_qr", {}]]);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run from `frontend/`:

```bash
npm test
```

Expected: FAIL — `Failed to resolve import "./analytics"`.

- [ ] **Step 6: Write the implementation**

Create `frontend/src/lib/analytics.ts`:

```ts
/**
 * Google Analytics 4 plumbing, kept free of React and of the DOM so a harness
 * can drive it.
 *
 * Three things live here: whether a visitor is in a jurisdiction that must be
 * asked before a cookie is set, what they answered, and a `track()` that is
 * safe to call from anywhere. None of it renders; the components in
 * `components/analytics.tsx` and `components/consent-banner.tsx` do that.
 *
 * The storage arguments are not dependency-injection ceremony -- they are the
 * reason this file needs no jsdom to test. See `vitest.config.ts`.
 */

/**
 * Baked into the client bundle at build time by Next, so it must be referenced
 * as a full literal `process.env.NEXT_PUBLIC_...` expression. Next inlines the
 * text of that expression; a computed lookup would survive the build as an
 * undefined runtime read.
 *
 * Empty when unset, which is the whole of the "degrade quietly" story: every
 * consumer checks this and does nothing.
 */
export const MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "";

/** Namespaced to match `apex.watch.*` in `watch-preferences.ts`. */
export const CONSENT_KEY = "apex.consent.analytics";

export type ConsentChoice = "granted" | "denied";

/** Only the two methods this module uses, so a plain object satisfies it. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * EEA/EU/UK territories whose IANA zone does not sort under `Europe/`.
 *
 * Iceland and the Faroes are EEA; the Canaries (Spain), Madeira and the Azores
 * (Portugal) are EU outermost regions. `Atlantic/Bermuda` and
 * `Atlantic/South_Georgia` are deliberately absent -- they are British
 * territories but not in the UK GDPR's scope, and they are the reason this is
 * an explicit list rather than an `Atlantic/` prefix test.
 */
const EEA_OUTLIERS = new Set([
  "Atlantic/Reykjavik",
  "Atlantic/Faroe",
  "Atlantic/Canary",
  "Atlantic/Madeira",
  "Atlantic/Azores",
]);

/**
 * Whether a timezone belongs to a visitor who must be asked before `_ga` is set.
 *
 * Timezone, not geo-IP, because the site is served from a bare `run.app` URL
 * with no load balancer in front of it and therefore has no geo headers, and
 * because a geo-IP lookup would mean disclosing a new third party on the very
 * page this change rewrites for honesty.
 *
 * It is over-inclusive at the margins -- a European on holiday in Singapore, a
 * VPN user -- and that is the safe direction. The failure mode is showing a
 * banner to someone who did not legally need one.
 */
export function isRegulatedRegion(timeZone: string): boolean {
  if (!timeZone) return false;
  // The trailing slash matters: "Europeans/Nowhere" is not Europe.
  if (timeZone.startsWith("Europe/")) return true;
  return EEA_OUTLIERS.has(timeZone);
}

/** The browser's IANA zone, or `""` where it cannot be determined. */
export function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Safari in private mode, and any browser with storage disabled, throw on
    // access rather than returning null.
    return null;
  }
}

/**
 * The stored choice, or `null` for "never asked".
 *
 * Anything unrecognised reads as `null` rather than as consent. A corrupted or
 * hand-edited value must re-prompt, never silently grant.
 */
export function readConsent(
  storage: StorageLike | null = defaultStorage()
): ConsentChoice | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONSENT_KEY);
    return raw === "granted" || raw === "denied" ? raw : null;
  } catch {
    return null;
  }
}

export function writeConsent(
  choice: ConsentChoice,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(CONSENT_KEY, choice);
  } catch {
    // A visitor who declined and whose storage then failed simply gets asked
    // again next visit. Nothing here is worth throwing over.
  }
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/**
 * Send one event, if there is anything to send it to.
 *
 * Returns whether it was actually sent, which is what makes it testable and
 * what lets a caller stay a bare one-liner everywhere else. Safe to call
 * before consent (gtag queues), with no measurement ID, and during SSR.
 *
 * Parameters must be enum-ish values only -- an entity kind, a circuit id, a
 * season and round. Never free text, never anything a user typed.
 */
export function track(
  event: string,
  params: Record<string, string | number> = {}
): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.gtag !== "function") return false;
  window.gtag("event", event, params);
  return true;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run from `frontend/`:

```bash
npm test
```

Expected: PASS — 16 tests passed.

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/lib/analytics.ts frontend/src/lib/analytics.test.ts
git commit -m "Add the analytics library, and the frontend's first test runner"
```

---

## Task 2: Build configuration

Done before the components so that a build can be run at any later point without a dangling build-arg — the failure this repo has already had once (`357b854 Fix both broken deploys: a dangling build-arg...`).

**Files:**
- Modify: `Dockerfile.frontend`
- Modify: `cloudbuild-frontend.yaml`

**Interfaces:**
- Consumes: `MEASUREMENT_ID` from Task 1 reads `process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID`.
- Produces: `NEXT_PUBLIC_GA_MEASUREMENT_ID` available at build time.

- [ ] **Step 1: Add the build arg to the Dockerfile**

In `Dockerfile.frontend`, after the `ARG NEXT_PUBLIC_AGENT_BASE_URL` line and its comment, add:

```dockerfile
# The GA4 measurement ID. Baked into the client bundle, which is correct and
# not a leak: a measurement ID is a public identifier, visible in View Source
# on every site that uses GA. Empty is a supported value -- the analytics
# components render nothing without it, so a build with no ID is today's site.
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID
```

And after the `ENV NEXT_PUBLIC_AGENT_BASE_URL=$NEXT_PUBLIC_AGENT_BASE_URL` line:

```dockerfile
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID
```

- [ ] **Step 2: Add the build arg to Cloud Build**

In `cloudbuild-frontend.yaml`, in step 1's `args` list, after the
`'NEXT_PUBLIC_AGENT_BASE_URL=${_NEXT_PUBLIC_AGENT_BASE_URL}'` line and before `'.'`:

```yaml
      - '--build-arg'
      - 'NEXT_PUBLIC_GA_MEASUREMENT_ID=${_NEXT_PUBLIC_GA_MEASUREMENT_ID}'
```

- [ ] **Step 3: Add the substitution**

At the end of the `substitutions:` block in `cloudbuild-frontend.yaml`:

```yaml
  # GA4 measurement ID (G-XXXXXXXXXX). Empty by default and safe that way: the
  # analytics components render nothing without it, so an un-set build produces
  # the pre-analytics site rather than a broken one.
  #
  # Because it is baked in at BUILD time, creating the GA property does not
  # make a running deployment start reporting -- the frontend must be rebuilt.
  # Same gotcha as _NEXT_PUBLIC_AGENT_BASE_URL above.
  _NEXT_PUBLIC_GA_MEASUREMENT_ID: ''
```

- [ ] **Step 4: Verify the substitution parses**

```bash
node -e "const y=require('fs').readFileSync('cloudbuild-frontend.yaml','utf8');const n=(y.match(/_NEXT_PUBLIC_GA_MEASUREMENT_ID/g)||[]).length;console.log('references:',n);process.exit(n===2?0:1)"
```

Expected: `references: 2` and exit 0 — one in the build step, one in `substitutions`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.frontend cloudbuild-frontend.yaml
git commit -m "Plumb the GA measurement ID through the build, defaulting to empty"
```

---

## Task 3: The Analytics component

**Files:**
- Create: `frontend/src/components/analytics.tsx`
- Modify: `frontend/src/app/layout.tsx`

**Interfaces:**
- Consumes: `MEASUREMENT_ID`, `isRegulatedRegion`, `resolveTimeZone`, `readConsent` from `@/lib/analytics`.
- Produces: default-exported `<Analytics/>`, taking no props. Establishes `window.gtag` for `track()`.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/analytics.tsx`:

```tsx
"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import {
  MEASUREMENT_ID,
  isRegulatedRegion,
  readConsent,
  resolveTimeZone,
} from "@/lib/analytics";

/**
 * GA4, loaded consent-first.
 *
 * The ordering here is the entire design, and it is the part most GA4
 * integrations get wrong: they load gtag.js and ask for consent afterwards, by
 * which point `_ga` is already written and the banner is decoration.
 *
 * 1. `beforeInteractive` sets Consent Mode v2 defaults to DENIED for everyone,
 *    unconditionally, before gtag.js is even requested. No cookie exists for
 *    any visitor in any region at this point.
 * 2. gtag.js loads `afterInteractive` with `send_page_view: false`. Denied is
 *    not silence -- Google still receives cookieless modelled pings, so rough
 *    EU volume survives visitors who never accept.
 * 3. On mount, once the browser can be asked where it is, non-EU visitors are
 *    granted immediately and EU visitors get their stored answer or a banner.
 *
 * Defaulting to denied globally and granting on mount -- rather than deciding
 * at script-load time -- is what makes step 1 possible at all. Region is only
 * knowable once the browser is running, and the defaults must be set before
 * that.
 */
export default function Analytics() {
  if (!MEASUREMENT_ID) return null;

  return (
    <>
      <Script id="ga-consent-default" strategy="beforeInteractive">
        {`
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'granted',
  security_storage: 'granted',
  wait_for_update: 500
});
gtag('js', new Date());
gtag('config', '${MEASUREMENT_ID}', { send_page_view: false });
        `}
      </Script>
      <Script
        id="ga-tag"
        strategy="afterInteractive"
        src={`https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`}
      />
      <ConsentGrant />
      <Suspense fallback={null}>
        <PageViews />
      </Suspense>
    </>
  );
}

/**
 * Grants analytics storage on mount for visitors outside the EEA/UK.
 *
 * EU/UK visitors are left in the denied default; `<ConsentBanner/>` owns their
 * answer. A stored "granted" is re-applied here so a returning EU visitor is
 * measured without waiting for the banner component to decide not to render.
 */
function ConsentGrant() {
  useEffect(() => {
    const regulated = isRegulatedRegion(resolveTimeZone());
    const stored = readConsent();
    const grant = regulated ? stored === "granted" : stored !== "denied";
    if (!grant) return;
    window.gtag?.("consent", "update", { analytics_storage: "granted" });
  }, []);
  return null;
}

/**
 * One `page_view` per navigation, sent by hand.
 *
 * GA4's Enhanced Measurement claims to catch History API navigations, but App
 * Router's pushState pattern makes that unreliable and prone to double-counting
 * the first view. An explicit send is cheaper to debug than a discrepancy
 * discovered three months of data later.
 *
 * `useSearchParams` forces this into a Suspense boundary, which is why it is a
 * separate component rather than an effect in `Analytics` -- without the
 * boundary it opts every page into client-side rendering.
 */
function PageViews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    window.gtag?.("event", "page_view", {
      page_path: query ? `${pathname}?${query}` : pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [pathname, searchParams]);

  return null;
}
```

- [ ] **Step 2: Mount it in the root layout**

In `frontend/src/app/layout.tsx`, add to the imports beside the other component imports:

```tsx
import Analytics from "@/components/analytics";
```

Then, inside `<body>`, immediately after the opening tag and before the liquid-glass `<svg>` block, add:

```tsx
        <Analytics />
```

- [ ] **Step 3: Verify the build is clean**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds. Because no `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set locally, `<Analytics/>` returns `null` and nothing changes.

- [ ] **Step 4: Verify lint is clean**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analytics.tsx frontend/src/app/layout.tsx
git commit -m "Load GA4 consent-first: denied by default, granted only where allowed"
```

---

## Task 4: The consent banner

**Files:**
- Create: `frontend/src/components/consent-banner.tsx`
- Modify: `frontend/src/app/layout.tsx`

**Interfaces:**
- Consumes: `MEASUREMENT_ID`, `isRegulatedRegion`, `resolveTimeZone`, `readConsent`, `writeConsent` from `@/lib/analytics`.
- Produces: default-exported `<ConsentBanner/>`, taking no props.

- [ ] **Step 1: Create the component**

Create `frontend/src/components/consent-banner.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  MEASUREMENT_ID,
  isRegulatedRegion,
  readConsent,
  resolveTimeZone,
  writeConsent,
  type ConsentChoice,
} from "@/lib/analytics";

/**
 * Asks EU/UK visitors before `_ga` is written. Nobody else ever sees it.
 *
 * Deliberately not a modal and not a blocker: it does not trap focus, does not
 * dim the page and does not stop anyone reading the site. A visitor who ignores
 * it entirely stays in the denied default, which is the correct outcome and
 * needs no interaction to reach.
 *
 * Both buttons are the same size and weight. A giant "Accept" beside a grey
 * whisper of a "Decline" is the pattern regulators describe as a dark one, and
 * the privacy page this links to would be lying next to it.
 */
export default function ConsentBanner() {
  // `null` means "not decided yet" -- rendering nothing on the first pass
  // matters, because the server has no timezone and no localStorage, and a
  // banner rendered server-side would flash for every visitor on earth before
  // hydration corrected it.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!MEASUREMENT_ID) return;
    if (!isRegulatedRegion(resolveTimeZone())) return;
    if (readConsent() !== null) return;
    setVisible(true);
  }, []);

  if (!visible) return null;

  const decide = (choice: ConsentChoice) => {
    writeConsent(choice);
    if (choice === "granted") {
      window.gtag?.("consent", "update", { analytics_storage: "granted" });
    }
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Analytics consent"
      className="fixed bottom-0 left-0 right-0 z-[100] lg:bottom-4 lg:left-4 lg:right-auto lg:max-w-[380px] bg-surface-container-low/95 backdrop-blur-xl border-t lg:border lg:rounded-2xl border-white/[0.10] shadow-[0_-8px_40px_rgba(0,0,0,0.5)] lg:shadow-[0_10px_40px_rgba(0,0,0,0.5)] px-5 py-4"
    >
      <p className="font-medium text-[13px] leading-relaxed text-warm-200">
        APEX uses Google Analytics to count visits and see which pages get used.
        No accounts, no ads, no profile.{" "}
        <Link
          href="/privacy"
          className="underline text-warm-100 hover:text-on-background transition-colors"
        >
          What it collects
        </Link>
        .
      </p>
      <div className="flex gap-2.5 mt-3.5">
        <button
          type="button"
          onClick={() => decide("granted")}
          className="flex-1 min-h-[40px] rounded-xl bg-primary-container text-on-primary-container font-semibold text-[13px] hover:brightness-110 transition"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => decide("denied")}
          className="flex-1 min-h-[40px] rounded-xl border border-white/[0.14] font-semibold text-[13px] text-warm-200 hover:bg-white/[0.05] transition"
        >
          Decline
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount it in the root layout**

In `frontend/src/app/layout.tsx`, beside the `Analytics` import:

```tsx
import ConsentBanner from "@/components/consent-banner";
```

Then, inside `<body>`, immediately after `<Analytics />`:

```tsx
        <ConsentBanner />
```

- [ ] **Step 3: Verify the token names exist**

The banner uses `bg-surface-container-low`, `text-warm-200`, `bg-primary-container` and `text-on-primary-container`. Confirm each is a real token rather than a silently-dead class — this codebase has been bitten by exactly that (see the `FooterGroup` docblock in `layout.tsx`):

```bash
grep -oE "on-primary-container|primary-container|surface-container-low|warm-100|warm-200" frontend/src/app/globals.css | sort -u
```

Expected: all five names present. If `on-primary-container` is absent, substitute the token `globals.css` actually defines for text on a primary surface and note the substitution in the commit message.

- [ ] **Step 4: Verify the build and lint are clean**

```bash
npm run build && npm run lint
```

Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/consent-banner.tsx frontend/src/app/layout.tsx
git commit -m "Ask EU and UK visitors before writing the cookie, and nobody else"
```

---

## Task 5: The eight events

**Files:**
- Create: `frontend/src/components/degraded-beacon.tsx`
- Modify: `frontend/src/components/pitwall-assistant-launcher.tsx`
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx`
- Modify: `frontend/src/components/race-replay.tsx`
- Modify: `frontend/src/components/watch-view.tsx`
- Modify: `frontend/src/components/track3d/track-viewer-mount.tsx`
- Modify: `frontend/src/components/track3d/generate-geometry.tsx`
- Modify: `frontend/src/components/global-search.tsx`
- Modify: `frontend/src/app/standings/page.tsx`

**Interfaces:**
- Consumes: `track` from `@/lib/analytics`.
- Produces: `<DegradedBeacon route={string} />`.

- [ ] **Step 1: Create the degraded beacon**

Create `frontend/src/components/degraded-beacon.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/**
 * Fires `backend_unavailable` once, from a server-rendered page's empty state.
 *
 * This exists because the thing worth measuring cannot be measured where it
 * happens. Every page catches its own fetch failure and renders empty rather
 * than erroring, so a degraded page still returns HTTP 200 and Cloud Run logs
 * see a healthy request. The client is the only place the difference is
 * visible.
 *
 * The catches are in `async` server components, which have no `gtag`, so the
 * page renders this instead: one client component, one effect, no state.
 *
 * Once per mount, which is once per route view -- the question is "how often
 * does someone see a degraded page", not "how many fetches failed".
 */
export default function DegradedBeacon({ route }: { route: string }) {
  useEffect(() => {
    track("backend_unavailable", { route });
  }, [route]);
  return null;
}
```

- [ ] **Step 2: `pitwall_panel_open`**

In `frontend/src/components/pitwall-assistant-launcher.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

Change the button's handler at line 52 from:

```tsx
        onClick={() => setOpen(true)}
```

to:

```tsx
        onClick={() => {
          track("pitwall_panel_open", { via: "button" });
          setOpen(true);
        }}
```

And in the Cmd/Ctrl+K keyboard handler, change the `setOpen(true)` near line 43 to:

```tsx
      track("pitwall_panel_open", { via: "shortcut" });
      setOpen(true);
```

- [ ] **Step 3: `pitwall_message_sent`**

In `frontend/src/components/pitwall-assistant-panel.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

Change line 490 from:

```tsx
  const send = useCallback(() => ask(input), [ask, input]);
```

to:

```tsx
  /**
   * The COUNT is tracked, never the message. What users type already goes to a
   * model provider, and that is disclosed; sending it to Google as well would
   * be a second disclosure for no analytical gain.
   */
  const send = useCallback(() => {
    track("pitwall_message_sent");
    return ask(input);
  }, [ask, input]);
```

- [ ] **Step 4: `watch_replay_start`**

In `frontend/src/components/race-replay.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

At line 247, change:

```tsx
            setPlaying((p) => !p);
```

to:

```tsx
            setPlaying((p) => {
              // Only the transition into playing is an event. Pause is not
              // interesting, and counting both would double every session.
              if (!p) track("watch_replay_start", { race_id: replay.race_id });
              return !p;
            });
```

If `replay.race_id` is not a field on the `RaceReplay` type, use the identifier that type actually carries (check `src/lib/api.ts` for the `RaceReplay` interface) and keep the parameter name `race_id`.

- [ ] **Step 5: `watch_pair_qr`**

In `frontend/src/components/watch-view.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

Find the handler behind the "Show a pairing code" button near line 2128 and add, as the first statement of that handler:

```tsx
    track("watch_pair_qr");
```

This measures the *host* offering a code, which is the decision worth counting — a scan that never happens is exactly the finding the event exists to surface.

- [ ] **Step 6: `circuit_3d_view`**

In `frontend/src/components/track3d/track-viewer-mount.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

And an effect that fires once when the viewer mounts, placed with the component's other hooks:

```tsx
  useEffect(() => {
    track("circuit_3d_view", { circuit_id: circuitId });
  }, [circuitId]);
```

Add `useEffect` to the existing `react` import if it is not already there. If the component does not receive a `circuitId` prop, use the prop that identifies the circuit and keep the parameter name `circuit_id`.

- [ ] **Step 7: `circuit_3d_generate`**

In `frontend/src/components/track3d/generate-geometry.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

In the `start` callback bound at line 234, add as its first statement:

```tsx
    track("circuit_3d_generate", { circuit_id: circuitId });
```

Use the component's own circuit-identifying prop; keep the parameter name `circuit_id`.

- [ ] **Step 8: `search_result_selected`**

In `frontend/src/components/global-search.tsx`, add the import:

```tsx
import { track } from "@/lib/analytics";
```

At line 267, change:

```tsx
  const handleSelect = (result: SearchResult) => {
```

to:

```tsx
  const handleSelect = (result: SearchResult) => {
    // The KIND only. A search query is free text a user typed, and free text
    // never leaves this app.
    track("search_result_selected", { entity_kind: result.kind });
```

- [ ] **Step 9: `backend_unavailable` on the standings page**

In `frontend/src/app/standings/page.tsx`, add the import:

```tsx
import DegradedBeacon from "@/components/degraded-beacon";
```

On the render path taken when the fetch in the `catch` at line 52 left the standings empty, render the beacon beside the existing "unavailable" message:

```tsx
        <DegradedBeacon route="/standings" />
```

Then do the same for each other page with an empty-data path, passing that page's own route string: `/schedule`, `/drivers`, `/teams`, `/circuits`. Read each page's empty branch before editing it — they do not share a shape.

- [ ] **Step 10: Verify the build, lint and tests**

```bash
npm run build && npm run lint && npm test
```

Expected: all three succeed. The unit tests are unaffected by this task and must still pass.

- [ ] **Step 11: Verify no user text reaches an event**

```bash
grep -rn "track(" frontend/src --include=*.tsx
```

Expected: every call passes a literal event name and either no parameters or an enum-ish value (`result.kind`, a circuit id, a route literal, `"button"`/`"shortcut"`). **No call may pass `input`, `query`, a message body, or any state holding typed text.** If one does, fix it before committing.

- [ ] **Step 12: Commit**

```bash
git add frontend/src
git commit -m "Instrument the eight questions, and none of what users type"
```

---

## Task 6: Honest privacy and FAQ copy

**Files:**
- Modify: `frontend/src/app/(info)/privacy/page.tsx`
- Modify: `frontend/src/app/(info)/faq/page.tsx`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Pure copy.

- [ ] **Step 1: Update the privacy page metadata**

Change the `description` in the `metadata` export from:

```tsx
    "APEX has no analytics, no ad tech and no accounts. One strictly-necessary cookie, two browser-local preferences, and one real disclosure: what happens to Pitwall chat messages.",
```

to:

```tsx
    "What APEX measures with Google Analytics, the two cookies it can set, two browser-local preferences, and one real disclosure: what happens to Pitwall chat messages.",
```

- [ ] **Step 2: Update the lede**

Change:

```tsx
        Short, because there is not much to say. APEX runs no analytics and has
        no accounts. The one thing worth reading carefully is what happens to
        what you type into the chat assistant.
```

to:

```tsx
        Short, because there is not much to say. APEX has no accounts and sells
        nothing. It does measure which pages get used, and it asks first where
        the law requires that. The one thing worth reading carefully is what
        happens to what you type into the chat assistant.
```

- [ ] **Step 3: Replace the analytics bullet**

In the "What APEX does not do" list, delete this item entirely:

```tsx
        <li>
          <strong>No analytics.</strong> No Google Analytics, no PostHog, no
          product-analytics tooling of any kind.
        </li>
```

Leave the other three bullets (no advertising, no accounts, no selling) in place — all three remain true. Change the "no selling" bullet from:

```tsx
          <strong>No selling or sharing of personal data</strong>, because none
          is collected in the first place.
```

to:

```tsx
          <strong>No selling or sharing of personal data.</strong> Analytics
          data is not sold, and Google Signals and ad personalisation are both
          switched off.
```

- [ ] **Step 4: Add the analytics section**

Insert a new `<h2>` section immediately before "The one cookie":

```tsx
      <h2>Analytics</h2>
      <p>
        APEX uses <strong>Google Analytics 4</strong> to answer questions it
        otherwise cannot: which of its pages are actually used, whether people
        arrive on a phone or a desktop, and whether features like the race
        replay and the 3D circuit viewer are ever opened. This site is a
        portfolio project with no accounts and no revenue, and until now it had
        no way of knowing whether any of it worked.
      </p>
      <p>What is collected:</p>
      <ul>
        <li>
          Pages viewed and how long was spent on each, device type, browser,
          language, approximate location (city level — Google discards the IP
          address rather than storing it), and the link or search that brought
          you here.
        </li>
        <li>
          Eight specific interactions, by name: opening the Pitwall assistant,
          sending it a message, starting a race replay, showing a second-screen
          pairing code, opening a 3D circuit view, generating one, selecting a
          search result, and loading a page whose data failed to arrive.
        </li>
      </ul>
      <p>
        <strong>The message count is recorded; the messages are not.</strong>{" "}
        Nothing you type — into the assistant or into search — is ever sent to
        Google. Nor is anything that could identify you: there are no accounts,
        so there is no identity to attach. Data is deleted after 14 months.
      </p>

      <h2>Consent, and why there is now a banner</h2>
      <p>
        Google Analytics sets a cookie named <strong>_ga</strong>. Unlike the
        rate-limiting cookie below, it is not strictly necessary, so it is not
        something we get to set without asking.
      </p>
      <p>
        If your browser reports a timezone in the EU, the EEA or the UK, you are
        asked before anything is stored, and analytics stays switched off until
        you say yes. Ignoring the banner leaves it off. Everywhere else,
        analytics is on by default. That is a legal distinction rather than a
        judgement about who deserves privacy, and it is stated plainly here
        rather than hidden behind a banner nobody reads.
      </p>
      <p>
        You can opt out anywhere in the world by using your browser&apos;s
        do-not-track or cookie controls, by blocking{" "}
        <strong>googletagmanager.com</strong>, or with any content blocker — a
        substantial share of visitors already do, and the numbers here are
        undercounts because of it.
      </p>
```

- [ ] **Step 5: Fix the "no consent banner" paragraph**

In "The one cookie", the closing sentence now contradicts the page. Change:

```tsx
        It carries no profile, records nothing about you, and is useless to any
        other site. It is set only when you use the assistant. Nothing else on
        APEX sets a cookie, which is why there is no consent banner: a
        strictly-necessary cookie does not require one, and a banner asking
        permission for something you cannot decline would be theatre.
```

to:

```tsx
        It carries no profile, records nothing about you, and is useless to any
        other site. It is set only when you use the assistant, and it is the one
        cookie here you are not asked about: a strictly-necessary cookie does
        not require consent, and asking permission for something you cannot
        decline would be theatre. The analytics cookie above is a different
        matter, which is why that one is asked about.
```

- [ ] **Step 6: Rewrite the FAQ answer**

In `frontend/src/app/(info)/faq/page.tsx`, change the "Do you track me?" answer from:

```tsx
        No analytics, no ad tech, no tracking pixels, no accounts. One cookie is
        set when you use the chat assistant, purely to rate-limit requests
        fairly. <Link href="/privacy">Privacy</Link>.
```

to:

```tsx
        Google Analytics counts visits and page use — no ad tech, no accounts,
        and nothing you type is ever sent to it. In the EU, EEA and UK you are
        asked first and it stays off unless you agree.{" "}
        <Link href="/privacy">What it collects</Link>.
```

- [ ] **Step 7: Check the FAQ metadata**

```bash
grep -n "analytics\|track" "frontend/src/app/(info)/faq/page.tsx" | head
```

If the page's `metadata.description` claims no analytics, rewrite it the same way as the body. Fix whatever this surfaces.

- [ ] **Step 8: Verify no stale claim survives anywhere**

```bash
grep -rniE "no analytics|no google analytics|no tracking pixels" frontend/src
```

Expected: **no output.** Any hit is a claim the site no longer honours. Fix it before committing.

- [ ] **Step 9: Verify the build**

```bash
npm run build
```

Expected: succeeds. Watch for unescaped apostrophes — this codebase uses `&apos;`.

- [ ] **Step 10: Commit**

```bash
git add "frontend/src/app/(info)"
git commit -m "Say what APEX now measures, and stop claiming it measures nothing"
```

---

## Task 7: Browser verification

**Files:** none modified. This task produces evidence.

**Interfaces:** Consumes everything built above.

Verification runs in **headless Chrome, not the Claude browser preview pane** — routes with `loading.tsx` stall there because a hidden tab starves the rAF-gated reveal, which looks like a bug and is not one.

- [ ] **Step 1: Run a dev server with a test measurement ID**

From `frontend/`:

```bash
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-TESTONLY123 npm run dev
```

- [ ] **Step 2: Verify the absent-ID path first**

In a separate checkout of the same branch, or after stopping the above, run `npm run dev` with **no** measurement ID and confirm:

```bash
curl -s http://localhost:3000/ | grep -c "googletagmanager"
```

Expected: `0`. No script tag, no banner markup.

- [ ] **Step 3: Verify script ordering with an ID set**

With the ID set:

```bash
curl -s http://localhost:3000/ | grep -o "ga-consent-default\|googletagmanager.com/gtag/js\|consent', 'default'" | head
```

Expected: `ga-consent-default` and the consent default call appear; the `gtag/js` src appears **after** them in document order.

- [ ] **Step 4: Verify the cookie is not set before consent, in a non-EU timezone**

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --dump-dom --virtual-time-budget=5000 http://localhost:3000/ > /tmp/apex-dom.html
```

Then check with a real page session — load the site in headless Chrome with `TZ=Asia/Kolkata`, wait for hydration, and read `document.cookie`. Expected: `_ga` **is** present (non-EU grants on mount) and **no banner** is in the DOM.

- [ ] **Step 5: Verify the banner appears and gates the cookie in an EU timezone**

Repeat with `TZ=Europe/Berlin`. Expected, before any click:
- The consent banner **is** in the DOM (`role="dialog"`, `aria-label="Analytics consent"`).
- `document.cookie` contains **no `_ga`**.

Then click "Allow" and confirm `_ga` appears and the banner disappears. Reload and confirm the banner does not return.

Then clear storage, reload, click "Decline", and confirm `_ga` never appears and the banner does not return on reload.

- [ ] **Step 6: Verify one page_view per navigation**

With DevTools protocol or `--enable-logging`, capture requests to `google-analytics.com/g/collect` while navigating `/` → `/standings` → `/drivers`. Expected: exactly **three** `page_view` events, not six.

- [ ] **Step 7: Verify an event fires with no user text**

Open the Pitwall assistant and send a message. Inspect the `collect` request for `pitwall_message_sent`. Expected: the event name is present and **the message body is not** anywhere in the payload.

- [ ] **Step 8: Record the evidence**

Append an "Implementation notes" section to
`docs/superpowers/specs/2026-08-22-google-analytics-design.md` recording what was verified, what the timezone override showed, and anything that differed from this plan.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/specs/2026-08-22-google-analytics-design.md
git commit -m "Record what was verified in the browser, including the two consent paths"
```

---

## Manual steps, outside this repo

Neither can be done from the codebase, and the second is irreversible if missed:

1. Create the GA4 property and take its `G-XXXXXXXXXX` measurement ID. Set
   `_NEXT_PUBLIC_GA_MEASUREMENT_ID` in `cloudbuild-frontend.yaml`, or pass it as
   a substitution at build time.
2. **Set data retention to 14 months.** The default is 2, and history lost to
   the default is not recoverable. Enable the free BigQuery export at the same
   time, for the same reason.

Because the ID is baked in at build time, **the frontend must be rebuilt after
the property exists** — creating it alone will not make the deployment report.
