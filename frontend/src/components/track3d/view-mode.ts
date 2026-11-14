/**
 * Which view the 3D circuit viewer opens in, and the vertical exaggeration that
 * goes with each.
 *
 * `schematic` is the stylised elevation ribbon over contour terrain. `real` is
 * the circuit as it stands: satellite imagery on a DEM with OpenStreetMap
 * buildings and woodland. Real world was a chip nobody found, so it is now what
 * the viewer opens in.
 *
 * Kept free of React and the DOM so the default is a plain function a unit test
 * can drive.
 */
export type ViewMode = "schematic" | "real";

/** The slice of `navigator.connection` this reads. Chromium only; absent
 * elsewhere, which is why every field is optional. */
export interface ConnectionHint {
  saveData?: boolean;
}

/**
 * Real world is the default because it is the thing worth seeing. It costs
 * roughly 150 tile requests though, so a visitor who has asked their browser to
 * save data opens the schematic view instead and can still switch.
 *
 * Nothing else is sniffed. A slow device is handled after the fact by the
 * viewer's own performance monitor, and a failed tile fetch leaves the
 * schematic scene on screen (see `useRealWorld`), so the default cannot blank
 * the canvas.
 */
export function defaultViewMode(connection?: ConnectionHint | null): ViewMode {
  return connection?.saveData ? "schematic" : "real";
}

/**
 * A building at 2x vertical is a tower. Real world opens at true scale; the
 * schematic view uses the exaggeration that makes gradients legible.
 */
export function exaggerationFor(mode: ViewMode): number {
  return mode === "real" ? 1 : 2;
}
