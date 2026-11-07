import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDebouncedPatch,
  createSyncedHomeLayoutStorage,
  homeLayoutFromPreference,
  homeLayoutToPreference,
  isReadableSpoilerCookie,
  normaliseSpoilerCookie,
  planInitialSync,
  spoilersFromPreference,
} from "./account-sync";
import {
  DEFAULT_HOME_LAYOUT,
  addWidget,
  createLocalHomeLayoutStorage,
  removeWidget,
  type HomeLayout,
} from "./home-layout";
import { validatePreferencesPatch } from "./preferences";
import { DEFAULT_SPOILER_PREFS, serializeSpoilerPrefs } from "./spoilers";

const CUSTOM: HomeLayout = addWidget(removeWidget(DEFAULT_HOME_LAYOUT, "tips"), "season", "l");
const OTHER: HomeLayout = removeWidget(DEFAULT_HOME_LAYOUT, "explore");
const SPOILERS_ON = serializeSpoilerPrefs({
  ...DEFAULT_SPOILER_PREFS,
  on: true,
  revealed: ["2026-3"],
  since: 1_780_000_000_000,
});
const SPOILERS_OFF = serializeSpoilerPrefs({ ...DEFAULT_SPOILER_PREFS, revealed: [] });

describe("converters", () => {
  it("round-trips a layout through the account shape", () => {
    const stored = homeLayoutToPreference(CUSTOM);
    const back = homeLayoutFromPreference(JSON.parse(JSON.stringify(stored)));
    expect(back?.items).toEqual(CUSTOM.items);
  });

  it("reads the stored default as the default reference", () => {
    expect(homeLayoutFromPreference(homeLayoutToPreference(DEFAULT_HOME_LAYOUT))).toBe(
      DEFAULT_HOME_LAYOUT
    );
  });

  it("treats an absent layout as none, and garbage as the default", () => {
    expect(homeLayoutFromPreference(undefined)).toBeNull();
    expect(homeLayoutFromPreference(null)).toBeNull();
    expect(homeLayoutFromPreference({ version: 99, items: [] })).toBe(DEFAULT_HOME_LAYOUT);
  });

  it("accepts only a non-empty string as stored spoilers", () => {
    expect(spoilersFromPreference(undefined)).toBeNull();
    expect(spoilersFromPreference("")).toBeNull();
    expect(spoilersFromPreference({ on: true })).toBeNull();
    expect(spoilersFromPreference(SPOILERS_ON)).toBe(SPOILERS_ON);
  });

  it("normalises an encoded cookie to the written form", () => {
    expect(normaliseSpoilerCookie(encodeURIComponent(SPOILERS_ON))).toBe(SPOILERS_ON);
    expect(normaliseSpoilerCookie("")).toBe("");
  });

  it("produces values the preferences validator accepts", () => {
    const result = validatePreferencesPatch(
      JSON.parse(JSON.stringify({ homeLayout: homeLayoutToPreference(CUSTOM), spoilers: SPOILERS_ON }))
    );
    expect(result.ok).toBe(true);
  });
});

describe("planInitialSync", () => {
  it("does nothing for a fresh account and a default browser", () => {
    expect(planInitialSync({}, { homeLayout: DEFAULT_HOME_LAYOUT, spoilerCookie: "" })).toEqual({
      homeLayout: null,
      spoilerCookie: null,
      upload: {},
    });
  });

  it("uploads local choices when the account has none", () => {
    const plan = planInitialSync({}, { homeLayout: CUSTOM, spoilerCookie: SPOILERS_ON });
    expect(plan.homeLayout).toBeNull();
    expect(plan.spoilerCookie).toBeNull();
    expect(homeLayoutFromPreference(plan.upload.homeLayout)?.items).toEqual(CUSTOM.items);
    expect(plan.upload.spoilers).toBe(SPOILERS_ON);
  });

  it("uploads a spoiler cookie even when the mode is off (a deliberate choice)", () => {
    const plan = planInitialSync({}, { homeLayout: DEFAULT_HOME_LAYOUT, spoilerCookie: SPOILERS_OFF });
    expect(plan.upload).toEqual({ spoilers: SPOILERS_OFF });
  });

  it("lets the account win over a different local value, and uploads nothing", () => {
    const plan = planInitialSync(
      { homeLayout: homeLayoutToPreference(OTHER), spoilers: SPOILERS_OFF },
      { homeLayout: CUSTOM, spoilerCookie: SPOILERS_ON }
    );
    expect(plan.homeLayout?.items).toEqual(OTHER.items);
    expect(plan.spoilerCookie).toBe(SPOILERS_OFF);
    expect(plan.upload).toEqual({});
  });

  it("hydrates a fresh browser from the account", () => {
    const plan = planInitialSync(
      { homeLayout: homeLayoutToPreference(CUSTOM), spoilers: SPOILERS_ON },
      { homeLayout: DEFAULT_HOME_LAYOUT, spoilerCookie: "" }
    );
    expect(plan.homeLayout?.items).toEqual(CUSTOM.items);
    expect(plan.spoilerCookie).toBe(SPOILERS_ON);
  });

  it("an account reset to default beats a custom local layout", () => {
    const plan = planInitialSync(
      { homeLayout: homeLayoutToPreference(DEFAULT_HOME_LAYOUT) },
      { homeLayout: CUSTOM, spoilerCookie: "" }
    );
    expect(plan.homeLayout).toBe(DEFAULT_HOME_LAYOUT);
    expect(plan.upload).toEqual({});
  });

  it("leaves local alone when it already matches the account", () => {
    const plan = planInitialSync(
      { homeLayout: homeLayoutToPreference(CUSTOM), spoilers: SPOILERS_ON },
      { homeLayout: CUSTOM, spoilerCookie: encodeURIComponent(SPOILERS_ON) }
    );
    expect(plan).toEqual({ homeLayout: null, spoilerCookie: null, upload: {} });
  });

  it("never uploads another account's leftovers, but still hydrates", () => {
    const leftovers = { homeLayout: CUSTOM, spoilerCookie: SPOILERS_ON, mayUpload: false };
    expect(planInitialSync({}, leftovers).upload).toEqual({});
    const plan = planInitialSync({ spoilers: SPOILERS_OFF }, leftovers);
    expect(plan.spoilerCookie).toBe(SPOILERS_OFF);
    expect(plan.upload).toEqual({});
  });

  it("does not upload a corrupt cookie's fail-closed reading", () => {
    expect(isReadableSpoilerCookie("garbage")).toBe(false);
    expect(isReadableSpoilerCookie("v2|x|7|0|0|")).toBe(false);
    expect(isReadableSpoilerCookie("%E0%A4%A")).toBe(false);
    expect(isReadableSpoilerCookie(SPOILERS_ON)).toBe(true);
    expect(isReadableSpoilerCookie("v1|1|7|0|2026-3")).toBe(true);
    const plan = planInitialSync({}, { homeLayout: DEFAULT_HOME_LAYOUT, spoilerCookie: "garbage" });
    expect(plan.upload).toEqual({});
  });

  it("ignores favourites and clock: they have no local copy", () => {
    const plan = planInitialSync(
      { favourites: { driverId: "norris", teamId: null }, clock: "24h" },
      { homeLayout: DEFAULT_HOME_LAYOUT, spoilerCookie: "" }
    );
    expect(plan).toEqual({ homeLayout: null, spoilerCookie: null, upload: {} });
  });
});

describe("createDebouncedPatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one patch, latest value per namespace", () => {
    const send = vi.fn();
    const saver = createDebouncedPatch(send, 1000);
    saver.schedule({ homeLayout: 1 });
    vi.advanceTimersByTime(500);
    saver.schedule({ spoilers: "a" });
    saver.schedule({ homeLayout: 2 });
    vi.advanceTimersByTime(999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ homeLayout: 2, spoilers: "a" });
  });

  it("flush sends now, and only once, resolving after the send", async () => {
    let resolveSend: () => void = () => {};
    const send = vi.fn(() => new Promise<void>((r) => (resolveSend = r)));
    const saver = createDebouncedPatch(send, 1000);
    await saver.flush();
    expect(send).not.toHaveBeenCalled();
    saver.schedule({ spoilers: "x" });
    let done = false;
    const flushed = saver.flush().then(() => (done = true));
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(done).toBe(false);
    resolveSend();
    await flushed;
    expect(done).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the queue", () => {
    const send = vi.fn();
    const saver = createDebouncedPatch(send, 1000);
    saver.schedule({ spoilers: "x" });
    saver.cancel();
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createSyncedHomeLayoutStorage", () => {
  function memory() {
    const data: Record<string, string> = {};
    return createLocalHomeLayoutStorage({
      getStorage: () => ({
        getItem: (k) => data[k] ?? null,
        setItem: (k, v) => {
          data[k] = v;
        },
        removeItem: (k) => {
          delete data[k];
        },
      }),
      events: null,
    });
  }

  it("persists locally and reports local saves for upload", () => {
    const base = memory();
    const saved: HomeLayout[] = [];
    const storage = createSyncedHomeLayoutStorage(base, (l) => saved.push(l));
    storage.save(CUSTOM);
    expect(base.load().items).toEqual(CUSTOM.items);
    expect(saved).toEqual([CUSTOM]);
  });

  it("replace persists and notifies the store without reporting an upload", () => {
    const base = memory();
    const onSave = vi.fn();
    const storage = createSyncedHomeLayoutStorage(base, onSave);
    const changed = vi.fn();
    const off = storage.subscribe(changed);
    storage.replace(OTHER);
    expect(storage.load().items).toEqual(OTHER.items);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    off();
    storage.replace(CUSTOM);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
