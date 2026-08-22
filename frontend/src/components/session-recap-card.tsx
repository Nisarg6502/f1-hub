"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { useReducedMotion } from "motion/react";
import { getSessionRecapUrl, type RecapSession } from "@/lib/api";

interface SessionRecapCardProps {
  year: number;
  round: number;
  /** Defaults to "race" — the original CP38 behaviour is unchanged for
   * existing callers that don't pass this. */
  session?: RecapSession;
}

const RECAP_LABEL: Record<RecapSession, string> = {
  race: "AI Recap",
  qualifying: "AI Recap · Qualifying",
  sprint: "AI Recap · Sprint",
};

const GENERATING_LABEL: Record<RecapSession, string> = {
  race: "Generating recap…",
  qualifying: "Generating qualifying recap…",
  sprint: "Generating sprint recap…",
};

// The recap cites the data behind each claim inline: [P1] for a classification
// row, [FL] for the fastest lap, [RC 66] for a race-control event on that lap,
// or — in the Qualifying recap — [Q3 P4] for a segment time. Rendering them as
// muted chips keeps the prose readable while still letting a reader check any
// statement against the classification/segment table below.
// Whitespace inside the brackets is tolerated because the model emits both
// "[P1]" and "[ P1 ]" depending on the sentence.
const CITATION_RE = /\[\s*(?:Q\d[^\]]*?|P\d+[^\]]*?|FL|RC[^\]]*?)\s*\]/g;

// A race-control citation with a lap points at a real moment in the race
// replay's scrubber; one with no lap ("RC", a lap deletion or a session-wide
// note) has nowhere on the timeline to land, so it stays a plain chip like
// every other citation. The prompt's documented format is "RC L66", but the
// model doesn't reliably follow it — live recaps have been observed emitting
// bare "RC 66" instead (the same instruction-drift session_recap.py's own
// vocabulary validator exists to catch on the generation side). The `L` is
// therefore optional here rather than assumed.
const RC_WITH_LAP_RE = /^RC\s*L?\s*(\d+)$/i;

function decorateCitations(children: ReactNode, replayHref?: (lap: number) => string): ReactNode {
  return (
    <>
      {(Array.isArray(children) ? children : [children]).map((child, index) => {
        if (typeof child !== "string") return <Fragment key={index}>{child}</Fragment>;

        const parts = child.split(CITATION_RE);
        const matches = child.match(CITATION_RE) ?? [];

        return (
          <Fragment key={index}>
            {parts.map((part, i) => (
              <Fragment key={i}>
                {part}
                {matches[i] && (() => {
                  const label = matches[i].slice(1, -1).trim();
                  const lapMatch = replayHref ? label.match(RC_WITH_LAP_RE) : null;
                  const chipClass =
                    "inline-block align-baseline font-semibold text-[10px] tracking-[0.04em] text-[#FF9A5A]/70 bg-primary-container/8 rounded px-1 py-px mx-0.5";

                  return lapMatch ? (
                    <Link
                      href={replayHref!(Number(lapMatch[1]))}
                      className={`${chipClass} hover:text-[#FF9A5A] hover:bg-primary-container/16 transition-colors`}
                      title={`Jump to lap ${lapMatch[1]} in the race replay`}
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className={chipClass}>{label}</span>
                  );
                })()}
              </Fragment>
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

// Streams the recap in as it's generated (only on the very first request for a
// given session — every request after that replays the cached text from
// Mongo, still through the same streaming response). If nothing ever arrives
// — no OLLAMA_API_KEY configured, no cached results for this session, or the
// call failed — this renders nothing rather than an error, matching the
// app's other empty states.
export default function SessionRecapCard({
  year,
  round,
  session = "race",
}: SessionRecapCardProps) {
  const [text, setText] = useState("");
  const [isStreaming, setIsStreaming] = useState(true);
  const reduce = useReducedMotion();

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setText("");
    setIsStreaming(true);

    (async () => {
      try {
        const res = await fetch(getSessionRecapUrl(year, round, session), {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          if (!cancelled) setIsStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk && !cancelled) setText((prev) => prev + chunk);
        }
      } catch {
        // Aborted on unmount, or a network failure — either way, no recap.
      } finally {
        if (!cancelled) setIsStreaming(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [year, round, session]);

  if (!isStreaming && !text) return null;

  // The race replay's lap timeline is built from the Race session only
  // (see race_replay.py) — a qualifying or sprint recap's `[RC L#]` laps
  // belong to a different session and don't correspond to it, so only the
  // race recap's citations get the link.
  const replayHref =
    session === "race"
      ? (lap: number) => `/schedule/${year}/${round}/pitwall?module=race-replay&lap=${lap}`
      : undefined;

  return (
    <div className="apex-glass-soft rounded-2xl p-[22px] mb-6">
      <div className="flex items-center gap-2 mb-3.5">
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
          {RECAP_LABEL[session]}
        </span>
        {isStreaming && (
          <span
            className={`w-1.5 h-1.5 rounded-full bg-flame ${reduce ? "" : "animate-pulse"}`}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="font-medium text-[15px] leading-[1.7] text-warm-200">
        {text ? (
          <ReactMarkdown
            components={{
              p: ({ children }) => (
                <p className="mb-3.5 last:mb-0">{decorateCitations(children, replayHref)}</p>
              ),
              strong: ({ children }) => (
                <strong className="font-bold text-on-background">{children}</strong>
              ),
              em: ({ children }) => <em className="italic">{children}</em>,
              // The recap is instructed not to emit links; if one slips
              // through, render its text rather than a navigable anchor.
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <span className="text-warm-400">{GENERATING_LABEL[session]}</span>
        )}
      </div>

      <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500 mt-4 pt-3.5 border-t border-white/[0.06]">
        Generated commentary · grounded in {session === "qualifying" ? "session" : "race"} results
        and FIA race control · citations reference the {session === "qualifying" ? "segment times" : "classification"} below
      </p>
    </div>
  );
}
