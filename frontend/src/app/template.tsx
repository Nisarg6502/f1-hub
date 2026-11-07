/**
 * Wraps every route's content and re-mounts on navigation, so each page fades
 * in on arrival — route changes feel connected instead of snapping.
 *
 * The fade is a CSS animation (`.route-fade` in globals.css) gated by a
 * `prefers-reduced-motion` media query, NOT a JS decision. This used to call
 * `useReducedMotion()` and return a bare fragment when it was true: the server
 * cannot know the preference and always rendered the animated wrapper, so every
 * reduced-motion visitor hit a hydration mismatch. The markup is now identical
 * on server and client; only the stylesheet differs per visitor. It also means
 * reduced-motion visitors see content before hydration instead of waiting on
 * JS to lift an inline `opacity: 0`.
 *
 * Deliberately opacity-only (no transform): a transformed ancestor becomes the
 * containing block for `position: sticky` descendants (e.g. the standings
 * sidebar), which would silently break them. A crossfade is safe and enough.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="route-fade">{children}</div>;
}
