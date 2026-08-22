import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About | APEX",
  description:
    "APEX is an independent Formula 1 hub: schedule, standings, drivers, teams, circuits, telemetry and a cited chat assistant. Built by Nisarg as a personal project.",
};

export default function AboutPage() {
  return (
    <>
      <h1>About APEX</h1>
      <p className="lede">
        A Formula 1 hub that tries to be honest about what it knows. Schedule,
        standings, drivers, teams, circuits, session results, telemetry replays,
        history back to 1950, and an assistant that shows its sources.
      </p>

      <h2>What it is</h2>
      <p>
        APEX pulls Formula 1 data from several public sources, stores it, and
        presents it in one place. Nothing here is exclusive — the underlying
        numbers are all public. What the site adds is putting them together,
        making them navigable, and being explicit about where each one came from
        and how old it is.
      </p>

      <h2>Why it exists</h2>
      <p>
        Two reasons. The first is ordinary: following a season means holding a
        lot of context — who is where in the standings, what happened at this
        circuit last year, whether a driver&apos;s pace is real or a fuel load —
        and most of that lives across a dozen tabs. This is an attempt at one
        tab.
      </p>
      <p>
        The second is that most AI features bolted onto data sites are
        untrustworthy in a specific, fixable way: they mix retrieved facts and
        generated prose into one confident paragraph and give you no way to tell
        them apart. The assistant here was built to make that distinction
        visible — values that came from a record are underlined and open the
        record that proves them, and a deterministic check runs over every draft
        before you see it. It still gets things wrong. It just does not hide
        which parts you should check.
      </p>

      <h2>What makes it different</h2>
      <ul>
        <li>
          <strong>Cited answers.</strong> Every retrieved value in an assistant
          answer links to the record it came from.{" "}
          <Link href="/ai-disclosure">How that works</Link>.
        </li>
        <li>
          <strong>Stated provenance.</strong> Every source and its freshness is
          written down on <Link href="/data-sources">one page</Link>, including
          the parts that lag.
        </li>
        <li>
          <strong>Real session data.</strong> Per-session weather, tyre stints,
          pit stops, lap-position charts and telemetry replays, not just a
          results table.
        </li>
        <li>
          <strong>History that goes back.</strong> Constructor lineages and
          season records to 1950, including teams that no longer exist.
        </li>
      </ul>

      <h2>Who built it</h2>
      <p>
        APEX is built and maintained by <strong>Nisarg</strong>, as a personal
        project. There is no company, no team and no funding behind it — it runs
        entirely on free service tiers, which is also why it is sometimes slow
        and occasionally rate-limited.
      </p>
      <p>
        It is open source. The{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub"
          target="_blank"
          rel="noopener noreferrer"
        >
          full source is on GitHub
        </a>
        , including the parts that are not finished.
      </p>

      <h2>Contact</h2>
      <p>
        Everything goes through GitHub. There is no support email — a personal
        address on a public page collects spam faster than it collects useful
        messages, and an issue thread is easier to actually resolve.
      </p>
      <ul>
        <li>
          <strong>Found a bug, or wrong data?</strong>{" "}
          <a
            href="https://github.com/Nisarg6502/f1-hub/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open an issue
          </a>
          . Wrong numbers are the most useful reports — say which page, which
          session, and what you expected.
        </li>
        <li>
          <strong>Question or idea?</strong>{" "}
          <a
            href="https://github.com/Nisarg6502/f1-hub/discussions"
            target="_blank"
            rel="noopener noreferrer"
          >
            Start a discussion
          </a>
          .
        </li>
        <li>
          <strong>Assistant gave a bad answer?</strong> Use the thumbs-down on
          the answer itself — it attaches the exact run, which an issue cannot.
        </li>
      </ul>
      <p>
        Note that GitHub issues and discussions are public. Do not post anything
        you would not want read by anyone.
      </p>

      <h2>The obligatory caveat</h2>
      <p>
        APEX is unofficial and unaffiliated. It is not Formula 1, it does not
        speak for Formula 1, and for anything that matters you should use the
        official sources. The <Link href="/disclaimer">disclaimer</Link> says
        this properly.
      </p>
    </>
  );
}
