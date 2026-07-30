/**
 * Terrain material: elevation tint plus topographic contour lines.
 *
 * A flat-coloured displaced grid reads as a dark quadrilateral, not as a
 * landform — the relief is there in the geometry but nothing in the shading
 * communicates it. Two cheap additions fix that:
 *
 *   1. An elevation ramp, so height maps to value and the eye reads the shape.
 *   2. Contour lines at a fixed metre interval, which is exactly the visual
 *      language people already associate with terrain, and which reinforces
 *      what this whole feature is about.
 *
 * Contours are anti-aliased with fwidth so they stay one pixel wide at any
 * zoom instead of aliasing into moire at distance.
 */

import { Color, MeshStandardMaterial, type IUniform } from "three";

export interface TerrainUniforms {
  uLow: IUniform<Color>;
  uHigh: IUniform<Color>;
  uContour: IUniform<Color>;
  uElevMin: IUniform<number>;
  uElevRange: IUniform<number>;
  /** Contour spacing in metres of real elevation. */
  uInterval: IUniform<number>;
  uContourStrength: IUniform<number>;
  /** Vertical exaggeration, so contours stay at true metre spacing. */
  uExaggeration: IUniform<number>;
  /** Centre of the sampled grid in world XZ, for the edge fade. */
  uCenterXZ: IUniform<[number, number]>;
  /** Half-extent of the grid in world XZ. */
  uHalfExtent: IUniform<[number, number]>;
}

export function createTerrainUniforms(
  elevMin: number,
  elevRange: number,
): TerrainUniforms {
  // Sparser contours on flat circuits, tighter on dramatic ones, so Zandvoort's
  // 5 m of relief and Spa's 107 m both end up with a readable number of lines.
  const interval = elevRange > 60 ? 10 : elevRange > 25 ? 5 : 1;
  return {
    uLow: { value: new Color("#1a1512") },
    uHigh: { value: new Color("#4a3b2c") },
    uContour: { value: new Color("#ff8a3d") },
    uElevMin: { value: elevMin },
    uElevRange: { value: Math.max(elevRange, 1) },
    uInterval: { value: interval },
    uContourStrength: { value: 0.42 },
    uExaggeration: { value: 1 },
    uCenterXZ: { value: [0, 0] },
    uHalfExtent: { value: [1, 1] },
  };
}

export function patchTerrainMaterial(
  material: MeshStandardMaterial,
  uniforms: TerrainUniforms,
) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         varying float vTerrainY;
         varying vec2 vTerrainXZ;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vTerrainY = position.y;
         vTerrainXZ = position.xz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform vec3 uLow;
         uniform vec3 uHigh;
         uniform vec3 uContour;
         uniform float uElevMin;
         uniform float uElevRange;
         uniform float uInterval;
         uniform float uContourStrength;
         uniform float uExaggeration;
         uniform vec2 uCenterXZ;
         uniform vec2 uHalfExtent;
         varying float vTerrainY;
         varying vec2 vTerrainXZ;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         {
           float h = clamp((vTerrainY - uElevMin) / uElevRange, 0.0, 1.0);
           diffuseColor.rgb *= mix(uLow, uHigh, pow(h, 0.75)) * 2.0;

           // Contour lines at true metre intervals. Screen-space derivatives
           // keep them a constant width, so they neither vanish when zoomed out
           // nor turn into fat bands up close.
           float bands = vTerrainY / uInterval;
           float d = fwidth(bands);
           float f = fract(bands);
           float line = 1.0 - smoothstep(0.0, d * 1.4, min(f, 1.0 - f));
           // Fade contours out where they would alias into noise at distance.
           line *= 1.0 - smoothstep(0.35, 0.9, d);
           diffuseColor.rgb = mix(
             diffuseColor.rgb,
             uContour,
             line * uContourStrength * (0.35 + 0.65 * h)
           );

           // Dissolve the sampled square into the background. The DEM grid is a
           // rectangle around the circuit's bounding box, and without this it
           // ends in a hard geometric edge floating in space — which announces
           // "this is a clipped dataset" instead of "this is a landscape".
           vec2 q = abs(vTerrainXZ - uCenterXZ) / max(uHalfExtent, vec2(1.0));
           float edge = 1.0 - smoothstep(0.62, 0.99, max(q.x, q.y));
           diffuseColor.a *= edge;
         }`,
      );
  };
  material.needsUpdate = true;
}
