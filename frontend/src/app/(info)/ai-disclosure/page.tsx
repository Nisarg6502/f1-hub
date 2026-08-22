import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AI disclosure | APEX",
  description:
    "How the Pitwall assistant works: which parts of an answer are retrieved records and which are model interpretation, what it cannot see, and what happens to what you type.",
};

export default function AiDisclosurePage() {
  return (
    <>
      <h1>AI disclosure</h1>
      <p className="lede">
        The Pitwall assistant is a language model reading this site&apos;s own
        F1 data. It is useful and it is fallible, and the difference between
        those two states is visible in the answer if you know what to look for.
        This page explains how to look.
      </p>

      <h2>What is retrieved, and what is written</h2>
      <p>
        An answer mixes two different kinds of statement, and they are not
        equally trustworthy.
      </p>
      <ul>
        <li>
          <strong>Underlined values are retrieved.</strong> Each one is tied to
          a specific record the assistant actually read. Activating an underline
          opens that record with the proving field highlighted, and highlights
          the matching entry in the &ldquo;Records used&rdquo; strip below the
          answer. If you can click it, a stored record says it.
        </li>
        <li>
          <strong>Everything else is the model&apos;s own prose.</strong> The
          framing, the comparisons, the causal explanations and the
          conclusions are generated. They may be reasonable. They are not
          evidence.
        </li>
      </ul>
      <p>
        The &ldquo;Records used&rdquo; strip lists only records the answer
        actually leans on, with how many statements rest on each. If an answer
        shows no strip at all, nothing in this site&apos;s data backed it.
      </p>

      <h2>What it checks before answering you</h2>
      <p>
        Every draft is checked against the records it cited. Three things get
        flagged: a citation pointing at a record that was never retrieved, a
        number in a cited sentence that does not appear in that record, and any
        sentence carrying a meaningful number with no citation at all. A flagged
        draft gets one attempt to correct itself.
      </p>
      <p>
        When that attempt does not resolve it, the answer is still shown, with a
        note saying some of it could not be verified. Take that note seriously —
        it means a specific claim failed a specific check.
      </p>

      <h2>What it can get wrong</h2>
      <ul>
        <li>
          <strong>Misreading a record it really did retrieve.</strong> The
          citation will be genuine and the interpretation still wrong.
        </li>
        <li>
          <strong>Stating things with no record behind them.</strong> The
          verifier catches numbers; it cannot catch a confident, unnumbered,
          incorrect sentence.
        </li>
        <li>
          <strong>Being confidently out of date.</strong> It reads the same
          synced data as the rest of the site, with the same lag described on{" "}
          <Link href="/data-sources">data sources</Link>.
        </li>
      </ul>

      <h2>It is not watching the race</h2>
      <p>
        The assistant has no live feed, no video, and no access to a session in
        progress. It reads the same stored data every other page reads. If you
        ask what just happened on lap 30 of a running race, it does not know,
        and a plausible answer to that question is a fabricated one.
      </p>

      <h2>What happens to what you type</h2>
      <p>
        Your messages leave this site. They are sent to the model provider that
        runs the assistant, traced for debugging, and stored so a conversation
        can remember its own context. Search queries derived from your question
        go to a third-party search provider when the assistant looks something
        up on the web. <Link href="/privacy">Privacy</Link> names each recipient.
      </p>
      <p>
        Messages containing card numbers, national ID numbers or phone numbers
        are refused before they reach a model, a log or a trace. That is a
        blunt filter on an F1 site that has no reason to process any of them —
        not a reason to type personal information here.
      </p>

      <h2>Telling us it is wrong</h2>
      <p>
        Every answer carries thumbs-up and thumbs-down controls, and the
        thumbs-down opens a box for what went wrong. That feedback is the main
        way errors here get found. Please use it.
      </p>
    </>
  );
}
