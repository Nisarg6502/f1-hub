"use client";

/**
 * Last-resort boundary, for a throw in the root layout itself.
 *
 * This one REPLACES the root layout, which is why it renders its own `<html>`
 * and `<body>` and why it cannot use any of the app's fonts, tokens or glass
 * utilities — none of that has loaded when this renders. Everything here is
 * inline and self-contained on purpose.
 *
 * It should essentially never be seen. `error.tsx` catches the realistic
 * failures; this exists so that the one case it cannot catch degrades to
 * something legible and on-brand rather than to a white page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#120f0c",
          color: "#f6f1ea",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: "44ch" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              marginBottom: "20px",
            }}
          >
            <span
              style={{
                width: "9px",
                height: "9px",
                borderRadius: "999px",
                background: "#FF5A1F",
                display: "inline-block",
              }}
            />
            <span style={{ fontWeight: 800, fontSize: "21px", letterSpacing: "-0.5px" }}>
              APEX
            </span>
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 800, margin: "0 0 10px" }}>
            APEX failed to start
          </h1>
          <p
            style={{
              fontSize: "14px",
              lineHeight: 1.7,
              color: "#a89e90",
              margin: "0 0 22px",
            }}
          >
            Something went wrong before the page could render. Reloading usually
            fixes it.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontSize: "13px",
              fontWeight: 700,
              color: "#f6f1ea",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderRadius: "11px",
              padding: "13px 20px",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ fontSize: "12px", color: "#6f665b", marginTop: "22px" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
