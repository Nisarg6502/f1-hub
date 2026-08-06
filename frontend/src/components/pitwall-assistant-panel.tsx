"use client";

/**
 * The production Pitwall Assistant panel — CP66.
 *
 * A portaled right-side drawer, reachable from anywhere in the app via the
 * nav trigger (`pitwall-assistant-launcher.tsx`), replacing `/pitwall-chat`
 * (CP61's unlinked dev preview, kept around for isolated debugging but no
 * longer the intended way to use the assistant). Follows this app's
 * established portal pattern (`driver-modal.tsx`, `circuit-details-modal.tsx`,
 * `circuit-compare-modal.tsx`): `<main>` in `layout.tsx` has `relative z-10`,
 * which creates a stacking context, so any descendant's z-index compares
 * against the nav's `z-50` rather than the page root — every overlay in this
 * app portals to `document.body` for exactly this reason, and this one is no
 * exception.
 *
 * Two things this panel does that the CP61 dev page did not:
 * - **A full activity timeline**, not just the in-progress entries. The dev
 *   page filtered to only currently-active steps; this renders every step in
 *   order, which is what makes CP63's subagent delegation and CP64's
 *   verification pass actually visible rather than flickering past.
 * - **Renders the `tier`/`verification` fields** `done` now carries, as a
 *   small, unobtrusive badge — not because a user needs to know what a "tier"
 *   is, but because a `verification_failed` badge is a plain, honest signal
 *   that this specific answer could not be fully checked, which is more
 *   useful than hiding it and identical in spirit to the `mode === "echo"`
 *   warning the dev page already showed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { motion, useReducedMotion } from "motion/react";
import {
  streamChat,
  rewriteCitations,
  type AgentDone,
  type AgentSource,
} from "@/lib/agent-api";
import CitationPill from "./citation-pill";
import SourceCard from "./source-card";

type ActivityEntry = {
  label: string;
  state: "start" | "done";
  detail?: string | null;
  kind: "tool" | "agent" | "system";
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity: ActivityEntry[];
  sources: AgentSource[];
  done: AgentDone | null;
  error: { code: string; message: string } | null;
};

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `m${nextId}`;
}

const SUGGESTIONS = [
  "Who won the last race?",
  "Compare Verstappen and Norris this season",
  "Who has the most wins at Monaco in F1 history?",
];

export default function PitwallAssistantPanel({
  onClose,
}: {
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  // Persisted for the life of this mount only — the backend checkpointer
  // gives real Mongo-backed thread memory server-side; the client only needs
  // to keep sending the same id so consecutive turns land in the same
  // thread. Regenerated each time the panel opens fresh (a new mount), so
  // closing and reopening starts a new conversation rather than an
  // indefinitely-growing one.
  const threadId = useRef(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = "auto";
      window.removeEventListener("keydown", handleKeyDown);
      // A closed panel must not keep burning quota for a question nobody
      // is watching anymore — the same reasoning `agent-api.ts`'s own
      // docstring gives for supporting `signal` at all.
      abortRef.current?.abort();
    };
  }, [onClose]);

  const ask = useCallback(
    (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || running) return;
      setInput("");

      const userMessage: Message = {
        id: newId(),
        role: "user",
        text: trimmed,
        activity: [],
        sources: [],
        done: null,
        error: null,
      };
      const assistantId = newId();
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        text: "",
        activity: [],
        sources: [],
        done: null,
        error: null,
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setRunning(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (fn: (m: Message) => Message) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? fn(m) : m))
        );

      streamChat(
        trimmed,
        {
          onActivity: (label, state, detail, kind) =>
            patch((m) => ({
              ...m,
              activity: [...m.activity, { label, state, detail, kind: kind ?? "system" }],
            })),
          onToken: (text) => patch((m) => ({ ...m, text: m.text + text })),
          onSources: (sources) => patch((m) => ({ ...m, sources })),
          onDone: (done) => patch((m) => ({ ...m, done })),
          onError: (code, message) =>
            patch((m) => ({ ...m, error: { code, message } })),
        },
        { threadId: threadId.current, signal: controller.signal }
      )
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          patch((m) => ({
            ...m,
            error: { code: "network", message: err.message },
          }));
        })
        .finally(() => setRunning(false));
    },
    [running]
  );

  const send = useCallback(() => ask(input), [ask, input]);
  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return createPortal(
    <motion.div
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[80] bg-[rgba(6,5,4,0.65)] backdrop-blur-[8px]"
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? { opacity: 0 } : { opacity: 0, x: "100%" }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, x: "100%" }}
        transition={
          reduce
            ? { duration: 0.15 }
            : { type: "spring", stiffness: 340, damping: 34 }
        }
        role="dialog"
        aria-modal="true"
        aria-label="Pitwall Assistant"
        className="absolute right-0 top-0 flex h-full w-full max-w-[480px] flex-col apex-glass-strong apex-sheen border-l border-white/10"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2 className="font-[family-name:var(--font-headline)] text-[15px] font-bold text-[var(--color-on-background)]">
              Pitwall Assistant
            </h2>
            <p className="text-[11px] text-[var(--color-on-surface-variant)]">
              Answers from this app&rsquo;s own F1 data, cited as it goes.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(16,14,11,0.5)] text-lg text-warm-200 transition-[background-color,transform] duration-150 hover:bg-[rgba(16,14,11,0.7)] active:scale-90"
          >
            ×
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-on-surface-variant)]">
                Ask about a race, a driver, a season, or F1 history.
              </p>
              <div className="flex flex-col gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => ask(suggestion)}
                    className="rounded-lg border border-white/10 bg-[var(--color-surface-container-low)] px-3 py-2 text-left text-xs text-[var(--color-on-surface-variant)] transition-colors duration-150 hover:border-white/20 hover:text-[var(--color-on-surface)]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>

        <div className="flex gap-2 border-t border-white/10 p-3">
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            disabled={running}
            className="flex-1 rounded-lg bg-transparent px-3 py-2 text-sm text-[var(--color-on-surface)] outline-none placeholder:text-[var(--color-on-surface-variant)]"
            placeholder="Ask about a race, a driver, a season…"
          />
          <button
            onClick={running ? cancel : send}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-[var(--color-on-primary)] transition-transform duration-150 active:scale-[0.97] disabled:opacity-50"
            disabled={!running && !input.trim()}
          >
            {running ? "Cancel" : "Ask"}
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl bg-[var(--color-primary)] px-4 py-2 text-sm text-[var(--color-on-primary)]">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message.activity.length > 0 && (
        <ActivityTimeline activity={message.activity} />
      )}

      {message.error ? (
        <p className="max-w-[85%] rounded-2xl border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/20 px-4 py-2 text-sm text-[var(--color-error)]">
          {message.error.message}
        </p>
      ) : (
        message.text && (
          <div className="max-w-[85%] rounded-2xl border border-white/10 bg-[rgba(26,22,19,0.98)] px-4 py-3 text-sm leading-relaxed text-[var(--color-on-surface)] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown components={{ a: CitationPill }}>
              {rewriteCitations(message.text)}
            </ReactMarkdown>
            <StatusFooter done={message.done} />
          </div>
        )
      )}

      {message.sources.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {message.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A completed step's marker, encoded redundantly by shape + color + size (not
 * size alone — at 10-11px text a 0.5px size delta doesn't reliably read) so
 * "agent" (a subagent delegation), "tool" (a single tool call) and "system"
 * (housekeeping) stay distinguishable without relying on color perception
 * alone: agent is a small rounded square in the secondary color, tool is the
 * plain round dot this timeline already used, system is the same dot dimmed
 * down so routine housekeeping recedes instead of competing for attention.
 */
function ActivityMarker({ kind }: { kind: ActivityEntry["kind"] }) {
  if (kind === "agent") {
    return <span className="h-1.5 w-1.5 rounded-[2px] bg-[var(--color-secondary)]" />;
  }
  if (kind === "system") {
    return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]/40" />;
  }
  return <span className="h-1 w-1 rounded-full bg-[var(--color-warm-500)]" />;
}

/**
 * Every step the assistant took, in order — not just the ones still
 * in-flight. `key` includes the index because the same label can legitimately
 * appear twice (a repaired draft re-running a step), and React needs a
 * stable-but-distinct key per occurrence, not per label.
 */
function ActivityTimeline({ activity }: { activity: ActivityEntry[] }) {
  return (
    <ul className="space-y-1 text-xs text-[var(--color-warm-500)]">
      {activity
        .filter((entry) => entry.state === "done")
        .map((entry, index) => (
          <li key={`${entry.label}-${index}`} className="flex items-center gap-1.5">
            <ActivityMarker kind={entry.kind} />
            {entry.label}
            {entry.detail && (
              <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
            )}
          </li>
        ))}
      {activity
        .filter(
          (entry, index) =>
            entry.state === "start" &&
            !activity
              .slice(index + 1)
              .some((later) => later.label === entry.label && later.state === "done")
        )
        .map((entry, index) => (
          <li key={`active-${entry.label}-${index}`} className="flex items-center gap-1.5">
            <span className="h-1 w-1 animate-pulse rounded-full bg-[var(--color-primary)]" />
            {entry.label}…
            {entry.detail && (
              <span className="text-[var(--color-on-surface-variant)]"> — {entry.detail}</span>
            )}
          </li>
        ))}
    </ul>
  );
}

/** The `mode`/`tier`/`verification` badges — plain, honest, unobtrusive. */
function StatusFooter({ done }: { done: AgentDone | null }) {
  if (!done) return null;
  if (done.mode === "echo") {
    return (
      <p className="mt-2 text-xs text-[var(--color-error)]">
        Echo mode — inference is not configured, this is not a real answer.
      </p>
    );
  }
  if (done.verification !== "verification_failed") return null;
  return (
    <p className="mt-2 text-xs text-[var(--color-on-surface-variant)]">
      Some details in this answer could not be fully verified against
      retrieved data.
    </p>
  );
}
