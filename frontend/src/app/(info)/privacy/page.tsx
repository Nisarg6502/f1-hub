import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | APEX",
  description:
    "APEX has no analytics, no ad tech and no accounts. One strictly-necessary cookie, two browser-local preferences, and one real disclosure: what happens to Pitwall chat messages.",
};

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="lede">
        Short, because there is not much to say. APEX runs no analytics and has
        no accounts. The one thing worth reading carefully is what happens to
        what you type into the chat assistant.
      </p>

      <h2>What APEX does not do</h2>
      <ul>
        <li>
          <strong>No analytics.</strong> No Google Analytics, no PostHog, no
          product-analytics tooling of any kind.
        </li>
        <li>
          <strong>No advertising and no tracking pixels.</strong>
        </li>
        <li>
          <strong>No accounts.</strong> There is nothing to sign up for and
          nothing to log into, so there is no profile to build.
        </li>
        <li>
          <strong>No selling or sharing of personal data</strong>, because none
          is collected in the first place.
        </li>
      </ul>

      <h2>The one cookie</h2>
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
        other site. It is set only when you use the assistant. Nothing else on
        APEX sets a cookie, which is why there is no consent banner: a
        strictly-necessary cookie does not require one, and a banner asking
        permission for something you cannot decline would be theatre.
      </p>

      <h2>Stored in your browser only</h2>
      <p>
        Two things are kept locally and never sent anywhere: your display
        preferences on the Watch page (pinned drivers, density, timing mode),
        and a marker letting a watch session resume if you reload. Clearing site
        data in your browser removes both.
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
        OpenTopoData (circuit elevation), and Google Calendar only if you use an
        add-to-calendar link. Where those come from is described on{" "}
        <Link href="/data-sources">data sources</Link>.
      </p>

      <h2>Retention</h2>
      <p>
        Rate-limiting records expire automatically. The session cookie expires
        after seven days. Conversation threads are currently kept without a
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
