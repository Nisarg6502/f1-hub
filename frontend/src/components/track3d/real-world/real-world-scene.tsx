"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useThree } from "@react-three/fiber";
import {
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Object3D,
  SRGBColorSpace,
  TubeGeometry,
} from "three";

import type { TrackCorner } from "@/lib/circuit-geometry";
import { SkyDome, type SkyPalette } from "../atmosphere";
import CornerMarkers from "../corner-markers";
import { ScrubMarker } from "../track-scene";
import type { TrackGeometryBundle, TrackScrubStore } from "../use-track-geometry";
import { buildBuildings, buildTerrain, buildTrees } from "./build-real-world";
import type { RealWorldData } from "./load-real-world";

/**
 * A clear afternoon, kept a few stops under a real one. The rest of APEX is a
 * dark warm UI, and a saturated midday sky behind a glass panel looks like a
 * different product; this is bright enough that the photo reads as daylight
 * without the panel glowing.
 */
const DAY_SKY: SkyPalette = {
  horizon: "#b9c6d3",
  zenith: "#3d5f8c",
  // Below the horizon is the app's own near-black, not more sky: from the
  // overview you are looking DOWN at the slab, and it should sit on the page
  // like a lit model on a dark table, the way the schematic view does.
  ground: "#12100e",
};

/**
 * Fade the track tint out close to the camera.
 *
 * From across the circuit a 30% orange wash is what lets you find the lap in
 * the photo. From the chase camera the same wash sits directly under you and
 * turns the tarmac you came to look at into a brown carpet. `1 / gl_FragCoord.w`
 * is view-space depth under a perspective projection, so this needs no uniform.
 */
function fadeTintNearCamera(shader: { fragmentShader: string }) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <opaque_fragment>",
    `diffuseColor.a *= smoothstep(60.0, 420.0, 1.0 / gl_FragCoord.w);
    #include <opaque_fragment>`,
  );
}

export interface RealWorldSceneProps {
  data: RealWorldData;
  /** Built from the DRAPED payload, at true width. */
  bundle: TrackGeometryBundle;
  exaggeration: number;
  showBuildings: boolean;
  showTrees: boolean;
  /** Tint the racing surface so the layout can be picked out of the photo. */
  showTrackTint: boolean;
  showRaceline: boolean;
  showCorners: boolean;
  activeCornerName?: string | null;
  onSelectCorner?: (corner: TrackCorner) => void;
  onHoverDistance?: (metres: number | null) => void;
  scrub: TrackScrubStore;
}

/**
 * The circuit as it actually is: satellite imagery draped over a DEM, with
 * OpenStreetMap buildings and woodland stood on top.
 *
 * Lighting is balanced so flat, sunlit ground comes out at the photo's own
 * brightness (hemisphere + sun·cosθ ≈ π, since three's Lambert term divides by
 * π). The photo already carries the real sun's shading; the lights here exist to
 * shade the things the photo cannot — walls, canopies and the shadows they cast.
 */
export default function RealWorldScene({
  data,
  bundle,
  exaggeration,
  showBuildings,
  showTrees,
  showTrackTint,
  showRaceline,
  showCorners,
  activeCornerName,
  onSelectCorner,
  onHoverDistance,
  scrub,
}: RealWorldSceneProps) {
  const { frames, payload } = bundle;
  const { scene, gl } = useThree();
  const zRef = payload.z_ref_m;

  const texture = useMemo(() => {
    const map = new CanvasTexture(data.imagery);
    map.colorSpace = SRGBColorSpace;
    map.generateMipmaps = true;
    map.minFilter = LinearMipmapLinearFilter;
    // Without anisotropy the photo smears into mush at the grazing angles the
    // chase camera spends its whole life at.
    map.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
    return map;
  }, [data.imagery, gl]);
  useEffect(() => () => texture.dispose(), [texture]);

  const terrain = useMemo(() => buildTerrain(data, zRef), [data, zRef]);
  useEffect(
    () => () => {
      terrain.surface.dispose();
      terrain.skirt.dispose();
    },
    [terrain],
  );

  const buildings = useMemo(() => buildBuildings(data, zRef), [data, zRef]);
  useEffect(
    () => () => {
      buildings?.roofs.dispose();
      buildings?.walls.dispose();
    },
    [buildings],
  );

  const trees = useMemo(() => buildTrees(data, payload, zRef), [data, payload, zRef]);
  // Low-poly on purpose: thousands of smooth spheres would cost more than the
  // rest of the scene put together, twice over once the shadow pass runs. The
  // very largest forests drop to a bare icosahedron to stay inside that.
  const treeGeometry = useMemo(
    () => new IcosahedronGeometry(1, trees && trees.count <= 6000 ? 1 : 0),
    [trees],
  );
  useEffect(() => () => treeGeometry.dispose(), [treeGeometry]);

  const treesRef = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = treesRef.current;
    if (!mesh || !trees) return;
    const dummy = new Object3D();
    const color = new Color();
    for (let i = 0; i < trees.count; i += 1) {
      const radius = trees.transforms[i * 5 + 3];
      const height = trees.transforms[i * 5 + 4];
      dummy.position.set(
        trees.transforms[i * 5],
        trees.transforms[i * 5 + 1] + height * 0.56,
        trees.transforms[i * 5 + 2],
      );
      dummy.scale.set(radius, height * 0.5, radius);
      dummy.rotation.y = i * 2.399963; // golden angle: no two neighbours aligned
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setRGB(trees.colors[i * 3], trees.colors[i * 3 + 1], trees.colors[i * 3 + 2]);
      mesh.setColorAt(i, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [trees, showTrees]);

  const racelineGeometry = useMemo(() => {
    if (!bundle.raceline) return null;
    return new TubeGeometry(bundle.raceline, 900, 0.22, 6, true);
  }, [bundle.raceline]);
  useEffect(() => () => racelineGeometry?.dispose(), [racelineGeometry]);

  // --- framing: everything below is sized from the scenery rectangle --------
  const { bounds } = data;
  const centreX = (bounds.e_min_m + bounds.e_max_m) / 2;
  const centreZ = -(bounds.n_min_m + bounds.n_max_m) / 2;
  const radius =
    Math.hypot(bounds.e_max_m - bounds.e_min_m, bounds.n_max_m - bounds.n_min_m) / 2;
  const groundY = (data.dem.min - zRef) * exaggeration;

  // The real sun is in the southern sky north of the equator and vice versa.
  // Matching that keeps our cast shadows falling the same way as the ones
  // already baked into the photo, instead of crossing them.
  const sunDirection = useMemo(() => {
    const towardsEquator = data.origin.lat >= 0 ? 1 : -1; // +z is south
    const x = 0.48;
    const y = 0.78;
    const z = 0.55 * towardsEquator;
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length] as const;
  }, [data.origin.lat]);

  const sunRef = useRef<DirectionalLight>(null);
  useEffect(() => {
    const sun = sunRef.current;
    if (!sun) return;
    const reach = radius * 1.6;
    sun.position.set(
      centreX + sunDirection[0] * reach,
      groundY + sunDirection[1] * reach,
      centreZ + sunDirection[2] * reach,
    );
    sun.target.position.set(centreX, groundY, centreZ);
    scene.add(sun.target);
    sun.target.updateMatrixWorld();

    const camera = sun.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = 1;
    camera.far = reach * 2.2;
    camera.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
    return () => {
      scene.remove(sun.target);
    };
  }, [scene, centreX, centreZ, groundY, radius, sunDirection]);

  // Corner labels raycast for occlusion every frame. Pointing them at the
  // buildings alone keeps that to a few thousand triangles; the terrain and
  // seven thousand tree instances would make it the most expensive thing here.
  const occluderRef = useRef<Group>(null);
  const occluders = useMemo(() => [occluderRef as RefObject<Object3D>], []);

  return (
    <>
      <SkyDome radius={frames.diagonal * 4} palette={DAY_SKY} />
      {/* A thin haze, tied to the horizon colour, so the far edge of the slab
          softens instead of ending on a hard line against the sky. Attached
          declaratively so r3f detaches it again when this scene unmounts. */}
      <fog attach="fog" args={[DAY_SKY.horizon, radius * 2.4, radius * 11]} />

      <hemisphereLight args={["#e6eefa", "#857c6c", 1.5]} />
      <directionalLight
        ref={sunRef}
        color="#fff3e0"
        intensity={2.5}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-bias={-0.0005}
        shadow-normalBias={0.9}
      />

      <group scale={[1, exaggeration, 1]}>
        <mesh geometry={terrain.surface} receiveShadow>
          <meshStandardMaterial map={texture} roughness={1} metalness={0} toneMapped={false} />
        </mesh>
        <mesh geometry={terrain.skirt}>
          <meshBasicMaterial color="#231d18" side={DoubleSide} toneMapped={false} />
        </mesh>

        <group ref={occluderRef} visible={showBuildings}>
          {buildings && (
            <>
              <mesh geometry={buildings.roofs} castShadow receiveShadow>
                <meshStandardMaterial
                  map={texture}
                  roughness={1}
                  metalness={0}
                  side={DoubleSide}
                  toneMapped={false}
                />
              </mesh>
              <mesh geometry={buildings.walls} castShadow receiveShadow>
                <meshStandardMaterial
                  vertexColors
                  roughness={0.95}
                  metalness={0}
                  side={DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            </>
          )}
        </group>

        {showTrees && trees && (
          <instancedMesh
            ref={treesRef}
            args={[treeGeometry, undefined, trees.count]}
            castShadow
            receiveShadow
          >
            <meshStandardMaterial roughness={1} metalness={0} flatShading toneMapped={false} />
          </instancedMesh>
        )}

        {/*
          The racing surface, as a tint over the photographed tarmac rather than
          a replacement for it. Always mounted, even at zero opacity: hovering
          it is what drives the playhead on the elevation profile, and that
          should not stop working because the tint is switched off.
        */}
        <mesh
          geometry={bundle.ribbon}
          position={[0, 0.35, 0]}
          renderOrder={2}
          onPointerMove={(event) => {
            if (!onHoverDistance) return;
            event.stopPropagation();
            const attribute = bundle.ribbon.getAttribute("aDist");
            const vertex = event.face?.a;
            if (attribute && vertex !== undefined) onHoverDistance(attribute.getX(vertex));
          }}
          onPointerOut={() => onHoverDistance?.(null)}
        >
          <meshBasicMaterial
            color="#ff6a2a"
            transparent
            opacity={showTrackTint ? 0.3 : 0}
            depthWrite={false}
            side={DoubleSide}
            polygonOffset
            polygonOffsetFactor={-2}
            polygonOffsetUnits={-2}
            toneMapped={false}
            onBeforeCompile={fadeTintNearCamera}
          />
        </mesh>

        {showRaceline && racelineGeometry && (
          <mesh geometry={racelineGeometry} position={[0, 0.3, 0]}>
            <meshBasicMaterial color="#fff1e0" toneMapped={false} />
          </mesh>
        )}
      </group>

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
