import { NextResponse } from "next/server";

/**
 * Server-side proxy for the RapidAPI live-timing feed.
 *
 * This route exists so the API key stops being a build-time public value.
 * `getLiveTimingData` read `NEXT_PUBLIC_RAPIDAPI_KEY` and was called from
 * `/telemetry`, which is a client component — and `NEXT_PUBLIC_*` is INLINED
 * INTO THE CLIENT BUNDLE at build time, so anyone could have read the key out
 * of View Source. It was never exploited only because the key was never
 * provisioned (`cloudbuild-frontend.yaml` defaults it to an empty string), so
 * this was a loaded gun rather than a live leak: the first person to provision
 * the key would have published it in the same deploy.
 *
 * The key is now `RAPIDAPI_KEY`, without the prefix, which means Next will
 * never inline it and it must be supplied at RUNTIME rather than baked into
 * the image.
 *
 * `force-dynamic` because live timing that is cached is not live timing.
 */
export const dynamic = "force-dynamic";

const DEFAULT_HOST = "f1-live-pulse.p.rapidapi.com";

export async function GET() {
  const key = process.env.RAPIDAPI_KEY;
  const host = process.env.RAPIDAPI_HOST ?? DEFAULT_HOST;

  if (!key) {
    // 503, not 500: an unconfigured optional feed is a service that is not
    // available, not a bug. The telemetry page already renders a "no session
    // currently live" state, and this lets it stay on that path.
    return NextResponse.json(
      { error: "live_timing_unconfigured", message: "Live timing is not configured." },
      { status: 503 }
    );
  }

  try {
    const upstream = await fetch(`https://${host}/timingData`, {
      headers: {
        "X-Rapidapi-Key": key,
        "X-Rapidapi-Host": host,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      // The upstream status is deliberately NOT forwarded verbatim, and the
      // upstream body is not forwarded at all. A 401 or 403 here means our key
      // is wrong, which is not the caller's business and is exactly the kind of
      // detail that tells someone probing the endpoint what to try next.
      console.error(`RapidAPI live timing responded ${upstream.status}`);
      return NextResponse.json(
        { error: "live_timing_unavailable", message: "Live timing is unavailable." },
        { status: 502 }
      );
    }

    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error("RapidAPI live timing request failed:", error);
    return NextResponse.json(
      { error: "live_timing_unavailable", message: "Live timing is unavailable." },
      { status: 502 }
    );
  }
}
