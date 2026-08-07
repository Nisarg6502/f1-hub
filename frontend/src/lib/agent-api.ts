/**
 * Client for the `f1-agent` chat service (CP59).
 *
 * The service streams Server-Sent Events from `POST /api/chat`. The event
 * vocabulary is defined and tested on the backend in `backend/agent/sse.py` —
 * that module is the contract, and the types here mirror it. Any change there
 * has to land here too.
 *
 * `EventSource` is deliberately not used. It only speaks GET, and it silently
 * reconnects on any drop — which for an agent turn would re-run the whole
 * thing and charge a quota we are already rationing. So this reads the
 * response body with a stream reader and parses SSE frames by hand.
 */

const AGENT_BASE_URL =
  process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "http://localhost:8100";

/** Closed set, mirroring `sse.ERROR_CODES`. The UI styles on these. */
export type AgentErrorCode =
  | "at_capacity"
  | "timeout"
  | "upstream"
  | "bad_request"
  | "refused"
  | "internal";

/**
 * A client-only code (CP70) for the pre-connection network-catch path — not
 * part of the backend's `ERROR_CODES` contract, so kept as a separate union
 * rather than folded into `AgentErrorCode` above.
 */
export type ClientErrorCode = "network";

/**
 * Human-readable copy for error codes that don't already carry a good
 * user-facing message of their own (CP70). `refused` is deliberately left
 * out: CP67's guardrails already attach a real, specific refusal message to
 * that code (e.g. "I can't help with that"), and clobbering it with generic
 * copy here would be a regression, not a fix. Any code missing from this map
 * — including `refused` — should fall back to the message the backend/SSE
 * layer actually sent rather than a canned string.
 */
export const ERROR_COPY: Partial<Record<AgentErrorCode | ClientErrorCode, string>> = {
  at_capacity: "The assistant is busy right now — try again in a moment.",
  timeout: "That took too long to answer. Try again, or ask something more specific.",
  upstream: "Something went wrong reaching the model. Try again shortly.",
  bad_request: "That request couldn't be processed — try rephrasing your question.",
  internal: "Something went wrong on our end. Try again.",
  network: "Couldn't reach the assistant — check your connection and try again.",
};

/**
 * One `{label, value}` pair of the inspectable evidence a citation rests on
 * (CP71 Task 1, `backend/agent/ledger.py::Evidence._snippet`). Capped at 6
 * pairs with values truncated to ~120 chars, so this is safe to ship on every
 * `sources` frame. An EMPTY list is a normal outcome — the backend builder has
 * a catch-all returning `[]` — not an error state.
 */
export interface AgentSnippetPair {
  label: string;
  value: string;
}

export interface AgentSource {
  id: string;
  n: number;
  kind: "data" | "web" | "wikipedia";
  label: string;
  title: string;
  url?: string | null;
  as_of?: string | null;
  /** Optional: an older agent build may not send it at all. */
  snippet?: AgentSnippetPair[] | null;
}

export interface AgentDone {
  run_id: string | null;
  /** `"echo"` means inference was unavailable and the text is NOT an answer. */
  mode: "model" | "echo";
  model: string;
  prompt_version: number;
  /** CP63: the router's tier decision. `null` for the echo fallback. */
  tier: number | null;
  /**
   * CP64: `null` for tier 1 (verification is skipped there by design) and
   * for the echo fallback — only a real tier 2/3 answer carries a value.
   */
  verification: "passed" | "verification_failed" | null;
  elapsed_ms: number;
}

export interface AgentHandlers {
  onActivity?: (
    label: string,
    state: "start" | "done",
    detail?: string | null,
    kind?: "tool" | "agent" | "system"
  ) => void;
  onToken?: (text: string) => void;
  onSources?: (sources: AgentSource[]) => void;
  onDone?: (done: AgentDone) => void;
  onError?: (code: AgentErrorCode, message: string) => void;
}

export interface AgentHealth {
  status: string;
  service: string;
  model: string;
  inference_configured: boolean;
  langsmith_tracing: boolean;
  prompt_version: number;
  runs: { running: number; waiting: number; limit: number };
}

export async function getAgentHealth(
  signal?: AbortSignal
): Promise<AgentHealth> {
  const res = await fetch(new URL("/health", AGENT_BASE_URL).toString(), {
    cache: "no-store",
    signal,
  });
  if (!res.ok) throw new Error(`agent health ${res.status}`);
  return (await res.json()) as AgentHealth;
}

/**
 * Split a buffer into complete SSE frames, returning the unconsumed remainder.
 *
 * Exported for tests. The remainder matters: a chunk boundary lands in the
 * middle of a frame constantly, and treating a partial frame as complete is
 * how a streaming client drops or mangles tokens.
 */
export function splitFrames(buffer: string): {
  frames: string[];
  rest: string;
} {
  // The SSE spec terminates lines with CRLF, CR *or* LF, and intermediaries
  // rewrite line endings — which is the whole reason this module hand-rolls a
  // parser instead of using EventSource. An LF-only split against a CRLF
  // stream finds no frames at all, so the buffer grows without bound and
  // `streamChat` resolves having called no handler: no answer, no error, and
  // indistinguishable from success to the caller.
  //
  // A trailing "\r" is ambiguous: it may be a complete CR line terminator, or
  // the first half of a "\r\n" straddling a chunk boundary. Normalising it
  // eagerly would turn a single mid-frame CRLF into a "\n\n" frame break and
  // split a frame down the middle.
  //
  // It is only ambiguous, though, when a line is actually open. If the
  // character before it is itself a newline, the preceding line already
  // ended, so this "\r" is the blank line that terminates the frame and must
  // NOT be held back — holding it swallowed the second "\r" of a "\r\r"
  // terminator and lost the final frame of every CR-terminated stream.
  let pending = "";
  let working = buffer;
  if (working.endsWith("\r") && !/[\r\n]\r$/.test(working)) {
    pending = "\r";
    working = working.slice(0, -1);
  }

  const normalised = working.replace(/\r\n|\r/g, "\n");
  const parts = normalised.split("\n\n");
  const rest = (parts.pop() ?? "") + pending;
  return { frames: parts.filter((frame) => frame.length > 0), rest };
}

/** Parse one frame into an event name and payload, or null if it is a comment. */
export function parseFrame(
  frame: string
): { event: string; data: unknown } | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r\n|\r|\n/)) {
    if (raw.startsWith(":")) continue;
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const field = raw.slice(0, colon);
    // The space after the colon is optional in the spec — only one leading
    // space is stripped. Slicing a fixed "event: " length instead drops a
    // real character from any server that omits it.
    let value = raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    // Per the SSE spec multiple `data:` lines in one frame are joined with a
    // newline. The backend only ever emits one, but a client that assumes so
    // breaks silently the first time that stops being true.
    else if (field === "data") dataLines.push(value);
  }
  if (!event) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/**
 * Turn a complete `[ev_N]` citation marker into a markdown link
 * `[N](#cite-<messageId>-ev_N)`, which `react-markdown`'s existing link
 * rendering (via a `components.a` override, see `CitationPill`) turns into a
 * numbered pill.
 *
 * **Why the message id is in there (CP71).** Every turn builds a fresh
 * `EvidenceLedger` starting at `ev_1`, so `ev_1` is the first source of *every*
 * answer. The previous `#cite-ev_N` href — and the matching `id="source-ev_N"`
 * on the card — put per-message ids into a document-global namespace: with
 * three answers on screen, three elements shared `id="source-ev_1"` and
 * `getElementById` returned the *first in document order*, i.e. the oldest
 * answer. That was the reported "clicking a citation scrolls up to a previous
 * answer". Prefixing with the message id gives each answer its own namespace.
 *
 * Deliberately a plain string rewrite rather than a custom remark plugin —
 * `react-markdown` already parses markdown links correctly, so reusing that
 * avoids a new AST-visiting dependency for something a regex already solves.
 * The regex's own requirement of a closing `]` is what makes this
 * streaming-safe: a partial marker at a chunk boundary (`"...[ev_"`) simply
 * does not match yet and passes through as literal text, unmodified, until
 * the closing bracket arrives in a later chunk.
 */
export function rewriteCitations(text: string, messageId: string): string {
  return text.replace(/\[ev_(\d+)\]/g, `[$1](#cite-${messageId}-ev_$1)`);
}

/**
 * Inverse of {@link rewriteCitations}' href shape.
 *
 * The message-id segment is matched greedily and the evidence segment is
 * anchored to the end, so this survives *any* message id that does not itself
 * end in `-ev_<digits>` — including uuids, which are full of hyphens. A naive
 * `split("-")` would break on the first uuid.
 *
 * Returns `null` for an ordinary markdown link, which is what keeps
 * `CitationPill`'s non-citation fallback branch working.
 */
export function parseCitationHref(
  href: string | undefined
): { messageId: string; evidenceId: string } | null {
  const match = href?.match(/^#cite-(.+)-(ev_\d+)$/);
  if (!match) return null;
  return { messageId: match[1], evidenceId: match[2] };
}

/** The DOM id a `SourceCard` renders and a `CitationPill` resolves. */
export function citationAnchorId(messageId: string, evidenceId: string): string {
  return `source-${messageId}-${evidenceId}`;
}

/**
 * Send a question and dispatch stream events to `handlers`.
 *
 * Resolves when the stream ends. Never throws for a *service* failure — those
 * arrive as `onError`, because by the time anything goes wrong the response is
 * already committed with status 200. It does throw if the request could not be
 * made at all (network down, CORS refused), which is a genuinely different
 * situation and should not be dressed up as an agent error.
 *
 * Pass `signal` to cancel; aborting stops the LangGraph run server-side rather
 * than leaving it burning quota for a closed tab.
 */
export async function streamChat(
  message: string,
  handlers: AgentHandlers,
  options: { threadId?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const res = await fetch(new URL("/api/chat", AGENT_BASE_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, thread_id: options.threadId ?? null }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    // Release the socket rather than leaving an unread body pinned open.
    await res.body?.cancel().catch(() => {});
    handlers.onError?.(
      "upstream",
      `The assistant is unreachable (HTTP ${res.status}).`
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across a chunk
      // boundary from decoding into a replacement character — routine with
      // driver names like Räikkönen.
      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = splitFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        dispatch(parsed.event, parsed.data, handlers);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Record a thumbs up/down on a completed answer (CP69).
 *
 * Fire-and-forget, mirroring `streamChat`'s fetch setup minus the SSE
 * reader — a feedback POST is a single request/response, not a stream. The
 * backend's own contract (`POST /api/feedback`) is fail-soft: it always
 * returns 200 with `{"recorded": bool}`, never a hard error, so there is
 * nothing useful to surface to the user even on failure. Network errors are
 * swallowed here for the same reason — a dropped vote is telemetry loss,
 * not a user-visible error.
 *
 * Callers must not invoke this with a falsy `runId` — the backend's
 * `FeedbackRequest.run_id` is a required, non-optional field and rejects a
 * missing/null value with a 422. The caller (`FeedbackControls`) enforces
 * this by simply not rendering when there's no run id to attach a vote to.
 */
export async function postFeedback(
  runId: string,
  score: 1 | -1,
  comment?: string
): Promise<void> {
  try {
    await fetch(new URL("/api/feedback", AGENT_BASE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, score, comment: comment ?? null }),
    });
  } catch {
    // Fire-and-forget telemetry — a failed vote is not a user-visible error.
  }
}

function dispatch(event: string, data: unknown, handlers: AgentHandlers): void {
  const payload = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "activity":
      handlers.onActivity?.(
        String(payload.label ?? ""),
        payload.state === "done" ? "done" : "start",
        payload.detail == null ? null : String(payload.detail),
        (payload.kind as "tool" | "agent" | "system" | undefined) ?? "system"
      );
      break;
    case "token":
      handlers.onToken?.(String(payload.text ?? ""));
      break;
    case "sources":
      handlers.onSources?.((payload.sources ?? []) as AgentSource[]);
      break;
    case "done":
      handlers.onDone?.(payload as unknown as AgentDone);
      break;
    case "error":
      handlers.onError?.(
        (payload.code ?? "internal") as AgentErrorCode,
        String(payload.message ?? "Something went wrong.")
      );
      break;
    default:
      // An unknown event is forward compatibility, not an error: a newer
      // service may emit events this build predates.
      break;
  }
}
