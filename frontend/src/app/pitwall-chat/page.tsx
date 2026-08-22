"use client";

/**
 * `/pitwall-chat` — the CP61 dev-flagged chat UI, superseded by CP66.
 *
 * The production Pitwall Assistant is now `pitwall-assistant-panel.tsx`, a
 * portaled slide-over reachable from the nav on every page
 * (`pitwall-assistant-launcher.tsx`). This route is kept, unlinked, as an
 * isolated debugging surface — a full-page view of the same event stream is
 * sometimes more useful than a 480px drawer when something is actually
 * broken, the same reason `/agent-check` (CP59) was kept alongside the real
 * UI rather than deleted once it had served its original purpose.
 *
 * Reuses `agent-api.ts` (CP59) as-is — it already parses the full event
 * vocabulary, including `sources`, which CP59's own UI never rendered
 * because there was nothing to cite yet. This page is the first thing that
 * does.
 */

import { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  streamChat,
  type AgentDone,
  type AgentSource,
} from "@/lib/agent-api";

type ActivityEntry = { label: string; state: "start" | "done" };

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

export default function PitwallChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  // Persisted for the life of the tab only — CP61's checkpointer gives real
  // Mongo-backed thread memory server-side; the client only needs to keep
  // sending the *same* id so consecutive turns land in the same thread.
  const threadId = useRef(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(() => {
    const question = input.trim();
    if (!question || running) return;
    setInput("");

    const userMessage: Message = {
      id: newId(),
      role: "user",
      text: question,
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
      question,
      {
        onActivity: (label, state) =>
          patch((m) => ({ ...m, activity: [...m.activity, { label, state }] })),
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
        patch((m) => ({ ...m, error: { code: "network", message: err.message } }));
      })
      .finally(() => setRunning(false));
  }, [input, running]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  return (
    <div className="mx-auto flex min-h-[80vh] max-w-3xl flex-col px-4 py-12">
      <h1 className="text-2xl font-semibold text-[var(--color-on-background)]">
        Pitwall Assistant
      </h1>
      <p className="mt-2 text-sm text-[var(--color-on-surface-variant)]">
        CP61 dev preview — the single-agent baseline, no subagents, no
        verifier yet. Not linked from navigation; the production panel lands
        in CP66.
      </p>

      <div className="mt-6 flex-1 space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-[var(--color-on-surface-variant)]">
            Try: &ldquo;Who won the last race?&rdquo;, &ldquo;How many
            podiums has Norris had this year?&rdquo;, or &ldquo;Who has the
            most wins at Monaco in history?&rdquo;
          </p>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>

      <div className="sticky bottom-4 mt-6 flex gap-2 rounded-xl border border-white/10 bg-surface-container/98 p-2">
        <input
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
          placeholder="Ask about a race, a driver, a season, or F1 history…"
        />
        <button
          onClick={running ? cancel : send}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50"
          disabled={!running && !input.trim()}
        >
          {running ? "Cancel" : "Ask"}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-2xl bg-[var(--color-primary)] px-4 py-2 text-sm text-[var(--color-on-primary)]">
          {message.text}
        </p>
      </div>
    );
  }

  const activeActivity = message.activity.filter(
    (entry, index) =>
      entry.state === "start" &&
      !message.activity
        .slice(index + 1)
        .some((later) => later.label === entry.label && later.state === "done")
  );

  return (
    <div className="flex flex-col gap-2">
      {activeActivity.length > 0 && (
        <ul className="space-y-1 text-xs text-[var(--color-warm-500)]">
          {activeActivity.map((entry, index) => (
            <li key={index}>{entry.label}…</li>
          ))}
        </ul>
      )}

      {message.error ? (
        <p className="max-w-[80%] rounded-2xl border border-[var(--color-error)]/40 bg-[var(--color-error-container)]/20 px-4 py-2 text-sm text-[var(--color-error)]">
          {message.error.message}
        </p>
      ) : (
        message.text && (
          <div className="max-w-[80%] rounded-2xl border border-white/10 bg-surface-container/98 px-4 py-3 text-sm leading-relaxed text-[var(--color-on-surface)] [&_p]:mb-2 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown>{message.text}</ReactMarkdown>
            {message.done?.mode === "echo" && (
              <p className="mt-2 text-xs text-[var(--color-error)]">
                Echo mode — inference is not configured, this is not a real
                answer.
              </p>
            )}
          </div>
        )
      )}

      {message.sources.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {message.sources.map((source) => (
            <li
              key={source.id}
              className="rounded-full border border-white/10 bg-[var(--color-surface-container-low)] px-2 py-1 text-[10px] text-[var(--color-on-surface-variant)]"
              title={source.as_of ?? undefined}
            >
              {source.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
