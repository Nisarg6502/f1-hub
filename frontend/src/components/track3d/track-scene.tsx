"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  CylinderGeometry,
  DoubleSide,
  Fog,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  Color as ThreeColor,
  TubeGeometry,
  Vector3,
} from "three";

import type { TrackCorner } from "@/lib/circuit-geometry";
import { Embers, SkyDome } from "./atmosphere";
import CornerMarkers from "./corner-markers";
import { createTerrainUniforms, patchTerrainMaterial } from "./terrain-shader";
import type { TrackFrames } from "./build-ribbon";
import type { TrackGeometryBundle, TrackScrubStore } from "./use-track-geometry";
import {
  createTrackUniforms,
  patchKerbMaterial,
  patchTrackMaterial,
  setColorMode,
  TRACK_COLORS,
  type TrackColorMode,
} from "./track-shader";

/** cubic-bezier(0.23, 1, 0.32, 1) — the app's --ease-out-apex, as a function. */
export function easeOutApex(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

export interface TrackSceneProps {
  bundle: TrackGeometryBundle;
  exaggeration: number;
  /** Presentation width multiplier, so kerb striping keeps its proportions. */
  widthScale: number;
  colorMode: TrackColorMode;
  showTerrain: boolean;
  showRaceline: boolean;
  showPosts: boolean;
  /** Skip the intro sweep's motion; the colour reveal still resolves. */
  reducedMotion: boolean;
  showCorners: boolean;
  activeCornerName?: string | null;
  onSelectCorner?: (corner: TrackCorner) => void;
  /** Called with arc length in metres as the pointer moves over the ribbon. */
  onHoverDistance?: (metres: number | null) => void;
  onRevealDone?: () => void;
  /** Drives the on-track playhead puck. */
  scrub: TrackScrubStore;
}

export default function TrackScene({
  bundle,
  exaggeration,
  widthScale,
  colorMode,
  showTerrain,
  showRaceline,
  showPosts,
  reducedMotion,
  showCorners,
  activeCornerName,
  onSelectCorner,
  onHoverDistance,
  onRevealDone,
  scrub,
}: TrackSceneProps) {
  const { frames, payload } = bundle;
  const { scene } = useThree();

  // Everything physically present in the world lives under this group, so corner
  // labels can raycast against a single stable object for occlusion instead of
  // an array of per-layer refs that go null whenever a layer is toggled off.
  // The cast is drei's type being stricter than its runtime: `occlude` is typed
  // `RefObject<Object3D>[]` (never null) but every React ref to a rendered object
  // is null until mount. drei only dereferences it inside useFrame, which cannot
  // run before the group exists.
  const worldRef = useRef<Group>(null);
  const occluders = useMemo(
    () => [worldRef as RefObject<Object3D>],
    [],
  );

  const uniforms = useMemo(
    () => createTrackUniforms(frames.min.y, frames.elevationRange),
    [frames],
  );

  const trackMaterial = useMemo(() => {
    const material = new MeshStandardMaterial({
      color: new ThreeColor(TRACK_COLORS.tarmac),
      roughness: 0.85,
      metalness: 0.0,
      side: DoubleSide,
      emissive: new ThreeColor("#000000"),
      emissiveIntensity: 1,
    });
    patchTrackMaterial(material, uniforms);
    return material;
  }, [uniforms]);

  const kerbMaterial = useMemo(() => {
    const material = new MeshStandardMaterial({
      roughness: 0.7,
      metalness: 0.0,
      side: DoubleSide,
    });
    // Stripe pitch scales with the width multiplier so the kerb proportions stay
    // right — a fixed 2.4 m pitch on a 3x-wide ribbon reads as stubby blocks.
    patchKerbMaterial(material, 2.4 * widthScale);
    return material;
  }, [widthScale]);

  const terrainUniforms = useMemo(
    () => createTerrainUniforms(frames.min.y, frames.elevationRange),
    [frames],
  );

  const terrainMaterial = useMemo(() => {
    const material = new MeshStandardMaterial({
      color: new ThreeColor("#ffffff"), // tinted entirely by the elevation ramp
      roughness: 1.0,
      metalness: 0.0,
      flatShading: false,
      transparent: true,
      opacity: 0,
      // Second line of defence against z-fighting with the track ribbon. The
      // pipeline already sinks the blended terrain 2.5 m below the road bed;
      // this covers the shallow-angle views where depth precision is worst.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    patchTerrainMaterial(material, terrainUniforms);
    return material;
  }, [terrainUniforms]);

  // Contours are spaced in true metres, so they must compensate for the
  // non-uniform group scale that applies vertical exaggeration.
  useEffect(() => {
    terrainUniforms.uExaggeration.value = exaggeration;
    terrainUniforms.uInterval.value =
      (frames.elevationRange > 60 ? 10 : frames.elevationRange > 25 ? 5 : 1) *
      exaggeration;
  }, [terrainUniforms, exaggeration, frames.elevationRange]);

  // Feed the terrain's own footprint to the edge fade, taken from the grid
  // rather than the track bbox — the grid is padded well beyond the circuit.
  useEffect(() => {
    const terrain = payload.terrain;
    if (!terrain) return;
    const halfX = (terrain.nx - 1) * terrain.spacing_m * 0.5;
    const halfZ = (terrain.ny - 1) * terrain.spacing_m * 0.5;
    terrainUniforms.uCenterXZ.value = [
      terrain.origin_e_m + halfX,
      -(terrain.origin_n_m + halfZ),
    ];
    terrainUniforms.uHalfExtent.value = [halfX, halfZ];
  }, [terrainUniforms, payload.terrain]);

  const racelineMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new ThreeColor(TRACK_COLORS.raceline),
        emissive: new ThreeColor(TRACK_COLORS.raceline),
        emissiveIntensity: 1.4,
        roughness: 0.4,
      }),
    [],
  );

  const postMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new ThreeColor("#3a332b"),
        transparent: true,
        opacity: 0.32,
        roughness: 0.9,
      }),
    [],
  );

  useEffect(() => setColorMode(uniforms, colorMode), [uniforms, colorMode]);

  useEffect(
    () => () => {
      trackMaterial.dispose();
      kerbMaterial.dispose();
      terrainMaterial.dispose();
      racelineMaterial.dispose();
      postMaterial.dispose();
    },
    [trackMaterial, kerbMaterial, terrainMaterial, racelineMaterial, postMaterial],
  );

  // Fog scaled to the circuit, not a constant: Spa's 7 km lap and Zandvoort's
  // 4.3 km would otherwise need different values to look the same.
  useEffect(() => {
    const near = frames.diagonal * 0.85;
    const far = frames.diagonal * 3.1;
    scene.fog = new Fog(new ThreeColor("#0a0908").getHex(), near, far);
    return () => {
      scene.fog = null;
    };
  }, [scene, frames.diagonal]);

  // Racing line as a tube along the aligned TUMFTM optimal line.
  const racelineGeometry = useMemo(() => {
    if (!bundle.raceline) return null;
    const radius = Math.max(0.55, frames.diagonal / 2600);
    return new TubeGeometry(bundle.raceline, 900, radius, 6, true);
  }, [bundle.raceline, frames.diagonal]);

  useEffect(() => () => racelineGeometry?.dispose(), [racelineGeometry]);

  // Elevation posts: one instanced cylinder every 50 m, dropping to the datum.
  const postsRef = useRef<InstancedMesh>(null);
  const postGeometry = useMemo(() => new CylinderGeometry(0.32, 0.32, 1, 6), []);
  useEffect(() => () => postGeometry.dispose(), [postGeometry]);

  const postCount = Math.max(1, Math.floor(frames.length / 50));
  useEffect(() => {
    const mesh = postsRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    const datum = frames.min.y;
    for (let i = 0; i < postCount; i += 1) {
      const sample = Math.min(
        frames.count - 1,
        Math.round((i * 50) / frames.spacing),
      );
      const x = frames.center[sample * 3];
      const y = frames.center[sample * 3 + 1];
      const z = frames.center[sample * 3 + 2];
      const height = Math.max(0.01, y - datum);
      dummy.position.set(x, datum + height / 2, z);
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [frames, postCount]);

  // Intro sweep. Under reduced motion the reveal resolves immediately rather
  // than animating position — gentler, not absent.
  const revealStart = useRef<number | null>(null);
  const revealDone = useRef(false);
  useEffect(() => {
    uniforms.uReveal.value = reducedMotion ? 1.02 : 0;
    revealStart.current = null;
    revealDone.current = reducedMotion;
    terrainMaterial.opacity = reducedMotion ? 1 : 0;
    if (reducedMotion) onRevealDone?.();
  }, [uniforms, reducedMotion, terrainMaterial, onRevealDone, payload.id]);

  const REVEAL_MS = 1400;
  const TERRAIN_FADE_MS = 1100;

  useFrame((_, delta) => {
    if (revealDone.current) return;
    const now = (revealStart.current ??= 0) + delta * 1000;
    revealStart.current = now;

    uniforms.uReveal.value = easeOutApex(now / REVEAL_MS) * 1.02;
    terrainMaterial.opacity = Math.min(1, easeOutApex(now / TERRAIN_FADE_MS));

    if (now >= REVEAL_MS) {
      uniforms.uReveal.value = 1.02;
      terrainMaterial.opacity = 1;
      revealDone.current = true;
      onRevealDone?.();
    }
  });

  return (
    <>
      <SkyDome radius={frames.diagonal * 4} />
      {!reducedMotion && showTerrain && (
        <Embers span={frames.diagonal} baseY={frames.min.y * exaggeration} />
      )}

      <hemisphereLight args={["#4a4239", "#0f0d0b", 0.95]} />
      <ambientLight intensity={0.3} />
      {/* Warm key light, then an ember rim that ties the scene to the app's palette. */}
      <directionalLight position={[400, 620, 300]} intensity={2.1} color="#ffd9b8" />
      <directionalLight position={[-520, 210, -420]} intensity={0.7} color="#ff5a1f" />

      {/*
        Vertical exaggeration is a non-uniform group scale rather than a shader
        displacement. three recomputes normalMatrix per mesh, so lighting stays
        correct, and terrain, ribbon, racing line and posts all stay mutually
        consistent for free.
      */}
      <group ref={worldRef} scale={[1, exaggeration, 1]}>
        {showTerrain && bundle.terrain && (
          <mesh geometry={bundle.terrain} material={terrainMaterial} renderOrder={-1} />
        )}

        {/*
          Hovering the ribbon reports arc length, which drives the playhead on
          the 2D profile. The distance is read from the aDist attribute at the
          hit triangle rather than recomputed from the hit point — the attribute
          is the same value the geometry was built from, so the two views can
          never disagree.
        */}
        <mesh
          geometry={bundle.ribbon}
          material={trackMaterial}
          onPointerMove={(event) => {
            if (!onHoverDistance) return;
            event.stopPropagation();
            const attribute = bundle.ribbon.getAttribute("aDist");
            const vertex = event.face?.a;
            if (attribute && vertex !== undefined) {
              onHoverDistance(attribute.getX(vertex));
            }
          }}
          onPointerOut={() => onHoverDistance?.(null)}
        />
        <mesh geometry={bundle.kerbLeft} material={kerbMaterial} />
        <mesh geometry={bundle.kerbRight} material={kerbMaterial} />

        {showRaceline && racelineGeometry && (
          <mesh geometry={racelineGeometry} material={racelineMaterial} />
        )}

        {showPosts && (
          <instancedMesh
            ref={postsRef}
            args={[postGeometry, postMaterial, postCount]}
          />
        )}
      </group>

      {/*
        Corner labels sit OUTSIDE the exaggerated group and apply the multiplier
        to their own Y instead. Inside it, the non-uniform scale would stretch
        the label geometry vertically along with the terrain.
      */}
      {showCorners && payload.corners.length > 0 && (
        <CornerMarkers
          corners={payload.corners}
          frames={frames}
          exaggeration={exaggeration}
          activeName={activeCornerName}
          occluders={occluders}
          onSelect={onSelectCorner}
        />
      )}

      <ScrubMarker frames={frames} exaggeration={exaggeration} scrub={scrub} />
    </>
  );
}

/**
 * The playhead, on the track.
 *
 * Scrubbing the 2D profile moves the camera, but without something visible at
 * the scrub position there is nothing to anchor that motion to — you cannot tell
 * whether the camera moved 50 m or 500 m. This puck is that anchor, and it makes
 * the profile and the 3D scene legibly the same object.
 *
 * Position is written straight to the object3d in `useFrame` from the store's
 * mutable `current`. Routing a 60 Hz pointer stream through React state instead
 * would re-render the whole scene tree on every pointer move.
 */
function ScrubMarker({
  frames,
  exaggeration,
  scrub,
}: {
  frames: TrackFrames;
  exaggeration: number;
  scrub: TrackScrubStore;
}) {
  const groupRef = useRef<Group>(null);
  const { camera } = useThree();

  const size = Math.max(3, frames.diagonal / 260);
  const ringGeometry = useMemo(() => new RingGeometry(0.62, 1, 28), []);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

  // Declared as JSX and mutated through a ref, matching `atmosphere.tsx`: the
  // opacity is written every frame, and anything produced during render is
  // frozen as far as React's compiler lint is concerned.
  const ringMaterial = useRef<MeshStandardMaterial>(null);

  useFrame(() => {
    const node = groupRef.current;
    const material = ringMaterial.current;
    if (!node || !material) return;
    const total = frames.length;
    const wrapped = (((scrub.current % total) + total) % total) / frames.spacing;
    const i = Math.min(frames.count - 1, Math.max(0, Math.round(wrapped)));
    node.position.set(
      frames.center[i * 3] + frames.normal[i * 3] * 0.6,
      frames.center[i * 3 + 1] * exaggeration + frames.normal[i * 3 + 1] * 0.6,
      frames.center[i * 3 + 2] + frames.normal[i * 3 + 2] * 0.6,
    );
    // Lie the ring flat on the road surface rather than facing the camera — a
    // billboarded disc floating over a banked corner breaks the illusion that it
    // is painted on the track. `up` must be the tangent, not the normal: lookAt
    // builds its basis from (direction x up), so an `up` parallel to the look
    // direction degenerates the matrix and the ring flickers or vanishes.
    node.up.set(
      frames.tangent[i * 3],
      frames.tangent[i * 3 + 1],
      frames.tangent[i * 3 + 2],
    );
    node.lookAt(
      node.position.x + frames.normal[i * 3],
      node.position.y + frames.normal[i * 3 + 1],
      node.position.z + frames.normal[i * 3 + 2],
    );

    // Fade out at close range. During a flythrough the camera rides ~14 m behind
    // this exact point, so the ring fills the lower half of the frame while
    // telling you nothing you cannot already see — the view *is* the playhead.
    const distance = camera.position.distanceTo(node.position);
    const near = size * 4;
    const far = size * 11;
    material.opacity =
      0.9 * Math.min(1, Math.max(0, (distance - near) / (far - near)));
    node.visible = material.opacity > 0.01;
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={ringGeometry} scale={size}>
        <meshStandardMaterial
          ref={ringMaterial}
          color="#fff1e0"
          emissive="#ff7a3d"
          emissiveIntensity={2.4}
          transparent
          opacity={0.9}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Shared scratch objects, so the camera rig allocates nothing per frame. */
export const scratch = {
  a: new Vector3(),
  b: new Vector3(),
  c: new Vector3(),
  matrix: new Matrix4(),
};

export type { Mesh };
