/**
 * Human copy for the ways sign-in can fail.
 *
 * Better Auth reports a failed magic link by redirecting to the sign-in page
 * with `?error=<CODE>`, and a failed OAuth round trip the same way. Those
 * codes are machine vocabulary (`INVALID_TOKEN`, `EXPIRED_TOKEN`,
 * `state_mismatch`) and showing them raw tells a visitor nothing about what
 * to do next. Every message here answers that question.
 *
 * On honesty: the library deletes a magic-link token the moment it is used,
 * so a second click on the same link and a link that never existed are the
 * same thing to the server — both arrive as `INVALID_TOKEN`. The copy says
 * "already used or not valid" for that reason rather than claiming to know
 * which. An expired link IS distinguishable (the record is still there, past
 * its expiry) and gets its own message.
 */

export interface AuthErrorCopy {
  title: string;
  body: string;
}

const COPY: Record<string, AuthErrorCopy> = {
  EXPIRED_TOKEN: {
    title: "That sign-in link has expired",
    body: "Links last a few minutes for safety. Enter your email again and we'll send a fresh one.",
  },
  INVALID_TOKEN: {
    title: "That sign-in link has already been used",
    body: "Each link works once, so a link that has been opened before — or one that was copied incompletely — can't sign you in. Request a new one below.",
  },
  ATTEMPTS_EXCEEDED: {
    title: "That sign-in link has already been used",
    body: "Each link works once. Request a new one below.",
  },
  failed_to_create_user: {
    title: "We couldn't create your account",
    body: "Something went wrong on our side. Please try again in a moment.",
  },
  new_user_signup_disabled: {
    title: "New accounts are paused",
    body: "Sign-ups are switched off right now. Existing accounts can still sign in.",
  },
  access_denied: {
    title: "Google sign-in was cancelled",
    body: "Nothing was shared. You can try again, or use an email link instead.",
  },
  state_mismatch: {
    title: "Google sign-in didn't complete",
    body: "The sign-in took too long or was started in another tab. Please try again.",
  },
  please_restart_the_process: {
    title: "Google sign-in didn't complete",
    body: "The sign-in took too long or was started in another tab. Please try again.",
  },
  account_already_linked_to_different_user: {
    title: "That Google account belongs to another APEX account",
    body: "Sign out, then sign in with that Google account to use it — or link a different Google account.",
  },
  "email_doesn't_match": {
    title: "That Google account uses a different email",
    body: "To link Google, choose the Google account with the same email address as this APEX account.",
  },
  unable_to_link_account: {
    title: "Google couldn't be linked",
    body: "Please try again. If it keeps happening, sign in with Google directly instead.",
  },
};

const FALLBACK: AuthErrorCopy = {
  title: "Sign-in didn't complete",
  body: "Something went wrong. Please try again.",
};

/** `null` when there is no error to show. */
export function describeAuthError(code: string | null | undefined): AuthErrorCopy | null {
  if (!code) return null;
  return COPY[code] ?? COPY[code.toUpperCase()] ?? COPY[code.toLowerCase()] ?? FALLBACK;
}
