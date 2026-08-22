import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Attributions | APEX",
  description:
    "Where APEX's data, imagery, fonts and code come from, and under what licence each one is used — including the assets that are not freely licensed.",
};

export default function AttributionsPage() {
  return (
    <>
      <h1>Attributions &amp; licences</h1>
      <p className="lede">
        Nothing on this site is APEX&apos;s own work except the code. This page
        says where each piece came from and on what terms — including the parts
        that are <strong>not</strong> freely licensed, because leaving those out
        would be the dishonest half.
      </p>

      <h2>Data</h2>
      <div className="info-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Used for</th>
              <th>Terms</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <a href="https://docs.fastf1.dev" target="_blank" rel="noopener noreferrer">
                  FastF1
                </a>
              </td>
              <td>Telemetry, laps, stints, pit stops, classifications</td>
              <td>MIT (library). The timing data it retrieves belongs to Formula 1.</td>
            </tr>
            <tr>
              <td>
                <a href="https://openf1.org" target="_blank" rel="noopener noreferrer">
                  OpenF1
                </a>
              </td>
              <td>Near-live timing and per-session weather</td>
              <td>Free public API, used under its own terms</td>
            </tr>
            <tr>
              <td>
                <a href="https://jolpi.ca/ergast" target="_blank" rel="noopener noreferrer">
                  Jolpica
                </a>{" "}
                (Ergast successor)
              </td>
              <td>Schedule, results, standings, history to 1950</td>
              <td>Non-commercial use, with attribution</td>
            </tr>
            <tr>
              <td>
                <a href="https://en.wikipedia.org" target="_blank" rel="noopener noreferrer">
                  Wikipedia
                </a>
              </td>
              <td>Constructor heritage prose on Teams</td>
              <td>
                <a
                  href="https://creativecommons.org/licenses/by-sa/4.0/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  CC BY-SA 4.0
                </a>
              </td>
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
              <td>Circuit elevation for the 3D track models</td>
              <td>Open dataset, free public endpoint</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Team logos</h2>
      <p>
        Eight of the eleven constructors are shown with their real logo. Each
        was checked against its actual file licence on Wikimedia Commons rather
        than a search summary, and only files tagged{" "}
        <strong>PD-textlogo</strong>, <strong>CC0</strong> or{" "}
        <strong>CC BY 4.0</strong> were used: Mercedes, Williams, Haas, Audi,
        Cadillac, Aston Martin, McLaren and Alpine.
      </p>
      <p>
        <strong>Ferrari, Red Bull and Racing Bulls are deliberately shown
        without a logo.</strong> All three use pictorial emblems that sit above
        the originality threshold PD-textlogo requires, and Racing Bulls&apos;
        is a non-free fair-use file on Wikipedia itself — explicitly not
        reusable here. They render as a colour-and-monogram treatment instead.
        That is a licensing decision, not a missing asset.
      </p>
      <p>
        The Aston Martin logo is CC BY 4.0, which requires attribution: it is
        credited on the{" "}
        <Link href="/teams">Teams</Link> page as the licence asks.
      </p>

      <h2>Car renders</h2>
      <p>
        The car images are <strong>Formula 1&apos;s own press assets, all
        rights reserved.</strong> They are not freely licensed and are not
        offered here for reuse. They are used on a fan site that makes no claim
        to them and earns nothing from them; if their owner objects, they will
        be removed —{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          open an issue
        </a>
        .
      </p>
      <p>
        They are listed apart from the logos on purpose. The logos are
        Wikimedia CC0/CC-BY material, which is exactly why three teams have none
        rather than one sourced from somewhere more convenient, and blurring the
        two categories together would hide that distinction.
      </p>

      <h2>Driver images, circuit imagery and flags</h2>
      <p>
        Driver portraits and circuit imagery are used editorially to illustrate
        reporting about the people and places concerned; rights remain with
        their respective owners. Country flags are public-domain national
        symbols. As above, anything here will be removed on request from its
        owner.
      </p>

      <h2>Fonts</h2>
      <ul>
        <li>
          <strong>Bricolage Grotesque</strong> and <strong>Hanken Grotesk</strong>{" "}
          — both under the{" "}
          <a
            href="https://openfontlicense.org"
            target="_blank"
            rel="noopener noreferrer"
          >
            SIL Open Font License
          </a>
          , served via Google Fonts.
        </li>
        <li>
          <strong>Material Symbols</strong> — Apache License 2.0.
        </li>
      </ul>

      <h2>Software</h2>
      <p>
        APEX is built on open source: Next.js and React, Tailwind CSS, Motion,
        Three.js, Recharts, FastAPI, Pydantic, Motor and PyMongo, LangGraph and
        LangChain, pandas and NumPy, and many more. Each is used under its own
        licence — overwhelmingly MIT or Apache 2.0. The complete, exact list
        with versions is in{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub"
          target="_blank"
          rel="noopener noreferrer"
        >
          the repository
        </a>
        &apos;s <code>package.json</code> and <code>requirements</code> files,
        which are the authoritative record — a hand-copied list on this page
        would go stale the first time a dependency changed.
      </p>

      <h2>APEX itself</h2>
      <p>
        The source code is public on{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        . The site is unofficial and unaffiliated — see the{" "}
        <Link href="/disclaimer">disclaimer</Link> — and the data it displays is
        not APEX&apos;s to license onward. If you want this data, go to the
        providers listed on <Link href="/data-sources">data sources</Link>{" "}
        directly rather than scraping this site.
      </p>
    </>
  );
}
