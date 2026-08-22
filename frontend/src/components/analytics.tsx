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
 * knowable once the browser is running, and the defaults have to be set before
 * that.
 *
 * Renders nothing without a measurement ID, which is how local development and
 * any un-configured build stay exactly as the site was before analytics.
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
 * Grants analytics storage on mount for visitors outside the EEA and UK.
 *
 * EU/UK visitors are left in the denied default; `<ConsentBanner/>` owns their
 * answer. A stored "granted" is re-applied here so a returning EU visitor is
 * measured without waiting on the banner component to decide not to render.
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
 * separate component rather than another effect in `Analytics` -- without the
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
