import { ImageResponse } from "next/og";
import { getActiveSeasonYear } from "@/lib/api";

/**
 * The link preview card, generated at request time by `next/og`.
 *
 * Generated rather than a committed PNG for one reason worth stating: the
 * season is in it. A static image would have to be re-exported every January
 * or start lying, which is the same trap the hardcoded 2026 in the page title
 * fell into.
 *
 * Deliberately built from primitives only — a flat background, a dot, two
 * lines of type. `next/og` runs in an edge-style runtime with a small CSS
 * subset (no backdrop-filter, no external stylesheet), so the app's glass
 * treatment cannot be reproduced here and approximating it badly would look
 * worse than not trying.
 */
export const runtime = "nodejs";
export const alt = "APEX — Formula 1 season hub";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const season = getActiveSeasonYear();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#120f0c",
          padding: "84px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
          <div
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "999px",
              background: "#FF5A1F",
            }}
          />
          <div
            style={{
              fontSize: "58px",
              fontWeight: 800,
              color: "#f6f1ea",
              letterSpacing: "-2px",
            }}
          >
            APEX
          </div>
        </div>

        <div
          style={{
            fontSize: "70px",
            fontWeight: 800,
            color: "#f6f1ea",
            letterSpacing: "-2.5px",
            marginTop: "38px",
            lineHeight: 1.1,
          }}
        >
          {`The ${season} Formula 1 season,`}
        </div>
        <div
          style={{
            fontSize: "70px",
            fontWeight: 800,
            color: "#FFAE6A",
            letterSpacing: "-2.5px",
            lineHeight: 1.1,
          }}
        >
          in one place.
        </div>

        <div
          style={{
            fontSize: "27px",
            color: "#8f867a",
            marginTop: "34px",
          }}
        >
          Schedule · Standings · Telemetry · History
        </div>
      </div>
    ),
    size
  );
}
