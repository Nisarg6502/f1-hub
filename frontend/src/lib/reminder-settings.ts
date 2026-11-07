import {
  CALENDAR_SESSION_TYPES,
  DEFAULT_SESSION_TYPES,
  type CalendarSessionType,
} from "./race-calendar";

/**
 * Email reminder settings: the shape, the allowed values and validation.
 * Split from `reminders.ts` (which needs `node:crypto`) so the account page's
 * client component can import the same constants.
 */

// --- Settings ---

/** Lead times offered, in minutes. */
export const LEAD_OPTIONS = [15, 30, 60, 180, 1440] as const;
export type LeadMinutes = (typeof LEAD_OPTIONS)[number];
export const DEFAULT_LEAD_MINUTES: LeadMinutes = 60;

export interface ReminderSettings {
  enabled: boolean;
  sessionTypes: CalendarSessionType[];
  leadMinutes: LeadMinutes;
  /** IANA zone from the browser, e.g. "Asia/Kolkata"; shown beside UTC. */
  timeZone?: string;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: false,
  sessionTypes: ["race", "qualifying", "sprint"],
  leadMinutes: DEFAULT_LEAD_MINUTES,
};

export function leadLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export type SettingsResult =
  | { ok: true; settings: ReminderSettings }
  | { ok: false; error: string };

/** Validate a PUT body. Strict: anything unexpected is refused, not coerced. */
export function validateReminderSettings(body: unknown): SettingsResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be an object" };
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["enabled", "sessionTypes", "leadMinutes", "timeZone"].includes(key)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }
  if (typeof input.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  if (
    !Array.isArray(input.sessionTypes) ||
    input.sessionTypes.some(
      (t) => typeof t !== "string" || !(CALENDAR_SESSION_TYPES as readonly string[]).includes(t)
    )
  ) {
    return { ok: false, error: `sessionTypes must be a list of: ${CALENDAR_SESSION_TYPES.join(", ")}` };
  }
  const sessionTypes = CALENDAR_SESSION_TYPES.filter((t) =>
    (input.sessionTypes as string[]).includes(t)
  );
  if (input.enabled && sessionTypes.length === 0) {
    return { ok: false, error: "Pick at least one session type" };
  }
  if (!(LEAD_OPTIONS as readonly unknown[]).includes(input.leadMinutes)) {
    return { ok: false, error: `leadMinutes must be one of ${LEAD_OPTIONS.join(", ")}` };
  }
  if (input.timeZone !== undefined && input.timeZone !== null && !isValidTimeZone(input.timeZone)) {
    return { ok: false, error: "timeZone is not a known IANA zone" };
  }
  return {
    ok: true,
    settings: {
      enabled: input.enabled,
      sessionTypes,
      leadMinutes: input.leadMinutes as LeadMinutes,
      ...(typeof input.timeZone === "string" ? { timeZone: input.timeZone } : {}),
    },
  };
}

/** A stored document → settings, tolerating old or partial documents. */
export function pickReminderSettings(doc: Record<string, unknown> | null | undefined): ReminderSettings {
  if (!doc) return { ...DEFAULT_REMINDER_SETTINGS };
  const types = Array.isArray(doc.sessionTypes)
    ? CALENDAR_SESSION_TYPES.filter((t) => (doc.sessionTypes as unknown[]).includes(t))
    : [...DEFAULT_SESSION_TYPES];
  const lead = (LEAD_OPTIONS as readonly unknown[]).includes(doc.leadMinutes)
    ? (doc.leadMinutes as LeadMinutes)
    : DEFAULT_LEAD_MINUTES;
  return {
    enabled: doc.enabled === true,
    sessionTypes: types,
    leadMinutes: lead,
    ...(isValidTimeZone(doc.timeZone) ? { timeZone: doc.timeZone } : {}),
  };
}
