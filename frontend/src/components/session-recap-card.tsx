"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { getSessionRecapUrl } from "@/lib/api";

interface SessionRecapCardProps {
  year: number;
  round: number;
}

// Streams the recap in as it's generated (only happens on the very first
// request for a given race — every request after that replays the cached
// text from the backend, still through this same streaming response). If
// nothing ever arrives — no OLLAMA_API_KEY configured, no cached race
// results yet, or the Ollama call failed — this renders nothing rather than
// an error or an empty card, same as every other "not available" state in
// this app.
export default function SessionRecapCard({ year, round }: SessionRecapCardProps) {
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
        const res = await fetch(getSessionRecapUrl(year, round), {
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
          if (chunk && !cancelled) {
            setText((prev) => prev + chunk);
          }
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
  }, [year, round]);

  if (!isStreaming && !text) {
    return null;
  }

  return (
    <div className="apex-glass-soft rounded-2xl p-[22px] mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-[#FF7A3D]">
          AI Recap
        </span>
        {isStreaming && (
          <span
            className={`w-1.5 h-1.5 rounded-full bg-[#FF7A3D] ${
              reduce ? "" : "animate-pulse"
            }`}
            aria-hidden="true"
          />
        )}
      </div>
      <p className="font-medium text-[15px] leading-relaxed text-warm-200 whitespace-pre-line">
        {text}
        {isStreaming && (
          <span
            className={`inline-block w-[7px] h-[15px] ml-0.5 -mb-[2px] bg-[#FFAE6A] ${
              reduce ? "" : "animate-pulse"
            }`}
            aria-hidden="true"
          />
        )}
      </p>
      <p className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500 mt-3">
        Generated commentary from race data · not official reporting
      </p>
    </div>
  );
}
