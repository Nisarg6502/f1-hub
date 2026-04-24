import Link from "next/link";

export default function TelemetryPage() {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.28em] text-f1-muted">
            F1 Telemetry Comparison
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Lap times, speed traces & tyre stints
          </h2>
        </div>
        <span className="rounded-full border border-f1-border bg-black/70 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-f1-muted">
          Powered by FastF1
        </span>
      </header>

      <section className="glass-panel p-6">
        <p className="max-w-xl text-sm text-f1-muted">
          The backend already contains a rich `telemetry.py` FastF1
          configuration. This Next.js view is designed to mirror that UX: a
          driver comparator, race pace evolution chart, telemetry comparison
          tabs, and tyre stint analysis. To keep this repo light, the heavy
          FastF1 processing stays on the backend; you can expose it via a
          dedicated API or Streamlit service and embed it here.
        </p>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-f1-border bg-black/70 p-4">
            <div className="text-[0.7rem] uppercase tracking-[0.22em] text-f1-muted">
              1 · Session & driver selector
            </div>
            <p className="mt-2 text-xs text-f1-muted">
              Build a client component that calls your FastAPI/FastF1 endpoints
              to select year, event, session type, and up to 3 drivers for
              comparison.
            </p>
          </div>
          <div className="rounded-xl border border-f1-border bg-black/70 p-4">
            <div className="text-[0.7rem] uppercase tracking-[0.22em] text-f1-muted">
              2 · Lap time evolution
            </div>
            <p className="mt-2 text-xs text-f1-muted">
              Render the race pace graph using a charting library like
              `react-chartjs-2` or `recharts`, fed by the lap data returned from
              FastF1.
            </p>
          </div>
          <div className="rounded-xl border border-f1-border bg-black/70 p-4">
            <div className="text-[0.7rem] uppercase tracking-[0.22em] text-f1-muted">
              3 · Stint & telemetry tabs
            </div>
            <p className="mt-2 text-xs text-f1-muted">
              Add tabs for telemetry traces (speed, throttle, brake) and a tyre
              stint timeline mirroring the Streamlit layout from the backend.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3 text-xs">
          <Link
            href="/schedule"
            className="rounded-full border border-f1-border bg-black/60 px-4 py-2 text-[0.7rem] uppercase tracking-[0.22em] text-f1-muted hover:border-f1-cyan/70 hover:text-f1-cyan"
          >
            Back to schedule
          </Link>
          <Link
            href="/standings"
            className="rounded-full border border-f1-border bg-black/60 px-4 py-2 text-[0.7rem] uppercase tracking-[0.22em] text-f1-muted hover:border-f1-cyan/70 hover:text-f1-cyan"
          >
            View standings
          </Link>
        </div>
      </section>
    </div>
  );
}

