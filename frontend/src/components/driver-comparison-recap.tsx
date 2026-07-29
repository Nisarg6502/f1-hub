"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useReducedMotion } from "motion/react";
import { getDriverComparisonRecapUrl } from "@/lib/api";

interface DriverComparisonRecapProps {
  year: number;
  driver1: string;
  driver2: string;
}

// Streams the head-to-head narrative in as it's generated (only on the first
// request for a given season/driver-pair/rounds-compared combination -- see
// backend/app/driver_comparison_recap.py's cache key -- every request after
// that replays the cached text, still through the same streaming response).
// If nothing ever arrives -- no OLLAMA_API_KEY configured, no shared rounds
// yet, or the call failed -- this renders nothing rather than an error,
// matching session-recap-card.tsx's convention.
export default function DriverComparisonRecap({
  year,
  driver1,
  driver2,
}: DriverComparisonRecapProps) {
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
        const res = await fetch(getDriverComparisonRecapUrl(year, driver1, driver2), {
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
        // Aborted on unmount, or a network failure -- either way, no narrative.
      } finally {
        if (!cancelled) setIsStreaming(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [year, driver1, driver2]);

  if (!isStreaming && !text) return null;

  return (
    <div className="bg-[rgba(245,235,222,0.05)] rounded-xl px-4 py-3.5">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500">
          AI Head-to-head
        </span>
        {isStreaming && (
          <span
            className={`w-1.5 h-1.5 rounded-full bg-[#FF7A3D] ${reduce ? "" : "animate-pulse"}`}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="font-medium text-[13px] leading-[1.65] text-warm-200">
        {text ? (
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="mb-2.5 last:mb-0">{children}</p>,
              strong: ({ children }) => (
                <strong className="font-bold text-on-background">{children}</strong>
              ),
              em: ({ children }) => <em className="italic">{children}</em>,
              a: ({ children }) => <span>{children}</span>,
            }}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <span className="text-warm-400">Generating comparison…</span>
        )}
      </div>
    </div>
  );
}
