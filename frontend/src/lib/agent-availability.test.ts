import { describe, expect, it } from "vitest";
import { assistantAvailability, type AgentHealth } from "./agent-api";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function health(capacity?: AgentHealth["capacity"]): AgentHealth {
  return {
    status: "ok",
    service: "f1-agent",
    model: "m",
    inference_configured: true,
    langsmith_tracing: false,
    prompt_version: 1,
    runs: { running: 0, waiting: 0, limit: 1 },
    capacity,
  };
}

describe("assistantAvailability", () => {
  it("is available when the health check failed", () => {
    expect(assistantAvailability(null, NOW)).toEqual({ available: true, retryAt: null });
  });

  it("is available when the agent predates the capacity field", () => {
    expect(assistantAvailability(health(undefined), NOW)).toEqual({ available: true, retryAt: null });
  });

  it("is available when the agent says it is", () => {
    expect(assistantAvailability(health({ available: true, retry_at: null }), NOW)).toEqual({
      available: true,
      retryAt: null,
    });
  });

  it("reports when to come back while resting", () => {
    const result = assistantAvailability(
      health({ available: false, retry_at: "2026-11-19T12:15:00Z" }),
      NOW
    );

    expect(result.available).toBe(false);
    expect(result.retryAt?.toISOString()).toBe("2026-11-19T12:15:00.000Z");
  });

  it("is available again once the retry time has passed", () => {
    expect(
      assistantAvailability(health({ available: false, retry_at: "2026-11-19T11:59:00Z" }), NOW)
    ).toEqual({ available: true, retryAt: null });
  });

  it("is available when the retry time is unparseable", () => {
    expect(
      assistantAvailability(health({ available: false, retry_at: "nonsense" }), NOW)
    ).toEqual({ available: true, retryAt: null });
  });

  it("rests with no stated time when the agent gives none", () => {
    expect(assistantAvailability(health({ available: false, retry_at: null }), NOW)).toEqual({
      available: false,
      retryAt: null,
    });
  });
});
