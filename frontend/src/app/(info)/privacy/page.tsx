import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | APEX",
  description:
    "What APEX measures with Google Analytics, the two cookies it can set, two browser-local preferences, and one real disclosure: what happens to Pitwall chat messages.",
};

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="lede">
        Short, because there is not much to say. APEX has no accounts and sells
        nothing. It does measure which pages get used, and it asks first where
        the law requires it. The one thing worth reading carefully is what
        happens to what you type into the chat assistant.
      </p>

      <h2>What APEX does not do</h2>
      <ul>
        <li>
          <strong>No advertising and no retargeting.</strong> Nothing here
          feeds an ad network: the analytics below runs with ad storage and ad
          personalisation switched off, so it measures use and cannot be used
          to follow you somewhere else.
        </li>
        <li>
          <strong>No accounts.</strong> There is nothing to sign up for and
          nothing to log into, so there is no profile to build.
        </li>
        <li>
          <strong>No selling or sharing of personal data.</strong> Analytics
          data is not sold, and Google Signals and ad personalisation are both
          switched off.
        </li>
      </ul>

      <h2>Analytics</h2>
      <p>
        APEX uses <strong>Google Analytics 4</strong> to answer questions it
        otherwise cannot: which of these pages are actually used, whether people
        arrive on a phone or a desktop, and whether things like the race replay
        and the 3D circuit viewer are ever opened. This is a portfolio project
        with no accounts and no revenue, and until now it had no way of knowing
        whether any of it worked.
      </p>
      <p>What is collected:</p>
      <ul>
        <li>
          Pages viewed and how long was spent on each, device type, browser,
          language, approximate location to city level (Google discards the IP
          address rather than storing it), and the link or search that brought
          you here.
        </li>
        <li>
          Eight specific interactions, by name: opening the Pitwall assistant,
          sending it a message, starting a race replay, showing a second-screen
          pairing code, opening a 3D circuit view, generating one, selecting a
          search result, and loading a page whose data failed to arrive.
        </li>
      </ul>
      <p>
        <strong>The message count is recorded; the messages are not.</strong>{" "}
        Nothing you type — into the assistant or into the search box — is ever
        sent to Google. Nor is anything that could identify you: there are no
        accounts here, so there is no identity to attach. Analytics data is
        deleted after 14 months.
      </p>

      <h2>Consent, and why there is now a banner</h2>
      <p>
        Google Analytics sets a cookie named <strong>_ga</strong>. Unlike the
        rate-limiting cookie below, it is not strictly necessary, so it is not
        something to set without asking.
      </p>
      <p>
        If your browser reports a timezone in the EU, the EEA or the UK, you are
        asked before anything is stored, and analytics stays switched off until
        you say yes. Ignoring the banner leaves it off. Everywhere else,
        analytics is on by default. That is a legal distinction rather than a
        judgement about who deserves privacy, and it seems better stated plainly
        here than hidden behind a banner nobody reads.
      </p>
      <p>
        You can opt out anywhere in the world using your browser&apos;s cookie
        controls, by blocking <strong>googletagmanager.com</strong>, or with any
        content blocker — a substantial share of visitors already do, which
        means the numbers this produces are undercounts.
      </p>

      <h2>The other cookie</h2>
      <p>
        Using the Pitwall assistant sets a single cookie named{" "}
        <strong>f1_agent_sid</strong>. It is a signed random identifier, it
        expires after seven days, and it exists for one reason: rate limiting.
        Without it, everyone sharing an IP address — which on mobile networks
        can be thousands of people — shares one request allowance, and one heavy
        user exhausts it for everybody else.
      </p>
      <p>
        It carries no profile, records nothing about you, and is useless to any
        other site. It is set only when you use the assistant, and it is the one
        cookie here you are not asked about: a strictly-necessary cookie does
        not require consent, and asking permission for something you cannot
        decline would be theatre. The analytics cookie above is a different
        matter, which is exactly why that one is asked about.
      </p>

      <h2>Stored in your browser only</h2>
      <p>
        Two things are kept locally and never sent anywhere: your display
        preferences on the Watch page (pinned drivers, density, timing mode),
        and a marker letting a watch session resume if you reload. Your answer
        to the analytics banner is kept the same way. Clearing site data in your
        browser removes all three — and, in the EU and UK, means you will be
        asked about analytics again.
      </p>

      <h2>Chat messages — the real disclosure</h2>
      <p>
        This is the part that actually matters. When you use the Pitwall
        assistant, what you type leaves this site and reaches four places:
      </p>
      <div className="info-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Receives</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Ollama Cloud</td>
              <td>Your message</td>
              <td>Runs the language model that writes the answer</td>
            </tr>
            <tr>
              <td>LangSmith</td>
              <td>A trace of the conversation</td>
              <td>Debugging and quality checks. This is on in production.</td>
            </tr>
            <tr>
              <td>Tavily</td>
              <td>Search queries derived from your question</td>
              <td>Only when the assistant looks something up on the web</td>
            </tr>
            <tr>
              <td>MongoDB Atlas</td>
              <td>The conversation thread</td>
              <td>
                So the assistant remembers earlier turns within one conversation
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Practical advice: <strong>do not type personal information into the
        chat.</strong> Messages containing card numbers, national ID numbers or
        phone numbers are rejected before they reach a model or a trace, but
        that filter is a safety net for obvious cases, not a guarantee.
      </p>
      <p>
        Thumbs-up and thumbs-down votes, and any comment you attach to one, are
        stored so answers can be improved.
      </p>

      <h2>Requests your browser makes elsewhere</h2>
      <p>
        Loading APEX causes your browser to contact a few other hosts directly,
        which means those hosts see your IP address: Google Fonts (typefaces),
        OpenF1 (live timing on some pages), Wikimedia Commons (images),
        OpenTopoData (circuit elevation), Google Analytics (unless you have
        declined or blocked it), and Google Calendar only if you use an
        add-to-calendar link. Where those come from is described on{" "}
        <Link href="/data-sources">data sources</Link>.
      </p>

      <h2>Retention</h2>
      <p>
        Rate-limiting records expire automatically. The session cookie expires
        after seven days. Analytics data is deleted after 14 months, which is
        the longest Google Analytics allows. Conversation threads are currently kept without a
        fixed expiry — if you want one removed, ask via{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub Issues
        </a>
        , though note that an issue is public, so do not quote anything private
        in it.
      </p>

      <h2>This is a personal project</h2>
      <p>
        APEX is built and run by one person, on free service tiers, with no
        company behind it. It is not a commercial service, and it should not be
        treated as one. Anything you send to the assistant should be something
        you would be comfortable being processed by the third parties named
        above.
      </p>
    </>
  );
}
