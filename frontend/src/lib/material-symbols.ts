/**
 * The Material Symbols glyphs this app draws, and the stylesheet URL that
 * loads only those.
 *
 * The font used to be requested whole — every one of the ~3,800 icons, across
 * the full weight (100-700) and fill (0-1) axes — as a 1.14 MB woff2 on every
 * page, to draw a few dozen glyphs at one fixed weight and fill (globals.css
 * pins "FILL" 0, "wght" 400). Google Fonts' `icon_names` subset with static
 * axis values serves the same glyphs in about 9 KB (woff2).
 *
 * **Adding an icon means adding it here.** A glyph missing from the subset
 * renders as its ligature text ("trophy") instead of the icon.
 * `material-symbols.test.ts` scans the source for icon names and fails if
 * one is missing, so this cannot drift silently.
 */
export const ICON_NAMES = [
  "account_circle",
  "add",
  "all_inclusive",
  "arrow_forward",
  "barcode",
  "bolt",
  "calendar_add_on",
  "calendar_month",
  "check",
  "chevron_left",
  "chevron_right",
  "close",
  "compare_arrows",
  "conversion_path",
  "cyclone",
  "dashboard_customize",
  "database",
  "delete_forever",
  "donut_large",
  "download",
  "emoji_events",
  "event",
  "event_repeat",
  "event_upcoming",
  "expand_more",
  "explore",
  "flag",
  "format_list_numbered",
  "forum",
  "groups",
  "history",
  "home",
  "hourglass_empty",
  "info",
  "insights",
  "keyboard_arrow_down",
  "landscape",
  "leaderboard",
  "lightbulb",
  "link",
  "local_fire_department",
  "logout",
  "mail",
  "manage_accounts",
  "mark_email_read",
  "menu_book",
  "more_horiz",
  "open_in_full",
  "open_in_new",
  "person",
  "play_circle",
  "public",
  "query_stats",
  "remove",
  "rocket_launch",
  "route",
  "sensors",
  "shield",
  "smart_display",
  "speed",
  "sports_score",
  "swords",
  "timer",
  "trophy",
  "undo",
  "unfold_more",
  "visibility",
  "visibility_off",
  "warning",
] as const;

// Sorted so the URL (and so the browser and CDN cache key) is stable. Google
// silently drops a name that is not an icon, so the guard test is the only
// check. `display=block` (was `swap`): a swap shows each ligature as a word,
// "trophy", until the font arrives; block keeps the icon space blank instead.
export const MATERIAL_SYMBOLS_HREF =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" +
  `&icon_names=${[...ICON_NAMES].sort().join(",")}&display=block`;
