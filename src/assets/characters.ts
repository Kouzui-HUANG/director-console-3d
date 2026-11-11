/**
 * Static low-poly mannequins. A pose is a set of joint angles; forward kinematics places
 * simple limb segments, then everything is merged into one mesh (≈ 400 triangles).
 */
import * as THREE from 'three';
import { buildWidth, passerbyTraits, POSE_IDS, type Pose } from '../core/assetTypes.ts';
import { hexToRgb, hslToHex, rgbToHex } from '../core/colors.ts';
import type { Params } from '../core/fields.ts';
import { mulberry32, pick } from '../core/noise.ts';
import { MeshBuilder } from './geometry.ts';

const DEG = Math.PI / 180;

interface Limb {
  fwd?: number;
  out?: number;
  twist?: number;
  bend?: number;
}
interface PoseDef {
  lean?: number;
  twist?: number;
  headPitch?: number;
  headYaw?: number;
  armL?: Limb;
  armR?: Limb;
  legL?: Limb;
  legR?: Limb;
  /** Rotate the whole body about X (lying down). */
  rootPitch?: number;
}

const POSES: Record<Pose, PoseDef> = {
  stand: { armL: { out: 7, bend: 8 }, armR: { out: 7, bend: 8 }, legL: { out: 2 }, legR: { out: 2 } },
  walk: {
    lean: 3,
    armL: { fwd: -20, out: 6, bend: 15 },
    armR: { fwd: 22, out: 6, bend: 22 },
    legL: { fwd: 22, bend: 4 },
    legR: { fwd: -16, bend: 20 },
  },
  run: {
    lean: 13,
    armL: { fwd: -42, out: 8, bend: 95 },
    armR: { fwd: 48, out: 8, bend: 92 },
    legL: { fwd: 52, bend: 72 },
    legR: { fwd: -28, bend: 98 },
  },
  sit: {
    lean: -5,
    armL: { fwd: 38, out: 10, bend: 52 },
    armR: { fwd: 38, out: 10, bend: 52 },
    legL: { fwd: 90, out: 5, bend: 90 },
    legR: { fwd: 90, out: 5, bend: 90 },
  },
  talk: {
    armL: { out: 9, bend: 12 },
    armR: { fwd: 28, out: 14, bend: 88, twist: 25 },
    legL: { out: 3 },
    legR: { out: 3 },
    headYaw: -6,
  },
  wave: {
    armL: { out: 7, bend: 8 },
    armR: { out: 105, fwd: 8, bend: 75, twist: -90 },
    legL: { out: 2 },
    legR: { out: 2 },
    headPitch: -4,
  },
  point: { armL: { out: 7, bend: 10 }, armR: { fwd: 85, out: 12, bend: 0 }, legL: { out: 4 }, legR: { out: 2 }, headYaw: -4 },
  phone: {
    armL: { out: 7, bend: 10 },
    armR: { fwd: 18, out: 30, bend: 150, twist: -70 },
    legL: { out: 2 },
    legR: { out: 4 },
    headPitch: 6,
  },
  armsCrossed: {
    armL: { fwd: 32, out: -10, bend: 112, twist: 75 },
    armR: { fwd: 30, out: -10, bend: 112, twist: 75 },
    legL: { out: 4 },
    legR: { out: 4 },
  },
  handsOnHips: {
    armL: { out: 38, fwd: -10, bend: 108, twist: 90 },
    armR: { out: 38, fwd: -10, bend: 108, twist: 90 },
    legL: { out: 6 },
    legR: { out: 6 },
  },
  raiseHand: { armL: { out: 7, bend: 8 }, armR: { fwd: 168, out: 12, bend: 12 }, legL: { out: 2 }, legR: { out: 2 } },
  crouch: {
    lean: 38,
    armL: { fwd: 55, out: 12, bend: 50 },
    armR: { fwd: 55, out: 12, bend: 50 },
    legL: { fwd: 112, out: 12, bend: 135 },
    legR: { fwd: 105, out: 12, bend: 128 },
    headPitch: -20,
  },
  lie: {
    rootPitch: -90,
    armL: { out: 12, bend: 6 },
    armR: { out: 12, bend: 6 },
    legL: { out: 3 },
    legR: { out: 3 },
  },
};

export type BodyKind = 'male' | 'female' | 'child';

export interface CharacterSpec {
  kind: BodyKind;
  height: number;
  build: number;
  pose: Pose;
  hair?: string;
  outfit?: string;
  color: string;
}

const qx = (d: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), d * DEG);
const qy = (d: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d * DEG);
const qz = (d: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), d * DEG);
const mulQ = (...qs: THREE.Quaternion[]) => qs.reduce((a, b) => a.clone().multiply(b), new THREE.Quaternion());
const DOWN = new THREE.Vector3(0, -1, 0);

function along(q: THREE.Quaternion, v: THREE.Vector3, len = 1): THREE.Vector3 {
  return v.clone().applyQuaternion(q).multiplyScalar(len);
}

/**
 * Append a posed figure to a builder. The figure's origin is the pelvis projected to the
 * ground; it faces +Z. `placement` (optional) positions it inside a shared mesh.
 */
export function addCharacter(b: MeshBuilder, spec: CharacterSpec, placement?: THREE.Matrix4): void {
  const H = spec.height;
  const child = spec.kind === 'child';
  const female = spec.kind === 'female';
  const w = spec.build;
  const headH = H / (child ? 5.6 : 7.4);
  const ankleY = 0.04 * H;
  const hipY = (child ? 0.47 : 0.515) * H;
  const thigh = (hipY - ankleY) * 0.5;
  const shin = thigh;
  const shoulderY = H - headH - 0.03 * H;
  const upperArm = (child ? 0.17 : 0.186) * H;
  const foreArm = (child ? 0.14 : 0.15) * H;
  const handL = 0.085 * H;
  const shoulderHalf = (female ? 0.112 : child ? 0.105 : 0.13) * H * w;
  const hipHalf = (female ? 0.064 : 0.055) * H * w;
  const torsoD = (female ? 0.1 : 0.115) * H * w;
  const armR = 0.027 * H * w;
  const legR = 0.042 * H * w;
  const pose = POSES[spec.pose] ?? POSES.stand;

  b.setBaseColor(spec.color);
  const parts: { kind: 'limb' | 'box' | 'sphere' | 'cyl'; args: unknown[]; tint: number }[] = [];
  const pts: THREE.Vector3[] = [];

  const root = qx(pose.rootPitch ?? 0);
  const pelvis = new THREE.Vector3(0, hipY, 0);
  const P = (local: THREE.Vector3) => local.clone().sub(pelvis).applyQuaternion(root).add(pelvis);

  // Spine & torso
  const spineQ = mulQ(root, qy(pose.twist ?? 0), qx(pose.lean ?? 0));
  const chestTop = pelvis.clone().add(along(spineQ, new THREE.Vector3(0, 1, 0), shoulderY - hipY));
  const waist = pelvis.clone().add(along(spineQ, new THREE.Vector3(0, 1, 0), (shoulderY - hipY) * 0.42));

  const segBox = (a: THREE.Vector3, c: THREE.Vector3, wTop: number, wBottom: number, d: number, tint: number) => {
    parts.push({ kind: 'cyl', args: [a, c, wTop, wBottom, d, spineQ], tint });
    pts.push(a, c);
  };
  // abdomen (pelvis→waist) and chest (waist→shoulders): 4-sided frustums
  segBox(pelvis.clone().add(along(spineQ, DOWN, 0.05 * H)), waist, (female ? 0.85 : 0.8) * shoulderHalf, (female ? 1.05 : 0.88) * shoulderHalf, torsoD, 1);
  segBox(waist, chestTop.clone().add(along(spineQ, DOWN, 0.01 * H)), shoulderHalf * 1.02, (female ? 0.8 : 0.82) * shoulderHalf, torsoD * 1.05, 1);

  // Neck & head
  const headQ = mulQ(spineQ, qy(pose.headYaw ?? 0), qx(pose.headPitch ?? 0));
  const neckTop = chestTop.clone().add(along(headQ, new THREE.Vector3(0, 1, 0), 0.035 * H));
  parts.push({ kind: 'limb', args: [chestTop, neckTop, 0.022 * H, 0.02 * H, 6], tint: 1.25 });
  const headC = neckTop.clone().add(along(headQ, new THREE.Vector3(0, 1, 0), headH * 0.5));
  parts.push({ kind: 'sphere', args: [headC, headH * 0.47, headQ, [0.86, 1.0, 0.95]], tint: 1.3 });
  pts.push(headC.clone().add(new THREE.Vector3(0, headH * 0.5, 0)));
  // nose (shows facing direction)
  const nose = headC.clone().add(along(headQ, new THREE.Vector3(0, -0.06, 1), headH * 0.42));
  parts.push({ kind: 'box', args: [nose, [0.045 * headH * 2, 0.16 * headH, 0.14 * headH], headQ], tint: 1.15 });
  // hair
  const hairStyle = spec.hair ?? (female ? 'long' : 'short');
  const hairTint = 0.42;
  const cap = headC.clone().add(along(headQ, new THREE.Vector3(0, 0.12, -0.08), headH));
  parts.push({ kind: 'sphere', args: [cap, headH * 0.47, headQ, [0.9, 0.62, 0.98]], tint: hairTint });
  if (hairStyle === 'long') {
    const back = headC.clone().add(along(headQ, new THREE.Vector3(0, -0.35, -0.3), headH));
    parts.push({ kind: 'box', args: [back, [headH * 0.82, headH * 0.95, headH * 0.22], headQ], tint: hairTint });
  } else if (hairStyle === 'bun') {
    const bun = headC.clone().add(along(headQ, new THREE.Vector3(0, 0.3, -0.48), headH));
    parts.push({ kind: 'sphere', args: [bun, headH * 0.2, headQ, [1, 1, 1]], tint: hairTint });
  } else if (hairStyle === 'ponytail') {
    const a = headC.clone().add(along(headQ, new THREE.Vector3(0, 0.15, -0.46), headH));
    const c = a.clone().add(along(headQ, new THREE.Vector3(0, -1, -0.25).normalize(), headH * 0.9));
    parts.push({ kind: 'limb', args: [a, c, headH * 0.11, headH * 0.06, 5], tint: hairTint });
  }

  // Arms
  const arm = (side: 1 | -1, l: Limb = {}) => {
    const shoulder = chestTop.clone().add(along(spineQ, new THREE.Vector3(side * shoulderHalf, -0.025 * H, 0)));
    const qUpper = mulQ(spineQ, qz(side * (l.out ?? 0)), qx(-(l.fwd ?? 0)), qy(-side * (l.twist ?? 0)));
    const elbow = shoulder.clone().add(along(qUpper, DOWN, upperArm));
    const qFore = mulQ(qUpper, qx(-(l.bend ?? 0)));
    const wrist = elbow.clone().add(along(qFore, DOWN, foreArm));
    const handEnd = wrist.clone().add(along(qFore, DOWN, handL));
    parts.push({ kind: 'limb', args: [shoulder, elbow, armR * 1.05, armR * 0.92, 6], tint: 1 });
    parts.push({ kind: 'limb', args: [elbow, wrist, armR * 0.9, armR * 0.75, 6], tint: female || child ? 1.25 : 1 });
    parts.push({ kind: 'box', args: [wrist.clone().lerp(handEnd, 0.5), [armR * 1.5, handL, armR * 0.9], qFore], tint: 1.3 });
    pts.push(shoulder, elbow, wrist, handEnd);
  };
  arm(1, pose.armL);
  arm(-1, pose.armR);

  // Legs (attached to the pelvis, rotate with the root only)
  const leg = (side: 1 | -1, l: Limb = {}) => {
    const hip = P(new THREE.Vector3(side * hipHalf, hipY, 0));
    const qThigh = mulQ(root, qz(side * (l.out ?? 0)), qx(-(l.fwd ?? 0)));
    const knee = hip.clone().add(along(qThigh, DOWN, thigh));
    const qShin = mulQ(qThigh, qx(l.bend ?? 0));
    const ankle = knee.clone().add(along(qShin, DOWN, shin));
    const footC = ankle.clone().add(along(qShin, new THREE.Vector3(0, -0.6, 1), ankleY * 0.9));
    parts.push({ kind: 'limb', args: [hip, knee, legR, legR * 0.8, 6], tint: 0.82 });
    parts.push({ kind: 'limb', args: [knee, ankle, legR * 0.78, legR * 0.55, 6], tint: 0.82 });
    parts.push({ kind: 'box', args: [footC, [legR * 1.3, ankleY * 1.1, 0.15 * H], qShin], tint: 0.5 });
    pts.push(hip, knee, ankle, footC.clone().add(along(qShin, DOWN, ankleY * 0.6)));
  };
  leg(1, pose.legL);
  leg(-1, pose.legR);

  // Pelvis block
  parts.push({ kind: 'box', args: [P(new THREE.Vector3(0, hipY + 0.005 * H, 0)), [hipHalf * 2 + legR * 2.1, 0.09 * H, torsoD * 0.95], root], tint: 0.85 });

  // Skirt / dress
  if (female && (spec.outfit === 'skirt' || spec.outfit === 'dress')) {
    const top = waist.clone().lerp(pelvis, 0.3);
    const len = spec.outfit === 'dress' ? 0.36 * H : 0.24 * H;
    const bottom = top.clone().add(along(root, DOWN, len));
    parts.push({ kind: 'limb', args: [top, bottom, shoulderHalf * 0.85, shoulderHalf * (spec.outfit === 'dress' ? 1.55 : 1.4), 8], tint: 0.95 });
  }

  // Ground the figure: lowest point to y = 0.
  let minY = Infinity;
  for (const p of pts) minY = Math.min(minY, p.y);
  const lift = Number.isFinite(minY) ? -minY : 0;
  const shiftV = new THREE.Vector3(0, lift, 0);
  const prev = b.transform;
  b.transform = placement ?? null;

  for (const part of parts) {
    const tint = part.tint;
    switch (part.kind) {
      case 'limb': {
        const [a, c, rA, rB, sides] = part.args as [THREE.Vector3, THREE.Vector3, number, number, number];
        b.limb(a.clone().add(shiftV), c.clone().add(shiftV), rA, rB, sides, { tint });
        break;
      }
      case 'cyl': {
        // Box-like frustum (4-sided cylinder turned 45°) oriented by the spine.
        const [a, c, wTop, wBottom, d, q] = part.args as [THREE.Vector3, THREE.Vector3, number, number, number, THREE.Quaternion];
        const len = a.distanceTo(c);
        const sideTop = 2 * wTop * 0.74;
        const sideBottom = 2 * wBottom * 0.74;
        const g = new THREE.CylinderGeometry(sideTop / Math.SQRT2, sideBottom / Math.SQRT2, len, 4, 1);
        g.rotateY(Math.PI / 4);
        const m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5).add(shiftV), q, new THREE.Vector3(1, 1, d / Math.max(sideTop, sideBottom)));
        b.add(g, { matrix: m, tint });
        break;
      }
      case 'box': {
        const [at, size, q] = part.args as [THREE.Vector3, [number, number, number], THREE.Quaternion];
        const m = new THREE.Matrix4().compose(at.clone().add(shiftV), q, new THREE.Vector3(1, 1, 1));
        b.add(new THREE.BoxGeometry(size[0], size[1], size[2]), { matrix: m, tint });
        break;
      }
      case 'sphere': {
        const [at, r, q, s] = part.args as [THREE.Vector3, number, THREE.Quaternion, [number, number, number]];
        const m = new THREE.Matrix4().compose(at.clone().add(shiftV), q, new THREE.Vector3(...s));
        b.add(new THREE.IcosahedronGeometry(r, 1), { matrix: m, tint });
        break;
      }
    }
  }
  b.transform = prev;
}

export function characterSpec(type: string, p: Params, color: string): CharacterSpec {
  const pose = (POSE_IDS.includes(p.pose as Pose) ? p.pose : 'stand') as Pose;
  if (type === 'passerby') {
    const seed = typeof p.seed === 'number' ? p.seed : 1;
    const t = passerbyTraits(seed, String(p.gender ?? 'auto'));
    const rand = mulberry32(seed * 977 + 3);
    return {
      kind: t.female ? 'female' : 'male',
      height: t.height,
      build: 0.9 + rand() * 0.3,
      pose: p.pose === 'auto' || !p.pose ? t.pose : pose,
      hair: t.female ? pick(rand, ['long', 'bun', 'ponytail', 'short']) : 'short',
      outfit: t.female ? pick(rand, ['pants', 'skirt', 'pants']) : 'pants',
      color: varyColor(color, rand, 0.5),
    };
  }
  return {
    kind: type === 'female' ? 'female' : type === 'child' ? 'child' : 'male',
    height: typeof p.height === 'number' ? p.height : type === 'female' ? 1.63 : type === 'child' ? 1.15 : 1.75,
    build: buildWidth(p.build),
    pose,
    hair: typeof p.hair === 'string' ? p.hair : undefined,
    outfit: typeof p.outfit === 'string' ? p.outfit : undefined,
    color,
  };
}

/** Slight deterministic hue/lightness variation around a base color. */
export function varyColor(hex: string, rand: () => number, amount: number): string {
  if (amount <= 0) return hex;
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max - min < 0.08) {
    // grayish base → pick muted random hues for variety
    return hslToHex(rand() * 360, 0.25 + rand() * 0.35 * amount, 0.32 + rand() * 0.3);
  }
  const k = 1 + (rand() - 0.5) * amount * 0.6;
  return rgbToHex([r * k, g * k, b * k].map((v) => Math.min(1, v + (l - v) * (rand() - 0.5) * amount * 0.3)) as [number, number, number]);
}

export function buildCharacter(type: string, p: Params, color: string): THREE.BufferGeometry {
  const b = new MeshBuilder(color);
  addCharacter(b, characterSpec(type, p, color));
  return b.build();
}

export function buildCrowd(p: Params, color: string): THREE.BufferGeometry {
  const count = Math.max(1, Math.min(400, Number(p.count ?? 30)));
  const W = Number(p.width ?? 20);
  const D = Number(p.depth ?? 12);
  const seed = Number(p.seed ?? 7);
  const rand = mulberry32(seed * 7919 + 13);
  const b = new MeshBuilder(color);
  // jittered grid to avoid overlaps
  const cols = Math.max(1, Math.round(Math.sqrt((count * W) / D)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cw = W / cols;
  const rd = D / rows;
  const poseMode = String(p.pose ?? 'mixed');
  const mixed: Pose[] = ['stand', 'walk', 'walk', 'talk', 'phone', 'armsCrossed', 'handsOnHips', 'stand'];
  const variation = Number(p.colorVariation ?? 0.6);
  let placed = 0;
  for (let r = 0; r < rows && placed < count; r++) {
    for (let c = 0; c < cols && placed < count; c++, placed++) {
      const x = -W / 2 + cw * (c + 0.5) + (rand() - 0.5) * cw * 0.6;
      const z = -D / 2 + rd * (r + 0.5) + (rand() - 0.5) * rd * 0.6;
      const female = rand() < 0.5;
      const pose: Pose = poseMode === 'mixed' ? pick(rand, mixed) : (poseMode as Pose);
      let yaw = rand() * 360;
      if (p.facing === 'forward') yaw = (rand() - 0.5) * 30;
      else if (p.facing === 'center') yaw = (Math.atan2(-x, -z) * 180) / Math.PI + (rand() - 0.5) * 20;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), qy(yaw), new THREE.Vector3(1, 1, 1));
      addCharacter(
        b,
        {
          kind: female ? 'female' : 'male',
          height: female ? 1.55 + rand() * 0.15 : 1.66 + rand() * 0.18,
          build: 0.88 + rand() * 0.3,
          pose,
          hair: female ? pick(rand, ['long', 'bun', 'ponytail', 'short']) : 'short',
          outfit: female ? pick(rand, ['pants', 'skirt']) : 'pants',
          color: varyColor(color, rand, variation),
        },
        m,
      );
    }
  }
  return b.build();
}
