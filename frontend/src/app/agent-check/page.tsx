"use client";

/**
 * `/agent-check` — the production smoke test for the `f1-agent` service (CP59).
 *
 * This is deliberately NOT the Pitwall Assistant UI. That arrives in CP61/CP66
 * as a portaled slide-over panel. This page exists because
 * `CHAT-AGENT-PLAN.md`'s failure mode #15 — "all checkpoints merged" is not
 * "the feature works" — asks for a smoke test that drives the real endpoint on
 * the real site, and Batch 16 proved the point by costing seven follow-up PRs
 * for faults that only ever appeared in production.
 *
 * So it shows the raw event stream rather than a polished answer: which
 * activity events arrived, in what order, whether tokens streamed
 * incrementally or landed in one blob, and exactly what `done` reported. Those
 * are the things that break between two individually-correct systems.
 *
 * It is kept, not deleted, so the next deploy can be checked the same way.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAgentHealth,
  streamChat,
  type AgentDone,
  type AgentHealth,
} from "@/lib/agent-api";

type LogEntry = { at: number; kind: string; detail: string };

export default function AgentCheckPage() {
  const [question, setQuestion] = useState("Say hello in one short sentence.");
  const [answer, setAnswer] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [done, setDone] = useState<AgentDone | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null
  );
  const [running, setRunning] = useState(false);
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const startedAt = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Counts how many separate onToken callbacks fired. One means the response
  // was buffered somewhere in the chain — the single most likely production
  // failure for this feature, and invisible in a finished answer.
  const tokenCount = useRef(0);

  const note = useCallback((kind: string, detail: string) => {
    setLog((entries) => [
      ...entries,
      { at: Math.round(performance.now() - startedAt.current), kind, detail },
    ]);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getAgentHealth(controller.signal)
      .then(setHealth)
      .catch((err: Error) => {
        if (err.name !== "AbortError") setHealthError(err.message);
      });
    return () => controller.abort();
  }, []);

  const run = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    startedAt.current = performance.now();
    tokenCount.current = 0;
    setAnswer("");
    setLog([]);
    setDone(null);
    setError(null);
    setRunning(true);

    streamChat(
      question,
      {
        onActivity: (label, state) => note(`activity:${state}`, label),
        onToken: (text) => {
          tokenCount.current += 1;
          setAnswer((prev) => prev + text);
        },
        onSources: (sources) =>
          note("sources", `${sources.length} source(s)`),
        onDone: (payload) => {
          setDone(payload);
          note(
            "done",
            `mode=${payload.mode} model=${payload.model} ${payload.elapsed_ms}ms ` +
              `run_id=${payload.run_id ?? "none"}`
          );
        },
        onError: (code, message) => {
          setError({ code, message });
          note(`error:${code}`, message);
        },
      },
      { signal: controller.signal }
    )
      .catch((err: Error) => {
        if (err.name === "AbortError") {
          note("aborted", "cancelled by the user");
          return;
        }
        setError({ code: "network", message: err.message });
        note("network", err.message);
      })
      .finally(() => setRunning(false));
  }, [question, note]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-semibold text-[var(--color-on-background)]">
        Agent service check
      </h1>
      <p className="mt-2 text-sm text-[var(--color-on-surface-variant)]">
        Drives <code>POST /api/chat</code> on the deployed{" "}
        <code>f1-agent</code> service and shows the raw event stream. Not the
        Pitwall Assistant — that lands in CP61.
      </p>

      <section className="mt-6 rounded-xl border border-white/10 bg-[rgba(26,22,19,0.98)] p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
          Health
        </h2>
        {healthError ? (
          <p className="mt-2 text-sm text-[var(--color-error)]">
            Unreachable: {healthError}
          </p>
        ) : health ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <Fact label="model" value={health.model} />
            <Fact
              label="inference"
              value={health.inference_configured ? "configured" : "missing key"}
            />
            <Fact
              label="langsmith"
              value={health.langsmith_tracing ? "tracing" : "off"}
            />
            <Fact
              label="runs"
              value={`${health.runs.running}/${health.runs.limit} · ${health.runs.waiting} waiting`}
            />
            <Fact label="prompt" value={`v${health.prompt_version}`} />
          </dl>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-on-surface-variant)]">
            Checking…
          </p>
        )}
      </section>

      <div className="mt-6 flex gap-2">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !running) run();
          }}
          className="flex-1 rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-3 py-2 text-sm text-[var(--color-on-surface)] outline-none focus:border-[var(--color-primary)]"
          placeholder="Ask the agent something"
        />
        <button
          onClick={running ? cancel : run}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-[var(--color-on-primary)]"
        >
          {running ? "Cancel" : "Send"}
        </button>
      </div>

      {answer && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
            Answer{" "}
            {done?.mode === "echo" && (
              <span className="text-[var(--color-error)]">
                — echo mode, not a real answer
              </span>
            )}
          </h2>
          <p className="mt-2 whitespace-pre-wrap rounded-xl border border-white/10 bg-[rgba(26,22,19,0.98)] p-4 text-sm text-[var(--color-on-surface)]">
            {answer}
          </p>
        </section>
      )}

      {error && (
        <p className="mt-4 rounded-lg border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/20 p-3 text-sm text-[var(--color-error)]">
          <strong>{error.code}</strong> — {error.message}
        </p>
      )}

      {log.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-on-surface-variant)]">
            Event stream
          </h2>
          <ol className="mt-2 space-y-1 font-mono text-xs text-[var(--color-on-surface-variant)]">
            {log.map((entry, index) => (
              <li key={index}>
                <span className="text-[var(--color-warm-500)]">
                  {String(entry.at).padStart(5, " ")}ms
                </span>{" "}
                <span className="text-[var(--color-primary)]">{entry.kind}</span>{" "}
                {entry.detail}
              </li>
            ))}
          </ol>
          {done && (
            <p className="mt-3 text-xs text-[var(--color-on-surface-variant)]">
              Streamed in <strong>{tokenCount.current}</strong> token event(s).{" "}
              {tokenCount.current <= 1
                ? "One event means the response was buffered somewhere — streaming is not actually working."
                : "More than one means tokens arrived incrementally."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--color-warm-500)]">
        {label}
      </dt>
      <dd className="text-[var(--color-on-surface)]">{value}</dd>
    </div>
  );
}
