import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "FAQ | APEX",
  description:
    "Why live data is delayed, whether the assistant watches the race, why numbers differ from the official app, where telemetry comes from, and how to report a bug.",
};

/**
 * Answers are short and point onward.
 *
 * This page is deliberately not the authority on anything: each answer states
 * the fact and links to the page that owns it. Two copies of "how fresh is the
 * data" drift apart the first time one of them is updated, and the version a
 * reader happens to land on decides what they believe.
 */
export default function FaqPage() {
  return (
    <>
      <h1>FAQ</h1>
      <p className="lede">
        The questions this site actually gets asked, answered as briefly as they
        can honestly be.
      </p>

      <h2>Why is live data delayed?</h2>
      <p>
        Because none of it is live. A sync job runs hourly and only reads a
        session once it should have finished, so a result can appear here up to
        about an hour after the official screen has it. Asking more often would
        cost more than this project spends; asking earlier returns half a
        session. <Link href="/data-sources">Full detail</Link>.
      </p>

      <h2>Does the assistant watch the race live?</h2>
      <p>
        No. It has no video, no live feed, and no access to a session in
        progress — it reads the same stored data as every other page. If you ask
        it what just happened on lap 30 of a running race, it does not know, and
        a confident answer to that question is a fabricated one.{" "}
        <Link href="/ai-disclosure">More</Link>.
      </p>

      <h2>Why doesn&apos;t this match F1TV or the official app?</h2>
      <p>
        Usually timing: provisional classifications get amended, penalties land
        after the flag, and each upstream publishes on its own schedule. If APEX
        still disagrees an hour after a session, APEX is wrong.{" "}
        <strong>The official sources are authoritative; this site is not.</strong>
      </p>

      <h2>Where does telemetry come from?</h2>
      <p>
        FastF1, which publishes after a session ends. Everything on a car-data
        page is a replay of a completed session, never a live trace.
      </p>

      <h2>Why does the weather look wrong for a practice session?</h2>
      <p>
        It should not any more. Conditions are now read per session — practice,
        qualifying, sprint and race each get their own figures. Temperatures are
        a single mid-session sample rather than an average, and rainfall is
        computed across the whole session and shown with the share of it that
        was wet.
      </p>

      <h2>Is this official?</h2>
      <p>
        No. APEX is an independent fan project with no connection to Formula 1,
        the FIA, or any team. <Link href="/disclaimer">Disclaimer</Link>.
      </p>

      <h2>Do you track me?</h2>
      <p>
        No analytics, no ad tech, no tracking pixels, no accounts. One cookie is
        set when you use the chat assistant, purely to rate-limit requests
        fairly. <Link href="/privacy">Privacy</Link>.
      </p>

      <h2>Is my chat private?</h2>
      <p>
        Not entirely, and this is worth knowing before you type. Messages are
        sent to the model provider that runs the assistant, traced for
        debugging, and stored so a conversation remembers its own context.{" "}
        <strong>Do not type personal information into it.</strong>{" "}
        <Link href="/privacy">Who receives what</Link>.
      </p>

      <h2>Why did my conversation disappear?</h2>
      <p>
        Chat history lives in the page, not in your account — there are no
        accounts. Closing the panel or reloading starts a fresh conversation.
      </p>

      <h2>The assistant gave me a wrong answer.</h2>
      <p>
        Use the thumbs-down on that answer. It attaches the exact run, which a
        bug report cannot, and it is the main way errors here get found. If part
        of an answer could not be verified against a stored record, the answer
        says so at the bottom — that note is worth taking seriously.
      </p>

      <h2>How do I report a bug?</h2>
      <p>
        <a
          href="https://github.com/Nisarg6502/f1-hub/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub Issues
        </a>
        . Wrong data is the most useful kind of report — say which page, which
        session, and what you expected to see.
      </p>

      <h2>Can I use this data?</h2>
      <p>
        The data is not APEX&apos;s to license — it belongs to the upstream
        providers, under their terms. Go to them directly rather than scraping
        this site; they are listed on{" "}
        <Link href="/data-sources">data sources</Link>.
      </p>
    </>
  );
}
