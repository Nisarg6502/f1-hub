import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data sources | APEX",
  description:
    "Where APEX's timing, results, telemetry, standings and weather come from, how fresh each source is, and why numbers here can differ from the official timing screen.",
};

export default function DataSourcesPage() {
  return (
    <>
      <h1>Data sources</h1>
      <p className="lede">
        APEX has no data of its own. Every number on this site was published by
        someone else, and the five upstreams below settle at genuinely different
        speeds. This page exists so you can tell which one you are looking at.
      </p>

      <h2>Where each number comes from</h2>
      <div className="info-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>What it provides</th>
              <th>How fresh</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <a href="https://docs.fastf1.dev" target="_blank" rel="noopener noreferrer">
                  FastF1
                </a>
              </td>
              <td>
                Telemetry, lap times, tyre stints, pit stops, session
                classifications
              </td>
              <td>After a session ends — never live</td>
            </tr>
            <tr>
              <td>
                <a href="https://openf1.org" target="_blank" rel="noopener noreferrer">
                  OpenF1
                </a>
              </td>
              <td>
                Near-live timing on Live and Watch, and the per-session weather
                on every race page
              </td>
              <td>Seconds to minutes behind</td>
            </tr>
            <tr>
              <td>
                <a href="https://jolpi.ca/ergast" target="_blank" rel="noopener noreferrer">
                  Jolpica
                </a>{" "}
                (successor to Ergast)
              </td>
              <td>
                Standings, results, the schedule, and historical constructor
                seasons back to 1950
              </td>
              <td>Once results are published; rate limited</td>
            </tr>
            <tr>
              <td>
                <a href="https://en.wikipedia.org" target="_blank" rel="noopener noreferrer">
                  Wikipedia
                </a>
              </td>
              <td>Constructor heritage prose on Teams</td>
              <td>Effectively static</td>
            </tr>
            <tr>
              <td>
                <a
                  href="https://www.opentopodata.org"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  OpenTopoData
                </a>
              </td>
              <td>Circuit elevation, used to build the 3D track models</td>
              <td>Built once per circuit</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>How often this updates</h2>
      <p>
        A sync job runs <strong>hourly</strong>. It only asks an upstream for a
        session once that session should have finished — a race is given four
        hours before anything computed from the whole race is read, so a
        half-run session cannot be mistaken for a complete one.
      </p>
      <p>
        This means a result can appear here up to about an hour after it appears
        on the official timing screen. That is a deliberate trade: asking more
        often would cost more than this project can spend, and asking too early
        returns half a session.
      </p>

      <h2>Why our numbers may differ from the official screen</h2>
      <p>
        Mostly because the upstreams disagree with each other before they agree.
        Provisional classifications get amended, penalties land after the flag,
        and each provider publishes on its own schedule. If APEX and the
        official app disagree an hour after a session, APEX is the one that is
        wrong — trust the official source.
      </p>
      <p>
        Two specifics worth knowing. <strong>Weather</strong> is a single sample
        taken mid-session from OpenF1, not an average, so a track temperature
        here describes one moment rather than the whole hour; rainfall is the
        exception and is computed across every sample in the session, reported
        with the share of the session that was wet. <strong>Telemetry</strong>{" "}
        is never live: FastF1 publishes after a session ends, so anything on a
        car-data page is a replay.
      </p>

      <h2>Known limitations</h2>
      <ul>
        <li>
          FastF1&apos;s live-timing source is intermittently unreachable from
          the cloud region this runs in. It fails soft rather than erroring, so
          a round can be briefly incomplete and then fill in on a later sync.
        </li>
        <li>
          Jolpica rate-limits, so a season&apos;s worth of historical requests
          is deliberately throttled and can lag.
        </li>
        <li>
          Rounds cached before a change to how a figure is computed keep the old
          shape until the next sync back-fills them.
        </li>
      </ul>

      <h2>Terms and attribution</h2>
      <p>
        Data is used under each provider&apos;s own terms. Wikipedia-derived
        text is available under{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noopener noreferrer"
        >
          CC BY-SA 4.0
        </a>
. <Link href="/attributions">Attributions</Link> lists every source, image and
        font with the licence it is used under — including the assets that are
        not freely licensed.
      </p>
      <p>
        None of these providers is affiliated with APEX, and APEX is not
        affiliated with Formula 1 — see the{" "}
        <Link href="/disclaimer">disclaimer</Link>. For how the assistant uses
        this data, see <Link href="/ai-disclosure">AI disclosure</Link>.
      </p>
    </>
  );
}
