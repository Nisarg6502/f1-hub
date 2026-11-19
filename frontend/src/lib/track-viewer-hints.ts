/**
 * The line under the 3D viewer that says how to drive it.
 *
 * Until the reader first interacts, the viewer ignores wheel and pinch so that
 * scrolling the page past it does not zoom the map. The wording has to match the
 * device: "Click to orbit · scroll to zoom" on a phone describes controls the
 * reader does not have. `coarsePointer` is `matchMedia("(pointer: coarse)")`.
 */
export function orbitHint(coarsePointer: boolean): string {
  return coarsePointer
    ? "Tap to start · drag to orbit · pinch to zoom"
    : "Click to orbit · scroll to zoom once active";
}
