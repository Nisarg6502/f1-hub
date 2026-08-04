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
  | "internal";

export interface AgentSource {
  id: string;
  label: string;
  url?: string | null;
  as_of?: string | null;
}

export interface AgentDone {
  run_id: string | null;
  /** `"echo"` means inference was unavailable and the text is NOT an answer. */
  mode: "model" | "echo";
  model: string;
  prompt_version: number;
  elapsed_ms: number;
}

export interface AgentHandlers {
  onActivity?: (label: string, state: "start" | "done") => void;
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
  const frames: string[] = [];
  let rest = buffer;
  let index = rest.indexOf("\n\n");
  while (index !== -1) {
    frames.push(rest.slice(0, index));
    rest = rest.slice(index + 2);
    index = rest.indexOf("\n\n");
  }
  return { frames, rest };
}

/** Parse one frame into an event name and payload, or null if it is a comment. */
export function parseFrame(
  frame: string
): { event: string; data: unknown } | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event: ")) event = line.slice(7);
    // Per the SSE spec multiple `data:` lines in one frame are joined with a
    // newline. The backend only ever emits one, but a client that assumes so
    // breaks silently the first time that stops being true.
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  }
  if (!event) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
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

function dispatch(event: string, data: unknown, handlers: AgentHandlers): void {
  const payload = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case "activity":
      handlers.onActivity?.(
        String(payload.label ?? ""),
        payload.state === "done" ? "done" : "start"
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
