"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useReducedMotion } from "motion/react";
import { getStrategyCommentaryUrl } from "@/lib/api";

interface StrategyCommentaryCardProps {
  year: number;
  round: number;
}

// Streams the commentary in as it's generated (only on the very first request
// for a given race — every request after that replays the cached text from
// Mongo, still through the same streaming response). If nothing ever arrives
// — no OLLAMA_API_KEY configured, no cached race_stints/race_laps for this
// round, or the call failed — this renders nothing rather than an error,
// matching SessionRecapCard's empty behaviour. Simplified from that card: no
// citation decoration or replay-link machinery, since the strategy prompt
// doesn't emit `[P1]`-style markers — plain Markdown is enough here.
export default function StrategyCommentaryCard({ year, round }: StrategyCommentaryCardProps) {
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
        const res = await fetch(getStrategyCommentaryUrl(year, round), {
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
        // Aborted on unmount, or a network failure — either way, no commentary.
      } finally {
        if (!cancelled) setIsStreaming(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [year, round]);

  if (!isStreaming && !text) return null;

  return (
    <div className="apex-glass-soft rounded-2xl p-[22px] mb-6">
      <div className="flex items-center gap-2 mb-3.5">
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-[#FF7A3D]">
          AI Strategy Commentary
        </span>
        {isStreaming && (
          <span
            className={`w-1.5 h-1.5 rounded-full bg-[#FF7A3D] ${reduce ? "" : "animate-pulse"}`}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="font-medium text-[15px] leading-[1.7] text-warm-200">
        {text ? (
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="mb-3.5 last:mb-0">{children}</p>,
              strong: ({ children }) => (
                <strong className="font-bold text-on-background">{children}</strong>
              ),
              em: ({ children }) => <em className="italic">{children}</em>,
              // The commentary is instructed not to emit links; if one slips
              // through, render its text rather than a navigable anchor.
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <span className="text-warm-400">Generating strategy commentary…</span>
        )}
      </div>

      <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500 mt-4 pt-3.5 border-t border-white/[0.06]">
        Generated commentary · grounded in tyre stint and pit-stop data
      </p>
    </div>
  );
}
