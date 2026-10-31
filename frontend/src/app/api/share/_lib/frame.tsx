import type { CSSProperties, ReactNode } from "react";
import type { ShareFormat } from "@/lib/share";
import { getInkOn } from "@/lib/team-colors";
import { fitFontSize, initials } from "@/lib/share-text";
import { sharePortraitBox } from "@/lib/share-results";
import { DRIVER_PORTRAIT_SOURCE_HEIGHT, type DriverPortraitFrame } from "@/lib/driver-portrait";
import { PORTRAIT_CROP_ROWS } from "./assets";

/**
 * The chrome and primitives every share card is built from.
 *
 * Satori (under `next/og`) renders a small CSS subset: flexbox only, no grid,
 * no `backdrop-filter`, no stylesheet, every multi-child `div` explicitly
 * `display: flex`. So the APEX glass is approximated the way
 * `opengraph-image.tsx` approximates it — flat warm panels with a hairline
 * border over a near-black ground, and one radial flame glow — rather than
 * attempted badly. Values are the tokens from `globals.css`, copied because
 * Satori cannot read CSS variables.
 */
export const C = {
  bg: "#0a0908",
  panel: "rgba(40,32,26,0.55)",
  panelStrong: "rgba(255,90,31,0.12)",
  border: "rgba(255,255,255,0.08)",
  borderFlame: "rgba(255,138,61,0.42)",
  text: "#f6f1ea",
  sub: "#c9c0b4",
  muted: "#a89e90",
  dim: "#8f867a",
  faint: "#5c554b",
  grid: "rgba(255,255,255,0.07)",
  flame: "#FF5A1F",
  flameMid: "#FF7A3D",
  flameLight: "#FFAE6A",
  error: "#ff9b8a",
} as const;

export const HEAD = "Bricolage Grotesque";
export const BODY = "Hanken Grotesk";

/** Per-format spacing, so each card reads one table instead of scattering ternaries. */
export function frameMetrics(format: ShareFormat) {
  return format === "landscape"
    ? { padX: 56, padTop: 40, padBottom: 30, title: 52, eyebrow: 15, subtitle: 20, footer: 15, gap: 22 }
    : { padX: 64, padTop: 60, padBottom: 44, title: 72, eyebrow: 19, subtitle: 26, footer: 19, gap: 34 };
}

export interface CardFrameProps {
  format: ShareFormat;
  /** Small caps label, top right: "2026 · Round 17". */
  eyebrow: string;
  title: string;
  /** Second half of the title, in flame. */
  accent?: string;
  subtitle?: string;
  /** Bottom-right line: what the data is, and as of when. */
  footnote: string;
  /** Host the card was generated on, bottom left. */
  host: string;
  children: ReactNode;
}

export function CardFrame({ format, eyebrow, title, accent, subtitle, footnote, host, children }: CardFrameProps) {
  const m = frameMetrics(format);
  const titleText = accent ? `${title} ${accent}` : title;
  const titleSize = fitFontSize(titleText, {
    maxWidth: (format === "landscape" ? 1200 : 1080) - m.padX * 2,
    maxSize: m.title,
    minSize: Math.round(m.title * 0.62),
    emPerChar: 0.55,
  });
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: C.bg,
        backgroundImage:
          "radial-gradient(circle at 92% -8%, rgba(255,90,31,0.30) 0%, rgba(226,58,14,0.10) 32%, rgba(10,9,8,0) 62%)",
        padding: `${m.padTop}px ${m.padX}px ${m.padBottom}px`,
        fontFamily: BODY,
        color: C.text,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: m.eyebrow + 3,
              height: m.eyebrow + 3,
              borderRadius: 999,
              backgroundImage: `linear-gradient(135deg, ${C.flameLight}, ${C.flame})`,
            }}
          />
          <div style={{ fontFamily: HEAD, fontWeight: 800, fontSize: m.eyebrow + 9, letterSpacing: -0.8 }}>APEX</div>
        </div>
        <div
          style={{
            display: "flex",
            fontWeight: 800,
            fontSize: m.eyebrow,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: C.flameMid,
            padding: "7px 14px",
            borderRadius: 999,
            border: `1px solid ${C.borderFlame}`,
            backgroundColor: "rgba(255,90,31,0.08)",
          }}
        >
          {eyebrow}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          marginTop: m.gap * 0.8,
          fontFamily: HEAD,
          fontWeight: 800,
          fontSize: titleSize,
          letterSpacing: -titleSize * 0.03,
          lineHeight: 1.04,
        }}
      >
        <span>{title}</span>
        {accent && <span style={{ color: C.flameLight, marginLeft: titleSize * 0.25 }}>{accent}</span>}
      </div>
      {subtitle && (
        <div style={{ display: "flex", marginTop: 8, fontSize: m.subtitle, fontWeight: 500, color: C.muted }}>
          {subtitle}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, marginTop: m.gap, minHeight: 0 }}>{children}</div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: m.gap * 0.7,
          fontSize: m.footer,
          fontWeight: 500,
          color: C.dim,
        }}
      >
        <div style={{ display: "flex" }}>{host}</div>
        <div style={{ display: "flex" }}>{footnote}</div>
      </div>
    </div>
  );
}

/**
 * A driver cutout framed like the page frames it, or initials on the team
 * colour when the asset set has no portrait.
 *
 * The fallback is deliberate rather than a broken-image box: a missing
 * portrait is the normal case for most of the 2018–2021 grid, so it has to
 * look designed. The initials take the ink `getInkOn` picks for the team
 * colour, the same AA rule the page's abbreviation chips follow.
 */
export function Portrait({
  src,
  name,
  teamHex,
  width,
  height,
  frame,
  radius = 16,
}: {
  src: string | null;
  name: string;
  teamHex: string;
  width: number;
  height: number;
  frame: DriverPortraitFrame;
  radius?: number;
}) {
  if (!src) {
    return (
      <div
        style={{
          width,
          height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius,
          backgroundImage: `linear-gradient(160deg, ${teamHex}, ${teamHex}88)`,
          color: getInkOn(teamHex),
          fontFamily: HEAD,
          fontWeight: 800,
          fontSize: Math.round(Math.min(width, height) * 0.36),
          letterSpacing: -1,
        }}
      >
        {initials(name)}
      </div>
    );
  }
  const box = sharePortraitBox(width, height, frame);
  // The transcoded portrait is only the top PORTRAIT_CROP_ROWS of the source
  // (see `loadDriverPortrait`), so it is drawn that much shorter; the
  // positioning is unchanged because the crop starts at row 0.
  const drawnHeight = Math.round(box.height * (PORTRAIT_CROP_ROWS / DRIVER_PORTRAIT_SOURCE_HEIGHT) * 10) / 10;
  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        position: "relative",
        overflow: "hidden",
        borderRadius: radius,
        backgroundImage: `linear-gradient(180deg, ${teamHex}55, ${teamHex}10)`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders <img>, not next/image */}
      <img
        src={src}
        alt=""
        width={box.width}
        height={drawnHeight}
        style={{ position: "absolute", top: box.top, left: box.left, width: box.width, height: drawnHeight }}
      />
    </div>
  );
}

/** A thin vertical team-colour bar, the row marker the standings page uses. */
export function TeamBar({ hex, height }: { hex: string; height: number }) {
  return <div style={{ width: 5, height, borderRadius: 3, backgroundColor: hex, flexShrink: 0 }} />;
}

/** One-line text that ellipsises instead of overflowing. */
export function Clip({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "block",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** An honest empty state, centred in the card body. */
export function EmptyBody({ format, title, detail }: { format: ShareFormat; title: string; detail: string }) {
  const big = format === "landscape" ? 34 : 44;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 22,
        border: `1px solid ${C.border}`,
        backgroundColor: C.panel,
        padding: 40,
        textAlign: "center",
      }}
    >
      <div style={{ display: "flex", fontFamily: HEAD, fontWeight: 800, fontSize: big, letterSpacing: -1 }}>{title}</div>
      <div style={{ display: "flex", marginTop: 14, fontSize: big * 0.55, fontWeight: 500, color: C.muted, maxWidth: 760 }}>
        {detail}
      </div>
    </div>
  );
}

/**
 * `host` for the footer: the configured public site, never the request's
 * `Host` / `X-Forwarded-Host`. Those headers are caller-controlled, and a
 * card is an image other people see — trusting them would let anyone render
 * an APEX-branded card that names a domain of their choosing. Same variable
 * and fallback as `metadataBase` in `app/layout.tsx`.
 */
export function cardHost(): string {
  try {
    return new URL(
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://f1-frontend-2w5wydk2ca-el.a.run.app"
    ).host;
  } catch {
    return "APEX";
  }
}
