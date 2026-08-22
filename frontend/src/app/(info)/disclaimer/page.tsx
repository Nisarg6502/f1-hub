import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Disclaimer | APEX",
  description:
    "APEX is an unofficial, independent fan project. It is not affiliated with, endorsed by or connected to Formula 1, the FIA, FOM, Liberty Media, or any team or driver.",
};

export default function DisclaimerPage() {
  return (
    <>
      <h1>Disclaimer</h1>
      <p className="lede">
        APEX is an independent fan project. Nobody in Formula 1 has anything to
        do with it.
      </p>

      <h2>Not affiliated, not endorsed</h2>
      <p>
        APEX is not affiliated with, endorsed by, sponsored by, or connected to
        Formula 1, Formula One World Championship Limited, Formula One
        Management, the Fédération Internationale de l&apos;Automobile (FIA),
        Liberty Media, or any Formula 1 team, driver, circuit or commercial
        partner.
      </p>
      <p>
        <em>F1</em>, <em>FORMULA 1</em>, <em>FIA FORMULA ONE WORLD
        CHAMPIONSHIP</em>, <em>GRAND PRIX</em> and related marks are trade marks
        of Formula One Licensing BV or their respective owners. Team names,
        driver names, circuit names and liveries belong to their respective
        owners. They are used here descriptively, to refer to the real
        competition this site reports on, and for no other purpose.
      </p>

      <h2>No guarantee of accuracy</h2>
      <p>
        Everything here comes from third-party sources, arrives on their
        schedule, and can be wrong, incomplete, delayed or missing. Some of it
        is written by a language model, which can be confidently incorrect — see{" "}
        <Link href="/ai-disclosure">AI disclosure</Link>. Nothing on this site
        is official timing or an official result.
      </p>
      <p>
        <strong>
          For anything that matters, use the official Formula 1 sources.
        </strong>{" "}
        Where APEX and an official source disagree, the official source is
        right.
      </p>

      <h2>Not for betting, and not advice</h2>
      <p>
        Do not use this site for betting, wagering, fantasy-league decisions, or
        anything else with money attached. It is not built for that, its data
        lags, and its assistant can invent things. Nothing here is advice of any
        kind.
      </p>

      <h2>No guarantee of availability</h2>
      <p>
        APEX runs on free service tiers as a personal project. It may be slow,
        rate-limited, partially broken, or entirely offline at any time, with no
        notice and no obligation to restore it. Features can change or disappear.
      </p>

      <h2>Liability</h2>
      <p>
        This site is provided as is, without warranties of any kind. To the
        fullest extent permitted by law, no liability is accepted for any loss
        or damage arising from your use of it or reliance on anything it
        displays.
      </p>

      <h2>Something wrong here?</h2>
      <p>
        If you believe this project misuses a mark, or something on it is
        inaccurate, please open an issue on{" "}
        <a
          href="https://github.com/Nisarg6502/f1-hub/issues"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        . It will be dealt with promptly.
      </p>
    </>
  );
}
