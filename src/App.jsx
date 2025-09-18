import React, {
  useMemo,
  useRef,
  useState,
  useEffect,
  Suspense,
  useCallback,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  useGLTF,
  Environment,
  Html,
  Clone,
  useProgress,
} from "@react-three/drei";
import * as THREE from "three";

/**
 * Heroes-like minimal tactics prototype
 * Tech: React + Vite + Three.js (via @react-three/fiber) + TailwindCSS
 *
 * Features:
 * - Fullscreen arena, rotatable with mouse (OrbitControls)
 * - Grid-based movement with range highlight
 * - Player vs AI turns. A unit acts once per round; when all have acted => switch turn
 * - Auto-attack when adjacent (4-neighborhood). Smooth move (jumping) + attack animation
 * - End Turn button lights up when all player units used their moves
 * - Victory/Defeat overlay
 * - GLB models per unit (with graceful fallback to primitive mesh if unavailable)
 *
 * How to use:
 * - Click a player unit to select.
 * - Green cells show reachable tiles.
 * - Click a reachable cell to move; if ends adjacent to an enemy, it attacks.
 * - After all player units have moved, click "Конец хода" to pass to AI.
 */

// --------------------------- Config ---------------------------
const GRID_COLS = 10;
const GRID_ROWS = 8;
const TILE_SIZE = 1.2; // world units
const MODEL_Y_OFFSET = 0.6; // поднять модель над плиткой (в юнитах мира)

const ATTACK_IMPACT_MS = 100; // delay before damage is applied to match attack animation impact
const HEAL_IMPACT_MS = 100; // delay before heal is applied to match heal animation impact
const MODEL_ROT_Y = Math.PI / 2; // поворот модели по оси Y (90°)

// Death animation timing
const DEATH_FALL_SEC = 0.4; // time to fall over
const DEATH_FADE_SEC = 0.4; // time to dissolve after falling
const DEATH_REMOVE_MS = Math.round((DEATH_FALL_SEC + DEATH_FADE_SEC) * 1000);

// Example models (public/*) — make paths relative to BASE_URL for Electron file://
const BASE = import.meta.env.BASE_URL || './'
const PLAYER_HERO = `${BASE}models/angel.glb`; // main player model
const PLAYER_KNIGHT = `${BASE}models/knight.glb`;
const PLAYER_ARCHER = `${BASE}models/archer.glb`;
const PLAYER_MAGE = `${BASE}models/mage.glb`;
const PLAYER_RIDER = `${BASE}models/rider.glb`;

const ENEMY_DARK_KING = `${BASE}models/devil-king.glb`;
const ENEMY_ASSASSIN = `${BASE}models/assassin.glb`;
const ENEMY_DEVIL = `${BASE}models/devil.glb`;
const ENEMY_SKUL = `${BASE}models/skul.glb`;

// Main soundtrack (place your file in /public/audio)
const MUSIC_URL = `${BASE}audio/battle.mp3`;

// Sound effects (place your files in /public/audio)
const SFX_HIT = `${BASE}audio/hit.mp3`;
const SFX_HEAL = `${BASE}audio/heal.mp3`;
const SFX_MOVE = `${BASE}audio/move.mp3`;
const SFX_FALL = `${BASE}audio/fall.mp3`;
const SFX_VICTORY = `${BASE}audio/victory.mp3`;
const SFX_FAIL = `${BASE}audio/fail.mp3`;
const SFX_TURN = `${BASE}audio/turn.mp3`;

// Utility helpers
const key = (x, y) => `${x},${y}`;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
// Check adjacency (4-directional)

const neighbors4 = (p) => [
  { x: p.x + 1, y: p.y },
  { x: p.x - 1, y: p.y },
  { x: p.x, y: p.y + 1 },
  { x: p.x, y: p.y - 1 },
];

// Random integer helper (inclusive)
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// BFS for movement range (no obstacles through units, but you can step on empty cells)
function reachable(start, maxSteps, occupied) {
  const frontier = [{ ...start, d: 0 }];
  const seen = new Set([key(start.x, start.y)]);
  const out = new Set();
  while (frontier.length) {
    const cur = frontier.shift();
    if (cur.d > 0) out.add(key(cur.x, cur.y));
    if (cur.d === maxSteps) continue;
    for (const n of neighbors4(cur)) {
      const nk = key(n.x, n.y);
      if (
        n.x < 0 ||
        n.y < 0 ||
        n.x >= GRID_COLS ||
        n.y >= GRID_ROWS ||
        seen.has(nk) ||
        occupied.has(nk)
      )
        continue;
      seen.add(nk);
      frontier.push({ ...n, d: cur.d + 1 });
    }
  }
  return out;
}

// --------------------------- Models ---------------------------
function FallbackMesh({ color = "#4ade80" }) {
  return (
    <mesh castShadow receiveShadow>
      <capsuleGeometry args={[0.3, 0.6, 8, 16]} />
      <meshStandardMaterial color={color} roughness={0.6} metalness={0.1} />
    </mesh>
  );
}

function GLTFModel({ url, tintColor }) {
  const gltf = useGLTF(url);
  const ref = useRef();

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.traverse((obj) => {
      if (obj.isMesh && obj.material) {
        // Ensure unique material instance per mesh so tinting doesn't leak
        if (!obj.material.userData._prepared) {
          obj.material = obj.material.clone();
          obj.material.userData._prepared = true;
          if (obj.material.color) {
            obj.material.userData._origColor = obj.material.color.clone();
          }
          obj.material.userData._origOpacity = obj.material.opacity ?? 1;
          obj.material.userData._origTransparent =
            obj.material.transparent ?? false;
        }
        // Apply or reset tint
        if (tintColor && obj.material.color) {
          obj.material.color.set(tintColor);
        } else if (obj.material.userData._origColor && obj.material.color) {
          obj.material.color.copy(obj.material.userData._origColor);
        }
      }
    });
  }, [tintColor]);

  return <Clone ref={ref} object={gltf.scene} scale={0.6} />;
}

function UnitModel({ url, color = "#4ade80", tintColor }) {
  if (!url || url.trim().length === 0) return <FallbackMesh color={color} />;
  return (
    <Suspense fallback={<FallbackMesh color={color} />}>
      <GLTFModel url={url} tintColor={tintColor} />
    </Suspense>
  );
}

// --------------------------- Unit component with animation ---------------------------
function Unit({
  unit,
  isSelected,
  worldPos,
  onClick,
  animState,
  onPointerOver,
  onPointerOut,
  isAttackableEnemy,
  isHoveredEnemy,
  isHealableAlly,
  isHoveredAlly,
  hitReaction,
  floatTexts = [],
}) {
  const ref = useRef();
  const modelRef = useRef();
  const startTime = useRef(0);
  const idlePhase = useRef(Math.random() * Math.PI * 2);

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.getElapsedTime();

    // compute target position (with optional hit reaction offset)
    const targetPos = worldPos.clone();
    if (hitReaction && hitReaction.started != null) {
      const elapsed = t - hitReaction.started;
      const duration = hitReaction.duration ?? 0.1; // seconds
      if (elapsed >= 0 && elapsed <= duration) {
        const k = Math.sin((elapsed / duration) * Math.PI); // out-and-back
        const amp = 0.25; // world units
        const dx = (hitReaction.dir?.x ?? 0) * k * amp;
        const dz = (hitReaction.dir?.z ?? 0) * k * amp;
        targetPos.x += dx;
        targetPos.z += dz;
      }
    }

    // smooth position lerp
    ref.current.position.lerp(targetPos, 0.2);

    // Basic animations layered on top
    if (unit.dying && unit.hp <= 0) {
      // Death: fall backward relative to facing, then dissolve
      const t0 = unit.deathStarted ?? performance.now() / 1000;
      const elapsed = Math.max(0, t - t0);
      // 1) fall (always backwards relative to facing)
      const fallK = Math.min(1, elapsed / DEATH_FALL_SEC);
      const fallAngle = fallK * (Math.PI / 2); // 90° back fall
      if (modelRef.current) {
        const targetX = -fallAngle; // tip onto the back
        const targetZ = 0; // no sideways roll
        modelRef.current.rotation.x = THREE.MathUtils.lerp(
          modelRef.current.rotation.x,
          targetX,
          0.25
        );
        modelRef.current.rotation.z = THREE.MathUtils.lerp(
          modelRef.current.rotation.z,
          targetZ,
          0.25
        );
      }
      // sink a bit as we fall so it feels like hitting the ground
      const sink = Math.min(0.25, fallK * 0.25);
      ref.current.position.y = targetPos.y - sink;

      // 2) fade
      const fadeK = Math.min(
        1,
        Math.max(0, (elapsed - DEATH_FALL_SEC) / DEATH_FADE_SEC)
      );
      if (modelRef.current) {
        modelRef.current.traverse((obj) => {
          if (obj.isMesh && obj.material) {
            obj.material.transparent = true;
            obj.material.opacity = THREE.MathUtils.lerp(
              obj.material.opacity ?? 1,
              1 - fadeK,
              0.3
            );
            obj.material.needsUpdate = true;
          }
        });
      }
    } else if (animState.type === "move") {
      // Little jump while moving
      const jump = Math.abs(Math.sin(t * 10)) * 0.2;
      ref.current.position.y = targetPos.y + jump;
      // relax any temporary model tilts
      if (modelRef.current) {
        modelRef.current.rotation.x = THREE.MathUtils.lerp(
          modelRef.current.rotation.x,
          0,
          0.2
        );
        modelRef.current.rotation.z = THREE.MathUtils.lerp(
          modelRef.current.rotation.z,
          0,
          0.2
        );
      }
    } else if (animState.type === "attack") {
      // Directional lean -> now just forward/back pitch
      const p = ((t - startTime.current) % 0.4) / 0.4;
      const lean = Math.sin(p * Math.PI) * 0.35; // up to ~20°
      if (modelRef.current) {
        const targetX = -lean; // forward = negative pitch
        const targetZ = 0; // no roll
        modelRef.current.rotation.x = THREE.MathUtils.lerp(
          modelRef.current.rotation.x,
          targetX,
          0.4
        );
        modelRef.current.rotation.z = THREE.MathUtils.lerp(
          modelRef.current.rotation.z,
          targetZ,
          0.4
        );
        // restore opacity in case it was altered before
        modelRef.current.traverse((obj) => {
          if (
            obj.isMesh &&
            obj.material &&
            obj.material.userData &&
            obj.material.userData._origOpacity != null
          ) {
            const targetOpacity = 1;
            obj.material.opacity = THREE.MathUtils.lerp(
              obj.material.opacity ?? 1,
              targetOpacity,
              0.3
            );
          }
        });
      }
      const s = p < 0.5 ? 1 + p * 0.25 : 1.125 - (p - 0.5) * 0.5;
      ref.current.scale.setScalar(
        THREE.MathUtils.lerp(ref.current.scale.x, s, 0.4)
      );
    } else if (animState.type === "heal") {
      const p = ((t - startTime.current) % 0.6) / 0.6;
      const s = 1 + Math.sin(p * Math.PI) * 0.2; // gentle pulse
      ref.current.scale.setScalar(
        THREE.MathUtils.lerp(ref.current.scale.x, s, 0.3)
      );
      // relax model tilt
      if (modelRef.current) {
        modelRef.current.rotation.x = THREE.MathUtils.lerp(
          modelRef.current.rotation.x,
          0,
          0.2
        );
        modelRef.current.rotation.z = THREE.MathUtils.lerp(
          modelRef.current.rotation.z,
          0,
          0.2
        );
      }
    } else {
      // idle subtle breathing + relax tilt and opacity
      const breathe = Math.sin(t * 1.5 + idlePhase.current) * 0.02;
      ref.current.position.y = targetPos.y + breathe;
      ref.current.scale.setScalar(
        THREE.MathUtils.lerp(ref.current.scale.x, 1, 0.1)
      );
      if (modelRef.current) {
        modelRef.current.rotation.x = THREE.MathUtils.lerp(
          modelRef.current.rotation.x,
          0,
          0.1
        );
        modelRef.current.rotation.z = THREE.MathUtils.lerp(
          modelRef.current.rotation.z,
          0,
          0.1
        );
        modelRef.current.traverse((obj) => {
          if (obj.isMesh && obj.material && obj.material.userData) {
            if (obj.material.userData._origOpacity != null) {
              obj.material.transparent =
                obj.material.userData._origTransparent ??
                obj.material.transparent;
              obj.material.opacity = THREE.MathUtils.lerp(
                obj.material.opacity ?? 1,
                1,
                0.15
              );
            }
          }
        });
      }
    }
  });

  useEffect(() => {
    startTime.current = performance.now() / 1000;
  }, [animState.type]);

  const yOffset = unit.modelOffsetY ?? MODEL_Y_OFFSET;
  const rotY =
    (unit.modelRotY ?? MODEL_ROT_Y) + (unit.team === "enemy" ? Math.PI : 0);

  return (
    <group
      ref={ref}
      position={worldPos}
      onClick={(e) => {
        if (unit.hp <= 0 || unit.dying) return;
        onClick && onClick(e);
      }}
      onPointerOver={(e) => {
        if (unit.hp <= 0 || unit.dying) return;
        onPointerOver && onPointerOver(e);
      }}
      onPointerOut={(e) => {
        if (unit.hp <= 0 || unit.dying) return;
        onPointerOut && onPointerOut(e);
      }}
    >
      <group ref={modelRef} position={[0, yOffset, 0]} rotation={[0, rotY, 0]}>
        <UnitModel
          url={unit.modelUrl}
          color={unit.team === "player" ? "#22c55e" : "#ef4444"}
          tintColor={
            unit.team === "enemy" && isHoveredEnemy && isAttackableEnemy
              ? "#ef4444"
              : unit.team === "player" && isHoveredAlly && isHealableAlly
              ? "#86efac"
              : null
          }
        />
      </group>
      {/* Selection ring (hidden during death) */}
      {!(unit.dying && unit.hp <= 0) && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.01, 0]}>
          <ringGeometry args={[0.35, 0.4, 24]} />
          <meshBasicMaterial
            color={
              isAttackableEnemy && isHoveredEnemy
                ? "#ef4444"
                : isHealableAlly && isHoveredAlly
                ? "#22c55e"
                : isSelected
                ? "#22c55e"
                : unit.team === "player"
                ? "#84cc16"
                : "#f87171"
            }
          />
        </mesh>
      )}
      {unit.team === "enemy" && !(unit.dying && unit.hp <= 0) && (
        <mesh
          position={[0, 0.4, 0]}
          onPointerOver={onPointerOver}
          onPointerOut={onPointerOut}
        >
          <cylinderGeometry args={[0.6, 0.6, 1, 16]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {/* Floating HP text */}
      {floatTexts.map((ft) => (
        <Html
          key={ft.id}
          position={[0, (unit.modelOffsetY ?? MODEL_Y_OFFSET) + 1.0, 0]}
          center
        >
          <div
            style={{
              pointerEvents: "none",
              fontWeight: 700,
              opacity: 0.95,
              transform: "translateY(-6px)",
            }}
            className={`px-2 py-1 rounded-lg text-sm shadow-md ${
              ft.kind === "heal"
                ? "bg-emerald-600/80 text-white"
                : "bg-rose-600/80 text-white"
            }`}
          >
            {ft.kind === "heal" ? "+" : "-"}
            {ft.amount}
            <span className="ml-1">hp</span>
          </div>
        </Html>
      ))}
    </group>
  );
}

// --------------------------- Grid & Highlight ---------------------------
function Grid({ onTileClick, highlights, occupiedMap }) {
  const tiles = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      const worldX = (x - GRID_COLS / 2 + 0.5) * TILE_SIZE;
      const worldZ = (y - GRID_ROWS / 2 + 0.5) * TILE_SIZE;
      const k = key(x, y);
      const isHighlight = highlights.has(k);
      const isOccupied = occupiedMap.has(k);
      tiles.push(
        <group key={k} position={[worldX, 0, worldZ]}>
          <mesh
            receiveShadow
            onClick={(e) => {
              e.stopPropagation();
              onTileClick({ x, y });
            }}
          >
            <boxGeometry args={[TILE_SIZE * 0.98, 0.1, TILE_SIZE * 0.98]} />
            <meshStandardMaterial color={isHighlight ? "#222C26" : "#16191E"} />
          </mesh>
          {/* Occupied dot indicator */}
          {isOccupied && (
            <mesh position={[0, 0.11, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 0.02, 12]} />
              <meshStandardMaterial color="#94a3b8" />
            </mesh>
          )}
        </group>
      );
    }
  }
  return <group>{tiles}</group>;
}

// --------------------------- Intro Cinematic ---------------------------
function IntroCinematic({
  active,
  onEnd,
  playerFocus,
  enemyFocus,
  finalPos = [0, 7, 10],
  finalTarget = [0, 0, 0],
}) {
  const { camera } = useThree();
  const startRef = useRef(null);

  useEffect(() => {
    if (active) startRef.current = performance.now();
  }, [active]);

  useFrame(() => {
    if (!active || !startRef.current) return;
    const now = performance.now();
    const t = Math.min(1, (now - startRef.current) / 6000); // 6s
    const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
    const te = easeOutCubic(t);

    // Default fallbacks in case foci are undefined
    const pf = playerFocus || new THREE.Vector3(-3, 0, 0);
    const ef = enemyFocus || new THREE.Vector3(3, 0, 0);

    let pos = new THREE.Vector3();
    let target = new THREE.Vector3();

    if (te < 1 / 3) {
      // 0-2s: Player squad hero shot
      const tt = te * 3;
      const pStart = pf.clone().add(new THREE.Vector3(2.5, 2.0, 1.5));
      const pEnd = pf.clone().add(new THREE.Vector3(-0.5, 2.6, 2.8));
      pos.lerpVectors(pStart, pEnd, tt);
      target.copy(pf);
    } else if (te < 2 / 3) {
      // 2-4s: Enemy reveal
      const tt = (te - 1 / 3) * 3;
      const eStart = ef.clone().add(new THREE.Vector3(-2.5, 2.2, -1.8));
      const eEnd = ef.clone().add(new THREE.Vector3(0.6, 2.9, -2.6));
      pos.lerpVectors(eStart, eEnd, tt);
      target.copy(ef);
    } else {
      // 4-6s: Sweeping pull-back to gameplay
      const tt = (te - 2 / 3) * 3;
      const mid = pf.clone().add(ef).multiplyScalar(0.5);
      const start = mid.clone().add(new THREE.Vector3(-4, 3, 4));
      const finish = new THREE.Vector3().fromArray(finalPos);
      pos.lerpVectors(start, finish, tt);
      target.lerpVectors(mid, new THREE.Vector3().fromArray(finalTarget), tt);
    }

    // Smooth camera motion
    camera.position.lerp(pos, 0.2);
    camera.lookAt(target);

    if (t >= 1) {
      // Snap to final and end cinematic
      camera.position.set(...finalPos);
      camera.lookAt(...finalTarget);
      onEnd && onEnd();
    }
  });

  return null;
}

// --------------------------- Main Game ---------------------------
const initialUnits = () => {
  // Two simple squads
  const players = [
    {
      id: "hero",
      team: "player",
      classType: "melee",
      x: 0,
      y: 4,
      hp: 20,
      maxHp: 20,
      atk: 10,
      move: 1,
      modelUrl: PLAYER_HERO,
      hasActed: false,
    },
    {
      id: "knight",
      team: "player",
      classType: "melee",
      x: 1,
      y: 5,
      hp: 10,
      maxHp: 10,
      atk: 4,
      move: 3,
      modelUrl: PLAYER_KNIGHT,
      hasActed: false,
    },
    {
      id: "rider",
      team: "player",
      classType: "melee",
      x: 1,
      y: 3,
      hp: 10,
      maxHp: 10,
      atk: 4,
      move: 8,
      modelUrl: PLAYER_RIDER,
      hasActed: false,
    },
    {
      id: "mage",
      team: "player",
      classType: "ranged",
      x: 0,
      y: 2,
      hp: 10,
      maxHp: 10,
      atk: 4,
      move: 2,
      attackRange: 8,
      modelUrl: PLAYER_MAGE,
      hasActed: false,
    },
    {
      id: "archer",
      team: "player",
      classType: "ranged",
      x: 0,
      y: 6,
      hp: 10,
      maxHp: 10,
      atk: 3,
      move: 3,
      attackRange: 3,
      modelUrl: PLAYER_ARCHER,
      hasActed: false,
    },
  ];
  const enemies = [
    {
      id: "e0",
      team: "enemy",
      classType: "melee",
      x: GRID_COLS - 1,
      y: 3,
      hp: 20,
      maxHp: 20,
      atk: 10,
      move: 1,
      modelUrl: ENEMY_DARK_KING,
      hasActed: false,
    },
    {
      id: "e1",
      team: "enemy",
      classType: "melee",
      x: GRID_COLS - 2,
      y: 2,
      hp: 4,
      maxHp: 4,
      atk: 3,
      move: 3,
      modelUrl: ENEMY_ASSASSIN,
      hasActed: false,
    },
    {
      id: "e2",
      team: "enemy",
      classType: "melee",
      x: GRID_COLS - 2,
      y: 4,
      hp: 15,
      maxHp: 15,
      atk: 10,
      move: 1,
      modelUrl: ENEMY_DEVIL,
      hasActed: false,
    },
    {
      id: "e3",
      team: "enemy",
      classType: "ranged",
      x: GRID_COLS - 1,
      y: 5,
      hp: 15,
      maxHp: 15,
      atk: 3,
      move: 1,
      attackRange: 4,
      modelUrl: ENEMY_SKUL,
      hasActed: false,
    },
  ];
  return [...players, ...enemies];
};

function useAnimationQueue() {
  const [queue, setQueue] = useState([]); // items: { type: 'move'|'attack'|'heal', unitId, to?, targetId? }
  const [animState, setAnimState] = useState({}); // unitId -> {type}

  const enqueue = (item) => setQueue((q) => [...q, item]);

  // runner
  useEffect(() => {
    if (queue.length === 0) return;
    let cancelled = false;
    const run = async () => {
      const step = queue[0];
      setAnimState((s) => ({
        ...s,
        [step.unitId]: { type: step.type, attackDir: step.attackDir },
      }));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const defaultDur =
        step.type === "move" ? 600 : step.type === "attack" ? 500 : 500;
      const dur = step.durationMs ?? defaultDur;
      await wait(dur);
      if (cancelled) return;
      setAnimState((s) => ({ ...s, [step.unitId]: { type: "idle" } }));
      setQueue((q) => q.slice(1));
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [queue]);

  return { enqueue, animStateById: animState, isBusy: queue.length > 0 };
}

export default function App() {
  const [units, setUnits] = useState(initialUnits);
  const [turn, setTurn] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [reach, setReach] = useState(new Set());
  const [log, setLog] = useState(null); // victory/defeat text
  const [hoveredEnemyId, setHoveredEnemyId] = useState(null);
  const [hoveredAllyId, setHoveredAllyId] = useState(null);
  const audioRef = useRef(null);
  const [musicOn, setMusicOn] = useState(true);
  // Intro starts only after all assets (models + audio) are ready
  const [intro, setIntro] = useState(false);
  const [assetsReady, setAssetsReady] = useState(false);
  const [canStartIntro, setCanStartIntro] = useState(false);

  // ---- SFX setup ----
  const sfx = useMemo(
    () => ({
      hit: new Audio(SFX_HIT),
      heal: new Audio(SFX_HEAL),
      move: new Audio(SFX_MOVE),
      fall: new Audio(SFX_FALL),
      victory: new Audio(SFX_VICTORY),
      fail: new Audio(SFX_FAIL),
      turn: new Audio(SFX_TURN),
    }),
    []
  );

  useEffect(() => {
    // Preload and set sensible volumes
    try {
      sfx.hit.preload = "auto";
      sfx.hit.volume = 0.9;
      sfx.hit.load();
      sfx.heal.preload = "auto";
      sfx.heal.volume = 0.9;
      sfx.heal.load();
      sfx.move.preload = "auto";
      sfx.move.volume = 0.6;
      sfx.move.load();
      sfx.fall.preload = "auto";
      sfx.fall.volume = 0.9;
      sfx.fall.load();
      sfx.victory.preload = "auto";
      sfx.victory.volume = 1.0;
      sfx.victory.load();
      sfx.fail.preload = "auto";
      sfx.fail.volume = 1.0;
      sfx.fail.load();
      sfx.turn.preload = "auto";
      sfx.turn.volume = 0.8;
      sfx.turn.load();
    } catch {
      console.warn("Failed to preload some SFX, will try to play them later");
    }
  }, [sfx]);

  const playSfx = useCallback(
    (name) => {
      const base = sfx[name];
      if (!base) return;
      try {
        // clone so overlapping plays don't cut each other off
        const node = base.cloneNode(true);
        node.volume = base.volume;
        node.play().catch(() => {});
      } catch {
        console.warn(`Failed to play SFX ${name}, it may not be loaded yet`);
      }
    },
    [sfx]
  );

  const [floatTexts, setFloatTexts] = useState([]); // items: {id, unitId, kind:'damage'|'heal', amount}
  const [hitReactions, setHitReactions] = useState({}); // unitId -> {started, duration, dir:{x,z}}

  const controlsRef = useRef(null);
  const enemyAIRunningRef = useRef(false);
  // Track three.js loading progress (GLTFs, HDRI, etc.)
  const { active: loadingActive, progress } = useProgress();

  // --- Turn Banner State ---
  const [turnBanner, setTurnBanner] = useState(null); // "ХОД ИГРОКА" | "ХОД ПРОТИВНИКА" | null
  const bannerTimerRef = useRef(null);

  const showTurnBanner = (whoseTurn) => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setTurnBanner(whoseTurn === "player" ? "PLAYER'S TURN" : "OPPONENT'S TURN");
    bannerTimerRef.current = setTimeout(() => {
      setTurnBanner(null);
      bannerTimerRef.current = null;
    }, 1000);
    playSfx("turn");
  };
  // Show turn banner at the start of every turn (unless intro is running)
  useEffect(() => {
    if (intro || !turn) return; // only show after intro and when turn is defined
    showTurnBanner(turn);
  }, [turn, intro]);

  // When all three assets finished loading (no pending loaders), mark as ready
  useEffect(() => {
    if (!loadingActive) setAssetsReady(true);
  }, [loadingActive]);

  // Wait for audio to be decodable & bufferable enough, then allow intro start
  useEffect(() => {
    if (!assetsReady) return;
    const a = audioRef.current;
    if (!a) {
      setCanStartIntro(true);
      return;
    }
    const ready = () => setCanStartIntro(true);
    if (a.readyState >= 3) {
      // HAVE_FUTURE_DATA or better
      ready();
      return;
    }
    a.addEventListener("canplaythrough", ready, { once: true });
    try {
      a.load();
    } catch {
      // If loading fails, still allow intro to start
      ready();
    }
    return () => a.removeEventListener("canplaythrough", ready);
  }, [assetsReady]);

  // Kick off intro + music only once everything is ready
  useEffect(() => {
    if (!canStartIntro) return;
    setIntro(true);
    startMusicOnce(true);
  }, [canStartIntro]);

  const { enqueue, animStateById, isBusy } = useAnimationQueue();
  const pushFloatText = (unitId, kind, amount) => {
    const id = `${unitId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const item = { id, unitId, kind, amount };
    setFloatTexts((arr) => [...arr, item]);
    // auto remove after 900ms
    setTimeout(() => {
      setFloatTexts((arr) => arr.filter((x) => x.id !== id));
    }, 900);
  };

  // ---- Music control ----
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = 0.3; // default volume
    if (musicOn) {
      a.play().catch(() => {
        // Autoplay may be blocked until user gesture
      });
    } else {
      a.pause();
      a.currentTime = 0;
    }
  }, [musicOn]);

  const toggleMusic = () => setMusicOn((v) => !v);

  // music start guard
  const musicStartedRef = useRef(false);

  // start music only once during initial load/intro; safe against repeated calls
  const startMusicOnce = (forceOn = true) => {
    const a = audioRef.current;
    if (!a || musicStartedRef.current) return;
    if (forceOn) setMusicOn(true);
    try {
      a.play().catch(() => {});
    } catch {
      console.warn("Failed to start music, it may not be loaded yet");
    }
    musicStartedRef.current = true;
  };

  // explicit restart (e.g., when pressing "Restart the battle")
  const restartMusic = (forceOn = true) => {
    const a = audioRef.current;
    if (!a) return;
    if (forceOn) setMusicOn(true);
    try {
      a.pause();
    } catch {
      console.warn("Failed to pause music, it may not be loaded yet");
    }
    a.currentTime = 0;
    a.play().catch(() => {});
    musicStartedRef.current = true;
  };

  // Gesture fallback only after intro is allowed (in case autoplay is blocked)
  useEffect(() => {
    if (!canStartIntro) return;
    const unlock = () => {
      startMusicOnce(true);
      // Prime SFX after first user gesture to satisfy autoplay policies
      try {
        sfx.hit.load();
        sfx.heal.load();
        sfx.move.load();
        sfx.fall.load();
        sfx.victory.load();
        sfx.fail.load();
        sfx.turn.load();
      } catch {
        console.warn("Failed to prime SFX, will try to play them later");
      }
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, [canStartIntro, sfx]);

  const occupied = useMemo(() => {
    const s = new Set();
    units.forEach((u) => s.add(key(u.x, u.y)));
    return s;
  }, [units]);

  const unitMap = useMemo(() => {
    const m = new Map();
    units.forEach((u) => m.set(u.id, u));
    return m;
  }, [units]);

  const playerFocus = useMemo(() => {
    const ps = units.filter((u) => u.team === "player");
    if (ps.length === 0) return new THREE.Vector3(-3, 0, 0);
    const avg = ps.reduce(
      (acc, u) => acc.add(worldFromGrid(u.x, u.y)),
      new THREE.Vector3()
    );
    avg.multiplyScalar(1 / ps.length);
    return avg;
  }, [units]);

  const enemyFocus = useMemo(() => {
    const es = units.filter((u) => u.team === "enemy");
    if (es.length === 0) return new THREE.Vector3(3, 0, 0);
    const avg = es.reduce(
      (acc, u) => acc.add(worldFromGrid(u.x, u.y)),
      new THREE.Vector3()
    );
    avg.multiplyScalar(1 / es.length);
    return avg;
  }, [units]);

  const selected = selectedId ? unitMap.get(selectedId) : null;

  // Memoized: can the currently selected player unit attack this enemy?
  const canAttackEnemy = (enemy) => {
    if (!selected) return false;
    if (turn !== "player") return false;
    if (selected.team !== "player" || selected.hasActed) return false;
    if (enemy.team !== "enemy") return false;
    if (enemy.hp <= 0) return false;
    const range = selected.attackRange ?? 1;
    return manhattan(selected, enemy) <= range;
  };

  // Can the selected unit attack this enemy this turn (immediately or after a melee step)?
  const canThreatenEnemyThisTurn = (enemy) => {
    if (!selected) return false;
    if (turn !== "player") return false;
    if (selected.team !== "player" || selected.hasActed) return false;
    if (!enemy || enemy.team !== "enemy") return false;
    if (enemy.hp <= 0) return false;

    const range = selected.attackRange ?? 1;
    // Ranged: simple distance check
    if (!isMeleeUnit(selected)) {
      return manhattan(selected, enemy) <= range;
    }
    // Melee: either already adjacent, or has a reachable tile adjacent to enemy
    if (manhattan(selected, enemy) <= 1) return true;
    // Use current "reach" (computed for selected unit considering obstacles)
    for (const kstr of reach) {
      const [sx, sy] = kstr.split(",").map(Number);
      if (Math.abs(sx - enemy.x) + Math.abs(sy - enemy.y) <= 1) return true;
    }
    return false;
  };

  const isMeleeUnit = (u) => {
    if (!u) return false;
    if (u.classType) return u.classType === "melee";
    const range = u.attackRange ?? 1;
    return range === 1;
  };

  const canHealAlly = (ally) => {
    if (!selected) return false;
    if (turn !== "player") return false;
    if (selected.team !== "player" || selected.hasActed) return false;
    // Only mage can heal and not self
    if (selected.id !== "mage") return false;
    if (!ally || ally.team !== "player" || ally.id === selected.id)
      return false;
    return true;
  };

  useEffect(() => {
    // Update reach when selection changes
    if (selected && turn === "player" && !selected.hasActed) {
      const occ = new Set(occupied);
      occ.delete(key(selected.x, selected.y));
      setReach(reachable({ x: selected.x, y: selected.y }, selected.move, occ));
    } else setReach(new Set());
  }, [selectedId, units, turn]);

  // Check victory/defeat
  useEffect(() => {
    const playersAlive = units.some((u) => u.team === "player" && u.hp > 0);
    const enemiesAlive = units.some((u) => u.team === "enemy" && u.hp > 0);
    if (!playersAlive && !log) {
      setLog("Failure!");
      setMusicOn(false);
      playSfx("fail");
    } else if (!enemiesAlive && !log) {
      setLog("Victory!");
      setMusicOn(false);
      playSfx("victory");
    }
  }, [units, log, playSfx]);

  function worldFromGrid(x, y) {
    return new THREE.Vector3(
      (x - GRID_COLS / 2 + 0.5) * TILE_SIZE,
      0,
      (y - GRID_ROWS / 2 + 0.5) * TILE_SIZE
    );
  }

  // Generalized attack: attacker and explicit target
  const tryAttack = (attacker, target) => {
    if (!attacker || !target) return false;
    const range = attacker.attackRange ?? 1;
    if (manhattan(attacker, target) > range) return false;

    // Random damage from 0..atk (0 = miss)
    const damage = randInt(0, attacker.atk ?? 0);

    // Start attack animation immediately, with attackDir
    {
      const dx = target.x - attacker.x;
      const dz = target.y - attacker.y;
      const len = Math.max(1e-6, Math.hypot(dx, dz));
      const attackDir = { x: dx / len, z: dz / len };
      enqueue({ type: "attack", unitId: attacker.id, attackDir });
    }

    const willDie = target.hp - damage <= 0;

    // Apply damage and reactions at the moment of impact, not before
    setTimeout(() => {
      playSfx("hit");

      // Floating damage text with an extra delay
      setTimeout(() => {
        pushFloatText(target.id, "damage", damage === 0 ? "miss" : damage);
      }, 300);

      // Hit reaction (knockback) triggered on impact
      setHitReactions((prev) => {
        const dx = target.x - attacker.x;
        const dz = target.y - attacker.y;
        const len = Math.max(1e-6, Math.hypot(dx, dz));
        return {
          ...prev,
          [target.id]: {
            started: performance.now() / 1000,
            duration: 0.4,
            dir: { x: dx / len, z: dz / len },
          },
        };
      });

      // Commit HP change and consume the attacker's action
      setUnits((prev) => {
        const after = prev.map((u) => ({ ...u }));
        const ti = after.findIndex((u) => u.id === target.id);
        if (ti === -1) return after;
        after[ti].hp -= damage;
        if (after[ti].hp <= 0) {
          after[ti].hp = 0;
          // Mark for death animation; store dir for fall
          const dx2 = target.x - attacker.x;
          const dz2 = target.y - attacker.y;
          const l2 = Math.max(1e-6, Math.hypot(dx2, dz2));
          after[ti].dying = true;
          after[ti].deathStarted = performance.now() / 1000;
          after[ti].deathDir = { x: dx2 / l2, z: dz2 / l2 };
        }
        const ai = after.findIndex((u) => u.id === attacker.id);
        if (ai !== -1) after[ai].hasActed = true;
        return after;
      });
      if (willDie) playSfx("fall");
      // Schedule removal of the corpse after animations
      setTimeout(() => {
        setUnits((prev) =>
          prev.filter((u) => !(u.id === target.id && u.hp <= 0))
        );
      }, DEATH_REMOVE_MS);
    }, ATTACK_IMPACT_MS);

    return true;
  };

  // Healing logic: random heal from 0..max (using healer.heal or healer.atk); 0 = miss
  const tryHeal = (healer, target) => {
    if (!healer || !target) return false;
    if (healer.id !== "mage" || healer.hasActed) return false;
    if (target.team !== "player" || target.id === healer.id) return false;

    // Start heal animation immediately
    enqueue({ type: "heal", unitId: healer.id });

    // Commit heal at impact time
    setTimeout(() => {
      playSfx("heal");
      setUnits((prev) => {
        const after = prev.map((u) => ({ ...u }));
        const ti = after.findIndex((u) => u.id === target.id);
        if (ti === -1) return after;
        const maxHeal = healer.heal ?? healer.atk ?? 0;
        const healAmount = randInt(0, maxHeal); // 0..maxHeal (0 = miss)
        const maxHp = after[ti].maxHp ?? after[ti].hp;
        const nextHp = Math.min(after[ti].hp + healAmount, maxHp);
        const actuallyHealed = nextHp - after[ti].hp;
        after[ti].hp = nextHp;
        if (actuallyHealed > 0)
          pushFloatText(
            target.id,
            "heal",
            actuallyHealed === 0 ? "miss" : actuallyHealed
          );
        const hi = after.findIndex((u) => u.id === healer.id);
        if (hi !== -1) after[hi].hasActed = true;
        return after;
      });
    }, HEAL_IMPACT_MS);

    return true;
  };

  const onTileClick = (tile) => {
    if (intro) return;
    if (turn !== "player" || !selected || selected.hasActed || isBusy) return;
    const k = key(tile.x, tile.y);
    if (!reach.has(k)) return;

    // Step-by-step movement animation (hop per tile)
    // Find path (BFS backtrack) - for now, simple straight line
    // For smooth movement, interpolate in steps
    // We'll use a naive Manhattan path for now
    const steps = [];
    let cx = selected.x,
      cy = selected.y;
    while (cx !== tile.x || cy !== tile.y) {
      if (cx < tile.x) cx++;
      else if (cx > tile.x) cx--;
      else if (cy < tile.y) cy++;
      else if (cy > tile.y) cy--;
      steps.push({ x: cx, y: cy });
    }
    const MOVE_STEP_MS = 320; // match enemy move speed
    steps.forEach((p, idx) => {
      // queue a short hop animation for each tile
      enqueue({ type: "move", unitId: selected.id, durationMs: MOVE_STEP_MS });
      setTimeout(() => {
        setUnits((prev) => {
          const after = prev.map((u) => ({ ...u }));
          const i = after.findIndex((u) => u.id === selected.id);
          if (i !== -1) {
            after[i].x = p.x;
            after[i].y = p.y;
            // only mark action consumed on the final hop
            if (idx === steps.length - 1) after[i].hasActed = true;
          }
          return after;
        });
        playSfx("move");
      }, idx * MOVE_STEP_MS);
    });
    setTimeout(() => setSelectedId(null), steps.length * MOVE_STEP_MS);
    // Safety snap to ensure final position is correct even if a hop was dropped
    setTimeout(() => {
      setUnits((prev) => {
        const after = prev.map((u) => ({ ...u }));
        const i = after.findIndex((u) => u.id === selected.id);
        if (i !== -1) {
          after[i].x = tile.x;
          after[i].y = tile.y;
          after[i].hasActed = true;
        }
        return after;
      });
    }, steps.length * MOVE_STEP_MS + 10);
  };

  const onUnitClick = (u) => {
    if (intro) return;
    if (u.hp <= 0 || u.dying) return;
    if (turn !== "player" || isBusy) return;
    // If clicking an ally and selected mage can heal — perform heal
    if (u.team === "player" && canHealAlly(u)) {
      tryHeal(selected, u);
      setSelectedId(null);
      return;
    }
    // If clicking enemy: either attack immediately (if in range) or, for melee, move into range then attack
    if (u.team === "enemy") {
      // immediate attack if already in range
      if (canAttackEnemy(u)) {
        tryAttack(selected, u);
        setSelectedId(null);
        return;
      }
      // melee auto step-then-attack logic
      const isMelee = isMeleeUnit(selected);
      if (
        selected &&
        isMelee &&
        turn === "player" &&
        selected.team === "player" &&
        !selected.hasActed
      ) {
        // find any reachable tile that would put us in range of the enemy
        const reachableTiles = Array.from(reach).map((k) => {
          const [sx, sy] = k.split(",").map(Number);
          return { x: sx, y: sy };
        });
        const candidateTiles = reachableTiles.filter(
          (t) => Math.abs(t.x - u.x) + Math.abs(t.y - u.y) <= 1
        );
        if (candidateTiles.length) {
          // choose the shortest move; tie-breaker: minimal distance to enemy
          const best = candidateTiles.reduce((best, t) => {
            const moveDist =
              Math.abs(t.x - selected.x) + Math.abs(t.y - selected.y);
            const enemyDist = Math.abs(t.x - u.x) + Math.abs(t.y - u.y);
            if (!best) return { t, moveDist, enemyDist };
            if (moveDist < best.moveDist) return { t, moveDist, enemyDist };
            if (moveDist === best.moveDist && enemyDist < best.enemyDist)
              return { t, moveDist, enemyDist };
            return best;
          }, null).t;

          // animate move without consuming action, then queue attack which will consume the action
          enqueue({ type: "move", unitId: selected.id });
          setUnits((prev) => {
            const after = prev.map((uu) => ({ ...uu }));
            const i = after.findIndex((uu) => uu.id === selected.id);
            if (i !== -1) {
              after[i].x = best.x;
              after[i].y = best.y;
              // do NOT set hasActed here; the attack will consume the action
            }
            return after;
          });
          // attack using the updated (virtual) position
          const movedAttacker = { ...selected, x: best.x, y: best.y };
          tryAttack(movedAttacker, u);
          setSelectedId(null);
          return;
        }
      }
    }
    // Otherwise, normal selection of player's own unit (only if not acted)
    if (u.team !== "player" || u.hasActed) return;
    setSelectedId(u.id === selectedId ? null : u.id);
  };

  const endPlayerTurn = () => {
    if (intro) return;
    if (turn !== "player") return;
    setSelectedId(null);
    setHoveredAllyId(null);
    // reset enemy hasActed
    setUnits((prev) =>
      prev.map((u) => (u.team === "enemy" ? { ...u, hasActed: false } : u))
    );
    setTurn("enemy");
  };

  // Simple enemy AI: for each enemy, either attack if adjacent, else move towards closest player within move range
  useEffect(() => {
    if (turn !== "enemy" || isBusy || log || enemyAIRunningRef.current) return;

    const doEnemyRound = async () => {
      enemyAIRunningRef.current = true;
      try {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let stateUnits = units;

        const enemies = stateUnits.filter((u) => u.team === "enemy");
        for (const e of enemies) {
          if (!stateUnits.find((u) => u.id === e.id)) continue; // might be dead
          // Attack if in range
          const eRange = e.attackRange ?? 1;
          const adjTarget = stateUnits.find(
            (u) => u.team === "player" && u.hp > 0 && manhattan(e, u) <= eRange
          );
          const didAttack = adjTarget ? tryAttack(e, adjTarget) : false;
          if (didAttack) {
            await wait(520);
            stateUnits = JSON.parse(JSON.stringify(stateUnits));
            // Delay before next enemy's turn
            await wait(1000);
            continue;
          }
          // Move towards nearest player
          const targets = stateUnits.filter(
            (u) => u.team === "player" && u.hp > 0
          );
          if (targets.length === 0) break;
          const nearest = targets.reduce((a, b) =>
            manhattan(e, a) < manhattan(e, b) ? a : b
          );
          // compute best step within range that gets closer
          const occ = new Set(stateUnits.map((u) => key(u.x, u.y)));
          occ.delete(key(e.x, e.y));
          const r = reachable({ x: e.x, y: e.y }, e.move, occ);
          let best = { x: e.x, y: e.y };
          let bestD = manhattan(e, nearest);
          r.forEach((kstr) => {
            const [sx, sy] = kstr.split(",").map(Number);
            const d = Math.abs(sx - nearest.x) + Math.abs(sy - nearest.y);
            if (d < bestD) {
              bestD = d;
              best = { x: sx, y: sy };
            }
          });
          if (best.x !== e.x || best.y !== e.y) {
            // Animate step-by-step hops for enemy move
            const steps = [];
            let cx = e.x,
              cy = e.y;
            while (cx !== best.x || cy !== best.y) {
              if (cx < best.x) cx++;
              else if (cx > best.x) cx--;
              else if (cy < best.y) cy++;
              else if (cy > best.y) cy--;
              steps.push({ x: cx, y: cy });
            }
            const MOVE_STEP_MS = 320; // 320ms per step
            for (let idx = 0; idx < steps.length; idx++) {
              const p = steps[idx];
              enqueue({ type: "move", unitId: e.id, durationMs: MOVE_STEP_MS });
              await wait(MOVE_STEP_MS);
              setUnits((prev) => {
                const after = prev.map((u) => ({ ...u }));
                const i = after.findIndex((u) => u.id === e.id);
                if (i !== -1) {
                  after[i].x = p.x;
                  after[i].y = p.y;
                  if (idx === steps.length - 1) after[i].hasActed = true;
                }
                return after;
              });
              playSfx("move");
            }
            // Safety snap to final intended tile
            setUnits((prev) => {
              const after = prev.map((u) => ({ ...u }));
              const i = after.findIndex((u) => u.id === e.id);
              if (i !== -1) {
                after[i].x = best.x;
                after[i].y = best.y;
                after[i].hasActed = true;
              }
              return after;
            });
            // Update our local mirror so next enemies see the new occupancy
            stateUnits = stateUnits.map((u) =>
              u.id === e.id ? { ...u, x: best.x, y: best.y } : u
            );
          }
          // movement consumes the action; no extra attack this turn
          await wait(520);
          // Delay before next enemy's turn
          await wait(1000);
        }
        // End enemy turn => reset player hasActed
        setUnits((prev) =>
          prev.map((u) => (u.team === "player" ? { ...u, hasActed: false } : u))
        );
        setTurn("player");
      } finally {
        enemyAIRunningRef.current = false;
      }
    };

    doEnemyRound();
  }, [turn, isBusy, log, playSfx]);

  const allPlayerActed = useMemo(
    () => units.filter((u) => u.team === "player").every((u) => u.hasActed),
    [units]
  );

  return (
    <div className="w-screen h-screen bg-slate-900 text-white">
      {/* Global preload overlay */}
      {!canStartIntro && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900">
          <div className="text-center">
            <div className="text-lg mb-2">Loading preset...</div>
            <div className="w-64 h-2 bg-slate-700 rounded overflow-hidden">
              <div
                className="h-full bg-emerald-500"
                style={{ width: `${Math.round(progress)}%` }}
              />
            </div>
            <div className="mt-2 text-sm opacity-80">
              {Math.round(progress)}%
            </div>
          </div>
        </div>
      )}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-3">
        {turn && (
          <div className="text-sm md:text-base opacity-80">
            Tern:{" "}
            <span
              className={
                turn === "player" ? "text-emerald-400" : "text-rose-400"
              }
            >
              {turn === "player" ? "Player" : "Opponent"}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMusic}
            className={`px-3 py-2 rounded-xl shadow-lg transition bg-slate-700 hover:bg-slate-600`}
            title={musicOn ? "Tern music off" : "Turn music on"}
          >
            {musicOn ? "🔊 Music" : "🔈 Music"}
          </button>
          <button
            onClick={endPlayerTurn}
            disabled={intro || turn !== "player" || !allPlayerActed}
            className={`px-4 py-2 rounded-xl shadow-lg transition 
              ${
                turn === "player" && allPlayerActed && !intro
                  ? "bg-emerald-500 hover:bg-emerald-400"
                  : "bg-slate-600 opacity-50"
              }`}
          >
            End the turn
          </button>
        </div>
      </div>

      {/* Turn Banner Overlay */}
      {turnBanner && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="px-6 py-3 rounded-2xl bg-black/60 text-white text-2xl font-bold shadow-xl">
            {turnBanner}
          </div>
        </div>
      )}

      {log && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="px-8 py-6 rounded-2xl bg-slate-800 shadow-xl text-center">
            <div className="text-3xl font-semibold mb-2">{log}</div>
            <button
              className="mt-2 px-4 py-2 rounded-xl bg-slate-700 hover:bg-slate-600"
              onClick={() => {
                setUnits(initialUnits());
                setTurn("player");
                setLog(null);
                setIntro(true);
                // restart soundtrack for new battle
                restartMusic(true);
              }}
            >
              Restart the battle
            </button>
          </div>
        </div>
      )}

      <Canvas shadows camera={{ position: [0, 7, 10], fov: 45 }}>
        <ambientLight intensity={0.4} />
        <directionalLight
          position={[5, 10, 5]}
          castShadow
          intensity={0.9}
          shadow-mapSize={[2048, 2048]}
        />
        <Suspense
          fallback={
            <Html>
              <div className="text-white">Loading...</div>
            </Html>
          }
        >
          <Environment preset="city" />
        </Suspense>

        {/* Arena base */}
        <group position={[0, -0.05, 0]}>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry
              args={[Math.max(GRID_COLS, GRID_ROWS) * TILE_SIZE * 0.65, 64]}
            />
            <meshStandardMaterial color="#0f172a" />
          </mesh>
        </group>

        {/* Grid */}
        <Grid
          onTileClick={onTileClick}
          highlights={reach}
          occupiedMap={occupied}
        />

        {/* Units */}
        {units.map((u) => (
          <Unit
            key={u.id}
            unit={u}
            isSelected={selectedId === u.id}
            worldPos={worldFromGrid(u.x, u.y)}
            animState={animStateById[u.id] || { type: "idle" }}
            onClick={(e) => {
              e.stopPropagation();
              onUnitClick(u);
            }}
            onPointerOver={() => {
              if (u.team === "enemy") setHoveredEnemyId(u.id);
              if (u.team === "player" && canHealAlly(u)) setHoveredAllyId(u.id);
            }}
            onPointerOut={() => {
              if (hoveredEnemyId === u.id) setHoveredEnemyId(null);
              if (hoveredAllyId === u.id) setHoveredAllyId(null);
            }}
            isAttackableEnemy={
              u.team === "enemy" && canThreatenEnemyThisTurn(u)
            }
            isHoveredEnemy={hoveredEnemyId === u.id}
            isHealableAlly={u.team === "player" && canHealAlly(u)}
            isHoveredAlly={hoveredAllyId === u.id}
            hitReaction={hitReactions[u.id]}
            floatTexts={floatTexts.filter((ft) => ft.unitId === u.id)}
          />
        ))}

        {/* Camera control: arena rotation with drag */}
        <OrbitControls
          ref={controlsRef}
          enabled={!intro}
          enablePan={false}
          maxPolarAngle={Math.PI / 2.2}
          minDistance={6}
          maxDistance={16}
        />
        {intro && (
          <IntroCinematic
            active={intro}
            onEnd={() => {
              setIntro(false);
              setTurn("player");
            }}
            playerFocus={playerFocus}
            enemyFocus={enemyFocus}
            finalPos={[0, 7, 10]}
            finalTarget={[0, 0, 0]}
          />
        )}
      </Canvas>

      {/* HUD bottom: unit cards */}
      <div className="absolute bottom-0 inset-x-0 z-10 p-3 grid grid-cols-2 gap-3 pointer-events-none">
        {units
          .filter((u) => u.team === "player")
          .map((u) => (
            <div
              key={u.id}
              className={`pointer-events-auto rounded-2xl p-3 shadow-lg bg-slate-800/80 backdrop-blur 
                ${selectedId === u.id ? "ring-2 ring-emerald-400" : ""}`}
              onClick={() => onUnitClick(u)}
            >
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{u.id.toUpperCase()}</span>
                <span className="opacity-80">HP: {u.hp}</span>
              </div>
              <div className="mt-1 text-xs opacity-80">
                Attack: {u.atk} • Moves: {u.move} • Distance:{" "}
                {u.attackRange ?? 1} {u.hasActed ? "• Made a move" : ""}
              </div>
            </div>
          ))}
      </div>
      {/* Global soundtrack */}
      <audio ref={audioRef} src={MUSIC_URL} loop preload="auto" />
    </div>
  );
}

// drei GLTF cache helper
useGLTF.preload(PLAYER_KNIGHT || "");
useGLTF.preload(PLAYER_ARCHER || "");
useGLTF.preload(PLAYER_MAGE || "");
useGLTF.preload(PLAYER_RIDER || "");
useGLTF.preload(ENEMY_ASSASSIN || "");
useGLTF.preload(ENEMY_DEVIL || "");
useGLTF.preload(ENEMY_SKUL || "");
