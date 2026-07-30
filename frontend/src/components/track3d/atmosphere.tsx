"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  SphereGeometry,
} from "three";

/**
 * Environmental depth for the viewer.
 *
 * A flat clear colour gives the scene no horizon and no sense of scale — the
 * circuit floats in a void. Two cheap pieces fix that without any external
 * assets (which a strict CSP would block anyway):
 *
 *   SkyDome  a vertical gradient on the inside of a sphere, warm near the
 *            horizon fading to near-black overhead, so the terrain has
 *            something to sit against.
 *   Embers   slow drifting motes, the 3D counterpart of the app's existing
 *            `ember-canvas.tsx` hero treatment, which is what ties this scene
 *            to the rest of APEX rather than looking like a generic 3D widget.
 */

const SKY_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uGround;
  varying vec3 vWorld;

  void main() {
    float h = normalize(vWorld).y;
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
    vec3 col = mix(uGround, sky, smoothstep(-0.12, 0.02, h));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export function SkyDome({ radius }: { radius: number }) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          // Warm ember glow at the horizon, resolving to the app background.
          uHorizon: { value: new Color("#2a1a12") },
          uZenith: { value: new Color("#0a0908") },
          uGround: { value: new Color("#070605") },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      }),
    [],
  );

  const geometry = useMemo(() => new SphereGeometry(radius, 32, 20), [radius]);
  useEffect(
    () => () => {
      material.dispose();
      geometry.dispose();
    },
    [material, geometry],
  );

  // renderOrder -100 so it never occludes anything despite being huge.
  return <mesh geometry={geometry} material={material} renderOrder={-100} frustumCulled={false} />;
}

const EMBER_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uSpan;
  uniform float uRise;
  varying float vFade;

  void main() {
    vec3 p = position;
    // Drift upward on a loop, with a lateral sway keyed off the per-particle
    // seed so no two move together.
    float t = fract(uTime * 0.05 + aSeed);
    p.y += t * uRise;
    p.x += sin(uTime * 0.35 + aSeed * 42.0) * uSpan * 0.012;
    p.z += cos(uTime * 0.29 + aSeed * 27.0) * uSpan * 0.012;

    // Fade in and out at both ends so particles never pop.
    vFade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.72, 1.0, t));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * (300.0 / max(-mv.z, 1.0));
  }
`;

const EMBER_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vFade;

  void main() {
    // Round, soft-edged point. Discarding outside the disc avoids square motes.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float alpha = (1.0 - smoothstep(0.0, 0.25, r)) * vFade * 0.55;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

/**
 * Deterministic PRNG (mulberry32).
 *
 * Math.random() inside useMemo is genuinely unsafe: React may discard and re-run
 * a memo, which would teleport every ember to a new position mid-animation. A
 * fixed seed makes the field stable across re-renders and identical between
 * server and client.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Embers({
  span,
  baseY,
  count = 220,
}: {
  span: number;
  baseY: number;
  count?: number;
}) {
  const pointsRef = useRef<Points>(null);
  const materialRef = useRef<ShaderMaterial>(null);

  const geometry = useMemo(() => {
    const random = mulberry32(0x5eed);
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (random() - 0.5) * span * 1.6;
      positions[i * 3 + 1] = baseY - span * 0.05 + random() * span * 0.1;
      positions[i * 3 + 2] = (random() - 0.5) * span * 1.6;
      seeds[i] = random();
      sizes[i] = 0.6 + random() * 1.8;
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(positions, 3));
    g.setAttribute("aSeed", new BufferAttribute(seeds, 1));
    g.setAttribute("aSize", new BufferAttribute(sizes, 1));
    return g;
  }, [count, span, baseY]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: new Color("#ff9648") },
      uSpan: { value: span },
      uRise: { value: span * 0.55 },
    }),
    [span],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  // Mutating through a ref rather than a memoised material: refs exist for
  // exactly this, and it keeps the per-frame write out of render-derived state.
  useFrame((_, delta) => {
    const material = materialRef.current;
    if (material) material.uniforms.uTime.value += delta;
  });

  return (
    <points ref={pointsRef} geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        blending={AdditiveBlending}
        fog={false}
        uniforms={uniforms}
        vertexShader={EMBER_VERT}
        fragmentShader={EMBER_FRAG}
      />
    </points>
  );
}
