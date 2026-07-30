/**
 * Track surface material: MeshStandardMaterial patched via onBeforeCompile.
 *
 * Patched rather than a raw ShaderMaterial on purpose. A ShaderMaterial would
 * mean reimplementing three's lighting, fog and tone mapping in GLSL to get back
 * to where MeshStandardMaterial already starts, for no benefit.
 *
 * Colours are passed as THREE.Color uniforms rather than hardcoded vec3
 * literals. three r155+ enables colour management by default, so a literal
 * `vec3(1.0, 0.353, 0.122)` in the shader is interpreted as *linear* and renders
 * noticeably washed out; a Color uniform is converted from sRGB for us. It also
 * keeps the palette in TypeScript next to the design tokens.
 *
 * The reveal deliberately does not discard geometry. Nothing in the real world
 * appears out of nothing, so the ribbon is always present as dim tarmac and the
 * intro sweeps *illumination* along it instead of materialising it.
 */

import { Color, MeshStandardMaterial, type IUniform } from "three";

/**
 * APEX palette, from globals.css.
 *
 * `tarmac` is warm-700 rather than a surface token. The surface values
 * (#14110e and friends) are background colours designed to sit *behind* content;
 * used as a lit material against a #0a0908 scene they render essentially black,
 * and the flat two-thirds of every lap disappear — leaving only the steep
 * sections visible, which reads as a broken model rather than a dark one.
 */
export const TRACK_COLORS = {
  tarmac: "#4a4239",
  climbLow: "#ffae6a", // --color-primary
  climbHigh: "#ff5a1f", // --color-primary-container
  descent: "#e23a0e", // --color-ember
  kerb: "#ff5a1f",
  raceline: "#ffae6a",
} as const;

export type TrackColorMode = "gradient" | "elevation" | "plain";

const COLOR_MODE_INDEX: Record<TrackColorMode, number> = {
  gradient: 0,
  elevation: 1,
  plain: 2,
};

export interface TrackUniforms {
  /** 0 -> 1 sweep of the intro reveal, in normalised lap distance. */
  uReveal: IUniform<number>;
  /** Width of the soft leading edge, in normalised lap distance. */
  uRevealEdge: IUniform<number>;
  uColorMode: IUniform<number>;
  /** Gradient magnitude that saturates the ramp (0.15 == 15%). */
  uGradeScale: IUniform<number>;
  /** Normalised elevation, for the elevation colour mode. */
  uElevMin: IUniform<number>;
  uElevRange: IUniform<number>;
  uTarmac: IUniform<Color>;
  uClimbLow: IUniform<Color>;
  uClimbHigh: IUniform<Color>;
  uDescent: IUniform<Color>;
  uEmissiveGain: IUniform<number>;
}

export function createTrackUniforms(
  elevMin: number,
  elevRange: number,
): TrackUniforms {
  return {
    uReveal: { value: 1 },
    uRevealEdge: { value: 0.035 },
    uColorMode: { value: COLOR_MODE_INDEX.gradient },
    uGradeScale: { value: 0.15 },
    uElevMin: { value: elevMin },
    uElevRange: { value: Math.max(elevRange, 1) },
    uTarmac: { value: new Color(TRACK_COLORS.tarmac) },
    uClimbLow: { value: new Color(TRACK_COLORS.climbLow) },
    uClimbHigh: { value: new Color(TRACK_COLORS.climbHigh) },
    uDescent: { value: new Color(TRACK_COLORS.descent) },
    uEmissiveGain: { value: 1 },
  };
}

export function setColorMode(uniforms: TrackUniforms, mode: TrackColorMode) {
  uniforms.uColorMode.value = COLOR_MODE_INDEX[mode];
}

const COMMON = /* glsl */ `
  varying float vGradeF;
  varying float vDistF;
  varying float vUF;
  varying float vElevF;
`;

/**
 * Flame ramp: neutral tarmac through to the warm accents.
 *
 * The smoothstep floor at 0.04 matters — without it, DEM residual noise on a
 * flat straight tints the whole surface faintly orange and the effect stops
 * meaning anything.
 */
const RAMP = /* glsl */ `
  vec3 apexRamp(float g) {
    float t = clamp(abs(g), 0.0, 1.0);
    vec3 climb = mix(uClimbLow, uClimbHigh, smoothstep(0.35, 1.0, t));
    vec3 target = g >= 0.0 ? climb : uDescent;
    return mix(uTarmac, target, smoothstep(0.04, 0.55, t));
  }

  // Colour mode is resolved once, here, and used for BOTH the diffuse and the
  // emissive channels. Applying it to diffuse alone looks like a no-op: the
  // emissive term is what bloom amplifies, so it dominates the final image and
  // switching modes appears to do nothing at all.
  vec3 modeSurface(float grade, float elev) {
    if (uColorMode < 0.5) {
      return apexRamp(grade / uGradeScale);
    }
    if (uColorMode < 1.5) {
      float h = clamp((elev - uElevMin) / uElevRange, 0.0, 1.0);
      return mix(uTarmac, mix(uClimbLow, uClimbHigh, h), 0.35 + 0.65 * h);
    }
    return uTarmac;
  }

  // How strongly a sample should glow, in the same terms as its colour: by
  // steepness in gradient mode, by height in elevation mode, not at all in plain.
  float modeStrength(float grade, float elev) {
    if (uColorMode < 0.5) {
      return smoothstep(0.05, 0.45, abs(grade / uGradeScale));
    }
    if (uColorMode < 1.5) {
      return clamp((elev - uElevMin) / uElevRange, 0.0, 1.0) * 0.8;
    }
    return 0.0;
  }
`;

export function patchTrackMaterial(
  material: MeshStandardMaterial,
  uniforms: TrackUniforms,
) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aGrade;
         attribute float aDist;
         ${COMMON}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vGradeF = aGrade;
         vDistF = aDist;
         vUF = uv.x;
         vElevF = position.y;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uReveal;
         uniform float uRevealEdge;
         uniform float uColorMode;
         uniform float uGradeScale;
         uniform float uElevMin;
         uniform float uElevRange;
         uniform vec3 uTarmac;
         uniform vec3 uClimbLow;
         uniform vec3 uClimbHigh;
         uniform vec3 uDescent;
         uniform float uEmissiveGain;
         ${COMMON}
         ${RAMP}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         {
           vec3 surface = modeSurface(vGradeF, vElevF);

           // The reveal illuminates rather than materialises: the unrevealed
           // ribbon is still there, just unlit tarmac.
           float lit = 1.0 - smoothstep(uReveal - uRevealEdge, uReveal, vUF);
           diffuseColor.rgb *= mix(vec3(0.45), vec3(1.0), lit);
           diffuseColor.rgb = mix(diffuseColor.rgb, surface, 0.85 * lit);
         }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         {
           float lit = 1.0 - smoothstep(uReveal - uRevealEdge, uReveal, vUF);
           vec3 surface = modeSurface(vGradeF, vElevF);
           float strength = modeStrength(vGradeF, vElevF);

           // A self-illumination floor across the whole surface. Without it the
           // flat two-thirds of the lap depend entirely on the key light, and
           // ACES tone mapping crushes a dark warm diffuse into the background —
           // leaving only the steep sections visible, which reads as a broken
           // model rather than an unlit one.
           vec3 base = mix(uTarmac, surface, 0.5) * 0.55;
           vec3 glow = surface * strength * 0.65;

           // A bright band tracking the leading edge, so the sweep reads as a
           // direction of travel rather than a dissolve.
           float edge = smoothstep(uReveal - uRevealEdge, uReveal - uRevealEdge * 0.35, vUF)
                      * (1.0 - smoothstep(uReveal - uRevealEdge * 0.35, uReveal, vUF));
           totalEmissiveRadiance +=
             (base * mix(0.35, 1.0, lit) + glow * lit + uClimbLow * edge * 1.6)
             * uEmissiveGain;
         }`,
      );
  };
  material.needsUpdate = true;
}

/**
 * Kerb material: red/white stripes driven by along-track distance.
 *
 * Distance-based rather than UV-based so the stripe pitch stays constant in
 * metres regardless of lap length — a UV-based stripe would be visibly coarser
 * at Spa than at Monaco.
 */
export function patchKerbMaterial(
  material: MeshStandardMaterial,
  stripeMetres = 2.4,
) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStripe = { value: stripeMetres };
    shader.uniforms.uKerb = { value: new Color(TRACK_COLORS.kerb) };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aDist;
         varying float vDistK;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vDistK = aDist;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uStripe;
         uniform vec3 uKerb;
         varying float vDistK;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         {
           float phase = fract(vDistK / uStripe);
           // Soft edges rather than step(): a hard stripe on a surface this thin
           // aliases into shimmering dashes as the camera moves.
           float band = smoothstep(0.46, 0.54, phase) * (1.0 - smoothstep(0.96, 1.0, phase));
           // The pale band is deliberately well below white. At full white it
           // outshines the gradient colouring under bloom, so the kerbs end up
           // dominating a view whose actual subject is elevation.
           diffuseColor.rgb = mix(uKerb * 0.75, vec3(0.55, 0.52, 0.47), band);
         }`,
      );
  };
  material.needsUpdate = true;
}
