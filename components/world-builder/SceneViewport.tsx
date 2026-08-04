"use client";

import { useRef, useCallback, useMemo, useEffect, Suspense, useState, type ComponentProps } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, TransformControls, useGLTF, PerspectiveCamera, ContactShadows, Environment, Html } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette, HueSaturation, BrightnessContrast } from "@react-three/postprocessing";
import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { SceneObject } from "./scene-store";

// Area light needs initialization
try { RectAreaLightUniformsLib.init(); } catch {}
import type { SceneSettings } from "./SettingsModal";

const SNAP_THRESHOLD = 0.15;

/* ── Compute bounding box (excluding hitbox sphere) ── */
function getModelBox(group: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mat = (child as THREE.Mesh).material as THREE.Material;
    if (mat && (mat as any).opacity < 0.1) return; // Skip hitbox
    const mesh = child as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const meshBox = mesh.geometry.boundingBox!.clone();
    meshBox.applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  if (box.isEmpty()) box.setFromObject(group);
  return box;
}

/* ── Pure bounding-box snapping (AABB face-to-face alignment, no raycasting) ── */
function snapAABB(
  dragGroup: THREE.Object3D,
  otherGroups: THREE.Object3D[]
): void {
  if (otherGroups.length === 0) return;

  const _boxA = getModelBox(dragGroup);

  let bestY = Infinity, applyY = 0;
  let bestX = Infinity, applyX = 0;
  let bestZ = Infinity, applyZ = 0;

  for (const other of otherGroups) {
    const _boxB = getModelBox(other);

    // XZ overlap → can snap on Y (place on top/below)
    const hasXZ =
      _boxA.max.x > _boxB.min.x && _boxA.min.x < _boxB.max.x &&
      _boxA.max.z > _boxB.min.z && _boxA.min.z < _boxB.max.z;
    if (hasXZ) {
      const dyTop = _boxB.max.y - _boxA.min.y; // A's bottom against B's top
      if (Math.abs(dyTop) < SNAP_THRESHOLD && Math.abs(dyTop) < bestY) { bestY = Math.abs(dyTop); applyY = dyTop; }
      const dyBot = _boxB.min.y - _boxA.max.y; // A's top against B's bottom
      if (Math.abs(dyBot) < SNAP_THRESHOLD && Math.abs(dyBot) < bestY) { bestY = Math.abs(dyBot); applyY = dyBot; }
    }

    // YZ overlap → can snap on X (left/right alignment)
    const hasYZ =
      _boxA.max.y > _boxB.min.y && _boxA.min.y < _boxB.max.y &&
      _boxA.max.z > _boxB.min.z && _boxA.min.z < _boxB.max.z;
    if (hasYZ) {
      const dxR = _boxB.min.x - _boxA.max.x;
      if (Math.abs(dxR) < SNAP_THRESHOLD && Math.abs(dxR) < bestX) { bestX = Math.abs(dxR); applyX = dxR; }
      const dxL = _boxB.max.x - _boxA.min.x;
      if (Math.abs(dxL) < SNAP_THRESHOLD && Math.abs(dxL) < bestX) { bestX = Math.abs(dxL); applyX = dxL; }
    }

    // YX overlap → can snap on Z (front/back alignment)
    const hasYX =
      _boxA.max.y > _boxB.min.y && _boxA.min.y < _boxB.max.y &&
      _boxA.max.x > _boxB.min.x && _boxA.min.x < _boxB.max.x;
    if (hasYX) {
      const dzF = _boxB.min.z - _boxA.max.z;
      if (Math.abs(dzF) < SNAP_THRESHOLD && Math.abs(dzF) < bestZ) { bestZ = Math.abs(dzF); applyZ = dzF; }
      const dzB = _boxB.max.z - _boxA.min.z;
      if (Math.abs(dzB) < SNAP_THRESHOLD && Math.abs(dzB) < bestZ) { bestZ = Math.abs(dzB); applyZ = dzB; }
    }
  }

  const pos = dragGroup.position;
  if (bestY < Infinity) pos.y += applyY;
  if (bestX < Infinity) pos.x += applyX;
  if (bestZ < Infinity) pos.z += applyZ;
}

/* ── Collect refs of all other objects ── */
const groupRefs = new Map<string, THREE.Group>();

/* ── Area light component (imperative creation) ── */
function AreaLight({ color, intensity, width, height }: { color: string; intensity: number; width: number; height: number }) {
  const ref = useRef<THREE.Group>(null!);

  useEffect(() => {
    if (!ref.current) return;
    // Clean up old light
    ref.current.children.forEach((c) => {
      if ((c as any).isRectAreaLight) ref.current.remove(c);
    });
    const light = new THREE.RectAreaLight(color, intensity, width, height);
    ref.current.add(light);
    return () => { ref.current?.remove(light); light.dispose(); };
  }, [color, intensity, width, height]);

  return <group ref={ref} />;
}

/* ── Light scene object ── */
function LightSceneModel({
  obj,
  selected,
  onSelect,
  onPlace,
  placing,
  onTransformEnd,
}: {
  obj: SceneObject;
  selected: boolean;
  onSelect: () => void;
  onPlace: (point: [number, number, number]) => void;
  placing: boolean;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
}) {
  const groupRef = useRef<THREE.Group>(null!);
  const tcRef = useRef<any>(null);
  const [mounted, setMounted] = useState(false);
  const light = obj.light!;

  useEffect(() => {
    if (groupRef.current) groupRefs.set(obj.id, groupRef.current);
    setMounted(true);
    return () => { groupRefs.delete(obj.id); };
  }, [obj.id]);

  // Sphere display color matches the light color
  const helperColor = light.color;

  return (
    <>
      <group
        ref={groupRef}
        position={obj.position}
        rotation={obj.rotation}
      >
        {/* Light itself */}
        {light.type === "point" && (
          <pointLight color={light.color} intensity={light.intensity} distance={light.range} decay={2} />
        )}
        {light.type === "spot" && (
          <spotLight
            color={light.color}
            intensity={light.intensity}
            distance={light.range}
            angle={light.angle}
            penumbra={light.penumbra}
            decay={2}
          />
        )}
        {light.type === "area" && (
          <AreaLight color={light.color} intensity={light.intensity} width={light.width} height={light.height} />
        )}
        {light.type === "directional" && (
          <directionalLight color={light.color} intensity={light.intensity} />
        )}

        {/* Visualization sphere (for selection) */}
        <mesh
          onClick={(e) => {
            e.stopPropagation();
            if (placing) onPlace([e.point.x, e.point.y, e.point.z]);
            else onSelect();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <sphereGeometry args={[0.15, 12, 8]} />
          <meshBasicMaterial color={helperColor} transparent opacity={selected ? 1 : 0.6} />
        </mesh>

        {/* Area light visualization rectangle */}
        {light.type === "area" && (
          <mesh>
            <planeGeometry args={[light.width, light.height]} />
            <meshBasicMaterial color={helperColor} transparent opacity={0.15} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>

      {selected && groupRef.current && (
        <TransformControls
          ref={tcRef}
          object={groupRef.current}
          space="local"
          onMouseUp={() => {
            if (!groupRef.current) return;
            const p = groupRef.current.position;
            const r = groupRef.current.rotation;
            onTransformEnd(obj.id, [p.x, p.y, p.z], [r.x, r.y, r.z], [1, 1, 1]);
          }}
        />
      )}
    </>
  );
}

/* ── Single scene object ── */
function SceneModel({
  obj,
  selected,
  allObjects,
  placing,
  settings,
  onSelect,
  onPlace,
  onTransformEnd,
  onLoaded,
  characterLabel,
  onCharacterTap,
  motionEnabled,
}: {
  obj: SceneObject;
  selected: boolean;
  allObjects: SceneObject[];
  placing: boolean;
  settings: SceneSettings;
  onSelect: () => void;
  onPlace: (point: [number, number, number]) => void;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
  /** Character avatar: nameplate text above head */
  characterLabel?: string;
  /** Click nameplate → open character profile card */
  onCharacterTap?: () => void;
  /** Avatar wandering (has animation + setting enabled + within on-screen quota) */
  motionEnabled?: boolean;
  onLoaded: (id: string) => void;
}) {
  const { scene, animations } = useGLTF(obj.modelUrl);
  // Models with skeletal animation must use SkeletonUtils.clone (a regular clone won't remap bone references)
  const clone = useMemo(
    () => (animations?.length ? (skeletonClone(scene) as THREE.Group) : scene.clone(true)),
    [scene, animations],
  );

  useEffect(() => {
    onLoaded(obj.id);
  }, [obj.id, onLoaded, scene]);

  useEffect(() => {
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = settings.shadows;
        child.receiveShadow = settings.shadows;
        const mat = (child as THREE.Mesh).material;
        if (mat && !Array.isArray(mat)) {
          (mat as THREE.Material).side = settings.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
        }
      }
    });
  }, [clone, settings.shadows, settings.doubleSide]);
  const groupRef = useRef<THREE.Group>(null!);
  const tcRef = useRef<any>(null);

  // Compute bounding box, used as a transparent click hit area
  const hitBox = useMemo(() => {
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // At least 0.3 to ensure small objects can still be clicked
    size.x = Math.max(size.x, 0.3);
    size.y = Math.max(size.y, 0.3);
    size.z = Math.max(size.z, 0.3);
    return { size, center };
  }, [clone]);

  const [mounted, setMounted] = useState(false);
  const wanderActive = !!motionEnabled && !!animations?.length && !selected && !placing;

  // Register/unregister ref + force a second render so TransformControls appears
  useEffect(() => {
    if (groupRef.current) groupRefs.set(obj.id, groupRef.current);
    setMounted(true);
    return () => { groupRefs.delete(obj.id); };
  }, [obj.id]);

  // Real-time snapping while dragging
  useEffect(() => {
    if (!selected || !tcRef.current || !settings.snap) return;
    const tc = tcRef.current;
    const handleChange = () => {
      if (!groupRef.current) return;
      const others: THREE.Object3D[] = [];
      for (const [id, ref] of groupRefs) {
        if (id !== obj.id) others.push(ref);
      }
      snapAABB(groupRef.current, others);
    };
    tc.addEventListener("objectChange", handleChange);
    return () => tc.removeEventListener("objectChange", handleChange);
  }, [selected, obj.id, settings.snap]);

  return (
    <>
      <group
        ref={groupRef}
        position={obj.position}
        rotation={obj.rotation}
        scale={obj.scale}
      >
        {/* Wandering is a pure visual offset; R3F resets position via props when selected/wandering is disabled */}
        <primitive
          object={clone}
          onPointerDown={(e: any) => e.stopPropagation()}
          onClick={(e: any) => {
            e.stopPropagation();
            if (placing) {
              onPlace([e.point.x, e.point.y, e.point.z]);
            } else {
              onSelect();
            }
          }}
        />
        {wanderActive && (
          <AvatarWanderer
            group={groupRef}
            clone={clone}
            animations={animations}
            home={obj.position}
          />
        )}
        {characterLabel && (
          <Html
            center
            distanceFactor={8}
            position={[hitBox.center.x, hitBox.center.y + hitBox.size.y / 2 + 0.22, hitBox.center.z]}
            zIndexRange={[10, 0]}
          >
            <button
              type="button"
              className="wb-avatar-tag"
              onClick={(e) => { e.stopPropagation(); onCharacterTap?.(); }}
            >
              {characterLabel}
            </button>
          </Html>
        )}
      </group>
      {selected && groupRef.current && (
        <TransformControls
          ref={tcRef}
          object={groupRef.current}
          space="local"
          onMouseUp={() => {
            if (!groupRef.current) return;
            const p = groupRef.current.position;
            const r = groupRef.current.rotation;
            const sc = groupRef.current.scale;
            onTransformEnd(obj.id, [p.x, p.y, p.z], [r.x, r.y, r.z], [sc.x, sc.y, sc.z]);
          }}
        />
      )}
    </>
  );
}

/** Avatar wander controller: pick a random point within home radius → turn → walk over → idle, loop.
 *  Only moves the group's visual position, doesn't write back to scene data; R3F resets position via props on unmount. */
function AvatarWanderer({
  group,
  clone,
  animations,
  home,
}: {
  group: React.RefObject<THREE.Group>;
  clone: THREE.Object3D;
  animations: THREE.AnimationClip[];
  home: [number, number, number];
}) {
  const mixer = useMemo(() => new THREE.AnimationMixer(clone), [clone]);
  // Action start/stop must be paired inside the effect: StrictMode dev mode mounts→unmounts→
  // remounts; if play is in useMemo and stop is in cleanup, the action gets stopped on remount and nothing
  // replays it — this shows up as the avatar sliding (translating without playing the animation).
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const state = useRef({
    mode: "idle" as "idle" | "walk",
    timer: 1 + Math.random() * 2,
    target: new THREE.Vector3(home[0], home[1], home[2]),
    walkStartTime: 0,
    pivoting: false,
  });

  useEffect(() => {
    const source = animations.find((c) => /walk/i.test(c.name)) ?? animations[0];
    if (!source) return;
    // Strip the root bone translation track (root motion): Tripo's walk animation has its own Root.position
    // forward translation, which teleports back to the loop start at the end of each cycle; translation is now fully handled by the wander controller.
    // Filter after cloning to avoid polluting useGLTF's shared cache.
    const clip = source.clone();
    clip.tracks = clip.tracks.filter(
      (t) => !(t.name.endsWith(".position") && /(root|hips|pelvis|armature)/i.test(t.name)),
    );
    const a = mixer.clipAction(clip);
    // Key mechanism: when action weight < 1, the mixer fills the remaining weight with the "pose at bind time" —
    // i.e. the model's natural idle stance (Tripo's original bind pose). So idling = fadeOut
    // the weight to 0 (auto-returns to idle stance), and starting to walk = fadeIn (idle stance smoothly grows into a walking gait) — no need
    // to guess which frame to pause on. play() is called once to establish the binding (the original pose is snapshotted at this moment).
    a.play();
    a.setEffectiveWeight(0);

    // Sample to find a frame where both feet are grounded, to use as the starting phase (stepping off from a near-idle pose makes fadeIn smoother)
    let walkStartTime = 0;
    const feet: THREE.Object3D[] = [];
    clone.traverse((n) => { if (/foot/i.test(n.name) && feet.length < 2) feet.push(n); });
    if (feet.length === 2) {
      const fa = new THREE.Vector3();
      const fb = new THREE.Vector3();
      a.setEffectiveWeight(1);
      let best = Infinity;
      const steps = 48;
      for (let i = 0; i < steps; i++) {
        const t = (clip.duration * i) / steps;
        a.time = t;
        mixer.update(0);
        clone.updateMatrixWorld(true);
        feet[0].getWorldPosition(fa);
        feet[1].getWorldPosition(fb);
        const score = Math.max(fa.y, fb.y) + 0.3 * Math.hypot(fa.x - fb.x, fa.z - fb.z);
        if (score < best) { best = score; walkStartTime = t; }
      }
      // End of sampling: weight reset to 0 + apply one frame, bones return to original idle stance
      a.setEffectiveWeight(0);
      mixer.update(0);
    }
    state.current.walkStartTime = walkStartTime;
    actionRef.current = a;
    return () => {
      actionRef.current = null;
      a.stop();
      mixer.uncacheClip(clip);
    };
  }, [mixer, animations, clone]);

  const pickTarget = (st: typeof state.current) => {
    const angle = Math.random() * Math.PI * 2;
    const radius = 1.2 + Math.random() * 1.8;
    st.target.set(home[0] + Math.cos(angle) * radius, home[1], home[2] + Math.sin(angle) * radius);
  };

  useFrame((_, rawDelta) => {
    const g = group.current;
    if (!g) return;
    const delta = Math.min(rawDelta, 0.1); // Prevent teleporting after dropped frames / returning from background
    mixer.update(delta);
    const st = state.current;
    const a = actionRef.current;

    if (st.mode === "idle") {
      st.timer -= delta;
      if (st.timer <= 0) {
        pickTarget(st);
        st.mode = "walk";
        st.pivoting = true; // Turn to face the direction while standing still before stepping
      }
      return;
    }

    // walk: turn toward target + advance
    const pos = g.position;
    const dx = st.target.x - pos.x;
    const dz = st.target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.15) {
      // 40% chance to skip resting: pick the next target directly and keep walking (turning while walking), reducing the number of pauses
      if (Math.random() < 0.4) {
        pickTarget(st);
        return;
      }
      // Idle: weight fades out over 0.35s, bones automatically blend back to the original idle stance
      if (a) a.fadeOut(0.35);
      st.mode = "idle";
      st.timer = 1.9 + Math.random() * 2.5;
      return;
    }
    const targetYaw = Math.atan2(dx, dz);
    let yawDiff = targetYaw - g.rotation.y;
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    // Starting turn: quickly turn to face the direction while staying in idle stance (like a real person turning before walking)
    if (st.pivoting) {
      const pivotTurn = 5 * delta;
      g.rotation.y += Math.max(-pivotTurn, Math.min(pivotTurn, yawDiff));
      if (Math.abs(yawDiff) < 0.45) {
        st.pivoting = false;
        if (a) {
          // Start from the phase where both feet are grounded, weight fades in: idle stance smoothly grows into a walking gait.
          // Note: fadeIn multiplies the base weight by a 0→1 coefficient, so the base weight must first be restored to 1
          // (it was pushed to 0 with setEffectiveWeight(0) on mount); reset+play reactivates the action.
          a.setEffectiveWeight(1);
          a.reset();
          a.time = st.walkStartTime;
          a.timeScale = 1;
          a.fadeIn(0.25);
          a.play();
        }
      }
      return;
    }
    const maxTurn = 3.5 * delta;
    g.rotation.y += Math.max(-maxTurn, Math.min(maxTurn, yawDiff));
    // Turning while walking: forward speed scales with heading alignment; leg speed follows movement speed
    const align = Math.max(0, Math.cos(yawDiff));
    const speed = 0.6 * align;
    if (a) a.timeScale = 0.35 + 0.75 * align;
    pos.x += (dx / dist) * speed * delta;
    pos.z += (dz / dist) * speed * delta;
  });

  return null;
}

function ModelLoadingPlaceholder({ obj }: { obj: SceneObject }) {
  return (
    <group position={obj.position}>
      <mesh>
        <sphereGeometry args={[0.18, 24, 16]} />
        <meshBasicMaterial color="#f5c668" transparent opacity={0.72} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <ringGeometry args={[0.32, 0.42, 36]} />
        <meshBasicMaterial color="#f5c668" transparent opacity={0.28} side={THREE.DoubleSide} />
      </mesh>
      <Html center distanceFactor={8} position={[0, 0.45, 0]}>
        <div className="wb-model-loading-label">Loading {obj.name}</div>
      </Html>
    </group>
  );
}

/**
 * First render the sphere placeholder for one frame, then mount the actual model (start loading/parsing the GLB).
 * Otherwise, on low-end Android, model loading synchronously blocks the main thread, and the placeholder frame doesn't get a chance to render,
 * so the model just pops in — no loading transition is visible. Defer ~2 frames to give the browser a window to paint the placeholder.
 */
function DeferredSceneModel(props: ComponentProps<typeof SceneModel>) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => setReady(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, []);
  if (!ready) return <ModelLoadingPlaceholder obj={props.obj} />;
  return (
    <Suspense fallback={<ModelLoadingPlaceholder obj={props.obj} />}>
      <SceneModel {...props} />
    </Suspense>
  );
}

/* ── Transparent click plane (only for placement, doesn't block raycasts to objects) ── */
function Ground({ onClickGround }: { onClickGround: (point: [number, number, number]) => void }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.01, 0]}
      onClick={(e) => {
        // Don't stopPropagation — let the object's onClick take priority
        onClickGround([e.point.x, 0, e.point.z]);
      }}
    >
      <planeGeometry args={[500, 500]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Controls() {
  return (
    <OrbitControls
      makeDefault
      enableDamping
      dampingFactor={0.1}
      minPolarAngle={Math.PI / 8}
      maxPolarAngle={Math.PI / 2.05}
      minDistance={3}
      maxDistance={80}
    />
  );
}

/* ── Main viewport ── */
export default function SceneViewport({
  objects,
  selectedId,
  placingModel,
  settings,
  onSelect,
  onPlace,
  onTransformEnd,
  onSceneMounted,
  characterNameById,
  onCharacterTap,
}: {
  objects: SceneObject[];
  selectedId: string | null;
  placingModel: { url: string; name: string } | null;
  settings: SceneSettings;
  onSelect: (id: string | null) => void;
  onPlace: (position: [number, number, number]) => void;
  onTransformEnd: (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => void;
  onSceneMounted?: () => void;
  /** Character avatar nameplate: characterId → name */
  characterNameById?: Map<string, string>;
  onCharacterTap?: (characterId: string) => void;
}) {
  const loadedObjectIdsRef = useRef(new Set<string>());
  const [loadingObjects, setLoadingObjects] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!onSceneMounted) return;
    const frame = window.requestAnimationFrame(onSceneMounted);
    return () => window.cancelAnimationFrame(frame);
  }, [onSceneMounted]);

  useEffect(() => {
    const liveIds = new Set(objects.map((obj) => obj.id));
    for (const id of Array.from(loadedObjectIdsRef.current)) {
      if (!liveIds.has(id)) loadedObjectIdsRef.current.delete(id);
    }
    setLoadingObjects((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const obj of objects) {
        if (obj.light || loadedObjectIdsRef.current.has(obj.id)) continue;
        next[obj.id] = obj.name;
        if (prev[obj.id] !== obj.name) changed = true;
      }
      if (Object.keys(prev).length !== Object.keys(next).length) changed = true;
      return changed ? next : prev;
    });
  }, [objects]);

  const handleModelLoaded = useCallback((id: string) => {
    loadedObjectIdsRef.current.add(id);
    setLoadingObjects((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const handleClickGround = useCallback(
    (point: [number, number, number]) => {
      if (placingModel) {
        onPlace(point);
      } else {
        onSelect(null);
      }
    },
    [placingModel, onPlace, onSelect]
  );

  const loadingModelNames = Object.values(loadingObjects);

  return (
    <div className="wb-viewport" style={{
      cursor: placingModel ? "crosshair" : "default",
      background: settings.theme,
    }}>
      <Canvas
        // Cap the pixel ratio: high-DPI phones default to DPR=3 → 9x the framebuffer pixels, which blows out VRAM and crashes weak devices.
        // Clamping to 1.5 cuts the load to about 1/4; the 3D image is only slightly softer. This is the single most important crash-prevention fix (applies to all devices).
        dpr={[1, 1.5]}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2, alpha: true }}
        shadows={settings.shadows}
        onPointerMissed={() => onSelect(null)}
      >
        <PerspectiveCamera makeDefault fov={40} position={[8, 6, 8]} />
        <Controls />

        {/* ── Lighting (affected by global brightness/color temperature) ── */}
        <ambientLight
          intensity={0.4 * settings.globalBrightness}
          color={new THREE.Color().lerpColors(
            new THREE.Color("#ccdaff"), new THREE.Color("#ffcc88"),
            (settings.globalWarmth + 1) / 2
          )}
        />
        <hemisphereLight args={[
          new THREE.Color().lerpColors(
            new THREE.Color("#aabbff"), new THREE.Color("#ffd5aa"),
            (settings.globalWarmth + 1) / 2
          ),
          "#665544",
          0.3 * settings.globalBrightness
        ]} />
        <directionalLight
          position={[5, 8, 5]}
          intensity={2.0 * settings.globalBrightness}
          color={new THREE.Color().lerpColors(
            new THREE.Color("#cce0ff"), new THREE.Color("#ffe0aa"),
            (settings.globalWarmth + 1) / 2
          )}
          castShadow={settings.shadows}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-far={50}
          shadow-camera-left={-20}
          shadow-camera-right={20}
          shadow-camera-top={20}
          shadow-camera-bottom={-20}
          shadow-bias={-0.0003}
        />
        <directionalLight position={[-4, 4, 2]} intensity={0.5 * settings.globalBrightness} color="#eee8e0" />

        {/* HDRI is only used for PBR reflections */}
        {settings.hdri && (
          <Suspense fallback={null}>
            <Environment files="/hdri/park.hdr" />
          </Suspense>
        )}

        {/* ── Ground ── */}
        <Ground onClickGround={handleClickGround} />

        {/* Post-processing */}
        {settings.bloom && (
          <EffectComposer enableNormalPass={false}>
            <Bloom luminanceThreshold={0.8} intensity={0.2} mipmapBlur />
          </EffectComposer>
        )}

        {(() => {
          // Performance quota: at most 3 avatars wander on screen at once, the rest stay in figurine (static) state
          const motionQuota = new Set(
            objects.filter((o) => o.characterId && !o.light).slice(0, 3).map((o) => o.id)
          );
          return objects.map((obj) => (
          obj.light ? (
            <LightSceneModel
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              placing={!!placingModel}
              onSelect={() => onSelect(obj.id)}
              onPlace={handleClickGround}
              onTransformEnd={onTransformEnd}
            />
          ) : (
            <DeferredSceneModel
              key={obj.id}
              obj={obj}
              selected={obj.id === selectedId}
              allObjects={objects}
              placing={!!placingModel}
              settings={settings}
              onSelect={() => onSelect(obj.id)}
              onPlace={handleClickGround}
              onTransformEnd={onTransformEnd}
              onLoaded={handleModelLoaded}
              characterLabel={obj.characterId ? (characterNameById?.get(obj.characterId) ?? "Unknown Character") : undefined}
              onCharacterTap={obj.characterId ? () => onCharacterTap?.(obj.characterId!) : undefined}
              motionEnabled={settings.avatarMotion !== false && motionQuota.has(obj.id)}
            />
          )
        ));
        })()}
      </Canvas>

      {placingModel && (
        <div className="wb-placing-hint">
          Click the ground to place "{placingModel.name}" · Press Esc to cancel
        </div>
      )}
      {loadingModelNames.length > 0 && (
        <div className="wb-model-loading-toast" role="status" aria-live="polite">
          <span className="wb-thumb-loading" aria-hidden="true" />
          <span>
            Loading "{loadingModelNames[0]}"
            {loadingModelNames.length > 1 ? ` and ${loadingModelNames.length} more models` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
