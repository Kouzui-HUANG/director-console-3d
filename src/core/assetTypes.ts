/**
 * Registry of object types: parameters, labels, bounds and aim anchors.
 * Pure data + math (no three.js) so the server, tests and agent docs can use it.
 * The matching 3D builders live in src/assets/.
 */
import type { z } from 'zod';
import type { Vec3 } from './math.ts';
import { bool, choice, color, fieldDefaults, fieldsToZod, int, num, seed, type Field, type Params } from './fields.ts';

export type AssetCategory = 'character' | 'terrain' | 'architecture' | 'prop' | 'camera' | 'helper';

export const CATEGORY_LABELS: Record<AssetCategory, string> = {
  character: '人物',
  architecture: '建築',
  terrain: '地形',
  prop: '道具',
  camera: '攝影機',
  helper: '輔助',
};

export type AnchorName = 'head' | 'chest' | 'center' | 'feet';
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface AssetTypeDef {
  type: string;
  category: AssetCategory;
  label: string;
  en: string;
  /** English description for agents. */
  description: string;
  icon: string;
  defaultColor: string;
  fields: readonly Field[];
  /** Only drawn in the editor view, never seen by shot cameras. */
  editorOnly?: boolean;
  /** New objects are dropped onto the ground (y = 0) by default. */
  groundBased?: boolean;
  /** Local axis-aligned bounds before rotation/scale; origin is the object's base point. */
  bounds(p: Params): Bounds;
  /** Local aim points; missing ones are derived from bounds. */
  anchors?(p: Params): Partial<Record<AnchorName, Vec3>>;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export const POSES = [
  ['stand', '站立'],
  ['walk', '行走'],
  ['run', '跑步'],
  ['sit', '坐'],
  ['talk', '說話手勢'],
  ['wave', '揮手'],
  ['point', '指向'],
  ['phone', '講電話'],
  ['armsCrossed', '雙手抱胸'],
  ['handsOnHips', '叉腰'],
  ['raiseHand', '舉手'],
  ['crouch', '蹲下'],
  ['lie', '躺下'],
] as const;
export type Pose = (typeof POSES)[number][0];
export const POSE_IDS = POSES.map((p) => p[0]) as Pose[];

const BUILDS = [
  ['slim', '纖瘦'],
  ['average', '一般'],
  ['heavy', '壯碩'],
] as const;

export function buildWidth(build: unknown): number {
  return build === 'slim' ? 0.86 : build === 'heavy' ? 1.25 : 1;
}

/** Approximate local bounds of a posed character of height h. */
export function characterBounds(pose: string, h: number, widthScale = 1): Bounds {
  const w = 0.17 * h * widthScale;
  switch (pose) {
    case 'sit':
      return { min: [-w, 0, -0.12 * h], max: [w, 0.72 * h, 0.34 * h] };
    case 'crouch':
      return { min: [-w, 0, -0.18 * h], max: [w, 0.62 * h, 0.22 * h] };
    case 'lie':
      return { min: [-w * 1.1, 0, -0.55 * h], max: [w * 1.1, 0.16 * h, 0.52 * h] };
    case 'raiseHand':
      return { min: [-w, 0, -0.1 * h], max: [w, 1.2 * h, 0.1 * h] };
    case 'wave':
      return { min: [-w * 1.6, 0, -0.1 * h], max: [w * 1.6, 1.08 * h, 0.12 * h] };
    case 'point':
      return { min: [-w, 0, -0.1 * h], max: [w * 1.2, h, 0.48 * h] };
    case 'run':
      return { min: [-w, 0, -0.3 * h], max: [w, 0.98 * h, 0.3 * h] };
    case 'walk':
      return { min: [-w, 0, -0.2 * h], max: [w, h, 0.2 * h] };
    default:
      return { min: [-w, 0, -0.1 * h], max: [w, h, 0.12 * h] };
  }
}

export function characterAnchors(pose: string, h: number): Record<AnchorName, Vec3> {
  switch (pose) {
    case 'sit':
      return { head: [0, 0.66 * h, 0.02 * h], chest: [0, 0.5 * h, 0], center: [0, 0.36 * h, 0.08 * h], feet: [0, 0, 0.26 * h] };
    case 'crouch':
      return { head: [0, 0.57 * h, 0.06 * h], chest: [0, 0.42 * h, 0.04 * h], center: [0, 0.3 * h, 0], feet: [0, 0, 0] };
    case 'lie':
      return { head: [0, 0.1 * h, -0.44 * h], chest: [0, 0.1 * h, -0.24 * h], center: [0, 0.09 * h, 0], feet: [0, 0.05 * h, 0.48 * h] };
    default:
      return { head: [0, 0.93 * h, 0.02 * h], chest: [0, 0.72 * h, 0], center: [0, 0.5 * h, 0], feet: [0, 0, 0] };
  }
}

const poseField = (def: string = 'stand') =>
  choice('pose', '姿勢', 'pose', POSES, def, { animatable: true, hint: '可在時間軸上設關鍵影格瞬間切換' });

const PASSERBY_POSES = [['auto', '隨機'], ...POSES] as const;

function heightOf(p: Params, fallback: number): number {
  return typeof p.height === 'number' ? p.height : fallback;
}

/** Passerby height derived from its seed (deterministic). */
export function passerbyTraits(seedValue: number, gender: string): { female: boolean; height: number; pose: Pose } {
  let s = (seedValue * 2654435761) >>> 0;
  const next = () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
  const female = gender === 'female' ? true : gender === 'male' ? false : next() < 0.5;
  const height = female ? 1.55 + next() * 0.15 : 1.66 + next() * 0.18;
  const standing: Pose[] = ['stand', 'walk', 'walk', 'talk', 'phone', 'armsCrossed', 'handsOnHips'];
  const pose = standing[Math.floor(next() * standing.length)] ?? 'stand';
  return { female, height, pose };
}

// ---------------------------------------------------------------------------
// Shared option lists
// ---------------------------------------------------------------------------

export const WALL_SIDES = [
  ['north', '北（後）'],
  ['south', '南（前）'],
  ['east', '東（右）'],
  ['west', '西（左）'],
] as const;

const box = (w: number, h: number, d: number): Bounds => ({ min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] });
const n = (p: Params, key: string, fallback: number): number => (typeof p[key] === 'number' ? (p[key] as number) : fallback);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const DEFS: AssetTypeDef[] = [
  // Characters -------------------------------------------------------------
  {
    type: 'male',
    category: 'character',
    label: '男性',
    en: 'Man',
    description: 'Adult male mannequin. Static pose; move/rotate the whole body. Front faces +Z.',
    icon: '👨',
    defaultColor: '#3b6fd8',
    groundBased: true,
    fields: [
      num('height', '身高', 'height', 1.75, 1.3, 2.2, { unit: 'm', step: 0.01 }),
      choice('build', '體型', 'build', BUILDS, 'average'),
      poseField(),
    ],
    bounds: (p) => characterBounds(String(p.pose), heightOf(p, 1.75), buildWidth(p.build)),
    anchors: (p) => characterAnchors(String(p.pose), heightOf(p, 1.75)),
  },
  {
    type: 'female',
    category: 'character',
    label: '女性',
    en: 'Woman',
    description: 'Adult female mannequin. Static pose; move/rotate the whole body. Front faces +Z.',
    icon: '👩',
    defaultColor: '#d64541',
    groundBased: true,
    fields: [
      num('height', '身高', 'height', 1.63, 1.3, 2.1, { unit: 'm', step: 0.01 }),
      choice('build', '體型', 'build', BUILDS, 'average'),
      choice('hair', '髮型', 'hair', [['short', '短髮'], ['long', '長髮'], ['bun', '包頭'], ['ponytail', '馬尾']], 'long'),
      choice('outfit', '服裝', 'outfit', [['pants', '褲裝'], ['skirt', '裙裝'], ['dress', '洋裝']], 'pants'),
      poseField(),
    ],
    bounds: (p) => characterBounds(String(p.pose), heightOf(p, 1.63), buildWidth(p.build)),
    anchors: (p) => characterAnchors(String(p.pose), heightOf(p, 1.63)),
  },
  {
    type: 'child',
    category: 'character',
    label: '小孩',
    en: 'Child',
    description: 'Child mannequin with larger head proportions. Front faces +Z.',
    icon: '🧒',
    defaultColor: '#ec8a2f',
    groundBased: true,
    fields: [num('height', '身高', 'height', 1.15, 0.7, 1.6, { unit: 'm', step: 0.01 }), poseField()],
    bounds: (p) => characterBounds(String(p.pose), heightOf(p, 1.15), 1.05),
    anchors: (p) => characterAnchors(String(p.pose), heightOf(p, 1.15)),
  },
  {
    type: 'passerby',
    category: 'character',
    label: '路人',
    en: 'Passerby',
    description: 'Background extra. Gender, height and pose are derived from the seed unless set.',
    icon: '🚶',
    defaultColor: '#8c9099',
    groundBased: true,
    fields: [
      seed(1),
      choice('gender', '性別', 'gender', [['auto', '隨機'], ['male', '男'], ['female', '女']], 'auto'),
      choice('pose', '姿勢', 'pose', PASSERBY_POSES, 'auto', { animatable: true }),
    ],
    bounds: (p) => {
      const t = passerbyTraits(n(p, 'seed', 1), String(p.gender));
      return characterBounds(p.pose === 'auto' ? t.pose : String(p.pose), t.height);
    },
    anchors: (p) => {
      const t = passerbyTraits(n(p, 'seed', 1), String(p.gender));
      return characterAnchors(p.pose === 'auto' ? t.pose : String(p.pose), t.height);
    },
  },
  {
    type: 'crowd',
    category: 'character',
    label: '人群',
    en: 'Crowd',
    description: 'Many static extras scattered in a rectangle, drawn as a single mesh (cheap).',
    icon: '👥',
    defaultColor: '#8c9099',
    groundBased: true,
    fields: [
      int('count', '人數', 'count', 30, 1, 400),
      num('width', '範圍寬', 'area width (X)', 20, 2, 500, { unit: 'm', step: 0.5 }),
      num('depth', '範圍深', 'area depth (Z)', 12, 2, 500, { unit: 'm', step: 0.5 }),
      choice('pose', '姿勢', 'poses', [['mixed', '混合'], ['stand', '站立'], ['walk', '行走'], ['sit', '坐']], 'mixed'),
      choice('facing', '面向', 'facing', [['random', '隨機'], ['forward', '朝前 (+Z)'], ['center', '朝中心']], 'random'),
      num('colorVariation', '顏色變化', 'color variation', 0.6, 0, 1, { step: 0.05 }),
      seed(7),
    ],
    bounds: (p) => box(n(p, 'width', 20), 1.95, n(p, 'depth', 12)),
    anchors: () => ({ head: [0, 1.6, 0], chest: [0, 1.25, 0], center: [0, 0.9, 0] }),
  },

  // Terrain ------------------------------------------------------------------
  {
    type: 'ground',
    category: 'terrain',
    label: '地面',
    en: 'Ground',
    description: 'Flat square ground plane at y = 0.',
    icon: '🟩',
    defaultColor: '#7d8b6a',
    groundBased: true,
    fields: [num('size', '尺寸', 'size', 200, 5, 5000, { unit: 'm', step: 5 })],
    bounds: (p) => ({ min: [-n(p, 'size', 200) / 2, -0.01, -n(p, 'size', 200) / 2], max: [n(p, 'size', 200) / 2, 0, n(p, 'size', 200) / 2] }),
  },
  {
    type: 'hills',
    category: 'terrain',
    label: '丘陵',
    en: 'Hills',
    description: 'Faceted low-poly hills from seeded noise; keeps a flat area in the middle.',
    icon: '⛰️',
    defaultColor: '#7f9466',
    groundBased: true,
    fields: [
      num('size', '尺寸', 'size', 300, 20, 5000, { unit: 'm', step: 5 }),
      num('height', '起伏高度', 'max height', 25, 0, 500, { unit: 'm', step: 0.5 }),
      num('scale', '起伏密度', 'noise frequency', 3, 0.5, 20, { step: 0.1 }),
      num('flatRadius', '平坦中心半徑', 'flat center radius', 25, 0, 2000, { unit: 'm', step: 1 }),
      int('segments', '細分', 'grid segments', 56, 8, 160, { advanced: true }),
      seed(3),
    ],
    bounds: (p) => {
      const s = n(p, 'size', 300);
      return { min: [-s / 2, 0, -s / 2], max: [s / 2, n(p, 'height', 25), s / 2] };
    },
  },
  {
    type: 'water',
    category: 'terrain',
    label: '水面',
    en: 'Water',
    description: 'Flat water surface slightly above ground.',
    icon: '🌊',
    defaultColor: '#4f86b0',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 80, 1, 5000, { unit: 'm', step: 1 }),
      num('depth', '深', 'depth', 80, 1, 5000, { unit: 'm', step: 1 }),
    ],
    bounds: (p) => box(n(p, 'width', 80), 0.03, n(p, 'depth', 80)),
  },
  {
    type: 'road',
    category: 'terrain',
    label: '道路',
    en: 'Road',
    description: 'Straight road running along the Z axis, with optional center line and sidewalks.',
    icon: '🛣️',
    defaultColor: '#55585e',
    groundBased: true,
    fields: [
      num('length', '長度', 'length (Z)', 60, 1, 2000, { unit: 'm', step: 1 }),
      num('width', '路寬', 'width', 7, 1, 50, { unit: 'm', step: 0.5 }),
      bool('centerLine', '中線', 'center line', true),
      bool('sidewalks', '人行道', 'sidewalks', true),
    ],
    bounds: (p) => {
      const w = n(p, 'width', 7) + (p.sidewalks === false ? 0 : 5);
      return box(w, 0.15, n(p, 'length', 60));
    },
  },

  // Architecture ---------------------------------------------------------------
  {
    type: 'wall',
    category: 'architecture',
    label: '牆',
    en: 'Wall',
    description: 'Straight wall along the X axis. Openings (doors/windows) are measured from the wall center.',
    icon: '🧱',
    defaultColor: '#d8d2c4',
    groundBased: true,
    fields: [
      num('length', '長度', 'length (X)', 4, 0.2, 100, { unit: 'm', step: 0.1 }),
      num('height', '高度', 'height', 2.8, 0.2, 30, { unit: 'm', step: 0.1 }),
      num('thickness', '厚度', 'thickness', 0.2, 0.02, 2, { unit: 'm', step: 0.01 }),
      {
        kind: 'list',
        key: 'openings',
        label: '開口（門/窗）',
        en: 'openings',
        hint: '窗台高 0 即為門',
        default: [],
        maxItems: 20,
        item: [
          num('offset', '位置', 'offset from center', 0, -50, 50, { unit: 'm', step: 0.1 }),
          num('width', '寬', 'width', 0.9, 0.1, 20, { unit: 'm', step: 0.05 }),
          num('height', '高', 'height', 2.1, 0.1, 30, { unit: 'm', step: 0.05 }),
          num('sill', '窗台高', 'sill height', 0, 0, 30, { unit: 'm', step: 0.05 }),
        ],
      },
    ],
    bounds: (p) => box(n(p, 'length', 4), n(p, 'height', 2.8), n(p, 'thickness', 0.2)),
  },
  {
    type: 'room',
    category: 'architecture',
    label: '房間',
    en: 'Room',
    description:
      'Rectangular room centered on its position: floor, 4 walls (north = -Z, south = +Z, east = +X, west = -X), optional ceiling, doors and windows. Walls facing the editor camera are cut away in the editor view only.',
    icon: '🏠',
    defaultColor: '#d8d2c4',
    groundBased: true,
    fields: [
      num('width', '寬（東西）', 'width (X)', 6, 1, 100, { unit: 'm', step: 0.1 }),
      num('depth', '深（南北）', 'depth (Z)', 5, 1, 100, { unit: 'm', step: 0.1 }),
      num('height', '高', 'height', 2.8, 1.5, 20, { unit: 'm', step: 0.1 }),
      num('wallThickness', '牆厚', 'wall thickness', 0.15, 0.02, 1, { unit: 'm', step: 0.01 }),
      bool('floor', '地板', 'floor', true),
      bool('ceiling', '天花板', 'ceiling', false),
      bool('cutaway', '編輯時剖開', 'cut away walls in editor', true),
      {
        kind: 'list',
        key: 'doors',
        label: '門',
        en: 'doors',
        default: [{ wall: 'south', offset: 1.5, width: 0.9, height: 2.1 }],
        maxItems: 12,
        item: [
          choice('wall', '牆面', 'wall', WALL_SIDES, 'south'),
          num('offset', '位置', 'offset from wall center', 0, -50, 50, { unit: 'm', step: 0.1 }),
          num('width', '寬', 'width', 0.9, 0.3, 10, { unit: 'm', step: 0.05 }),
          num('height', '高', 'height', 2.1, 0.5, 10, { unit: 'm', step: 0.05 }),
        ],
      },
      {
        kind: 'list',
        key: 'windows',
        label: '窗',
        en: 'windows',
        default: [{ wall: 'north', offset: 0, width: 1.6, height: 1.2, sill: 0.9 }],
        maxItems: 16,
        item: [
          choice('wall', '牆面', 'wall', WALL_SIDES, 'north'),
          num('offset', '位置', 'offset from wall center', 0, -50, 50, { unit: 'm', step: 0.1 }),
          num('width', '寬', 'width', 1.2, 0.2, 20, { unit: 'm', step: 0.05 }),
          num('height', '高', 'height', 1.2, 0.2, 10, { unit: 'm', step: 0.05 }),
          num('sill', '窗台高', 'sill height', 0.9, 0, 10, { unit: 'm', step: 0.05 }),
        ],
      },
    ],
    bounds: (p) => {
      const t = n(p, 'wallThickness', 0.15);
      return box(n(p, 'width', 6) + 2 * t, n(p, 'height', 2.8) + (p.ceiling ? t : 0), n(p, 'depth', 5) + 2 * t);
    },
    anchors: (p) => ({ center: [0, n(p, 'height', 2.8) / 2, 0], head: [0, 1.6, 0], chest: [0, 1.3, 0] }),
  },
  {
    type: 'building',
    category: 'architecture',
    label: '建築物',
    en: 'Building',
    description: 'Box building with floors, optional window grid and flat or gable roof.',
    icon: '🏢',
    defaultColor: '#b9bcc2',
    groundBased: true,
    fields: [
      num('width', '寬', 'width (X)', 12, 2, 200, { unit: 'm', step: 0.5 }),
      num('depth', '深', 'depth (Z)', 10, 2, 200, { unit: 'm', step: 0.5 }),
      int('floors', '樓層數', 'floors', 5, 1, 120),
      num('floorHeight', '樓高', 'floor height', 3.2, 2, 8, { unit: 'm', step: 0.1 }),
      choice('roof', '屋頂', 'roof', [['flat', '平頂'], ['gable', '斜頂']], 'flat'),
      bool('windows', '窗戶', 'windows', true),
    ],
    bounds: (p) => {
      const h = n(p, 'floors', 5) * n(p, 'floorHeight', 3.2);
      const roof = p.roof === 'gable' ? Math.min(n(p, 'width', 12), n(p, 'depth', 10)) * 0.3 : 0.5;
      return box(n(p, 'width', 12), h + roof, n(p, 'depth', 10));
    },
  },
  {
    type: 'house',
    category: 'architecture',
    label: '小屋',
    en: 'House',
    description: 'Small gable-roof house; door on the south (+Z) side.',
    icon: '🏡',
    defaultColor: '#d9c7a7',
    groundBased: true,
    fields: [
      num('width', '寬', 'width (X)', 8, 3, 40, { unit: 'm', step: 0.1 }),
      num('depth', '深', 'depth (Z)', 7, 3, 40, { unit: 'm', step: 0.1 }),
      num('wallHeight', '牆高', 'wall height', 3, 2, 12, { unit: 'm', step: 0.1 }),
      num('roofHeight', '屋頂高', 'roof height', 2.4, 0.5, 10, { unit: 'm', step: 0.1 }),
      bool('door', '門', 'door', true),
      bool('windows', '窗戶', 'windows', true),
    ],
    bounds: (p) => box(n(p, 'width', 8) + 0.6, n(p, 'wallHeight', 3) + n(p, 'roofHeight', 2.4), n(p, 'depth', 7) + 0.6),
  },
  {
    type: 'cityBlock',
    category: 'architecture',
    label: '城市街區',
    en: 'City block',
    description: 'Grid of random buildings with streets (seeded); single mesh, good for aerial shots.',
    icon: '🏙️',
    defaultColor: '#b9bcc2',
    groundBased: true,
    fields: [
      int('blocksX', '東西街廓數', 'blocks along X', 4, 1, 12),
      int('blocksZ', '南北街廓數', 'blocks along Z', 4, 1, 12),
      num('blockSize', '街廓尺寸', 'block size', 36, 10, 200, { unit: 'm', step: 1 }),
      num('streetWidth', '街道寬', 'street width', 12, 4, 60, { unit: 'm', step: 0.5 }),
      int('minFloors', '最少樓層', 'min floors', 2, 1, 100),
      int('maxFloors', '最多樓層', 'max floors', 22, 1, 150),
      num('density', '密度', 'density', 0.75, 0.1, 1, { step: 0.05 }),
      bool('roads', '路面', 'road surfaces', true),
      seed(11),
    ],
    bounds: (p) => {
      const bx = n(p, 'blocksX', 4) * (n(p, 'blockSize', 36) + n(p, 'streetWidth', 12));
      const bz = n(p, 'blocksZ', 4) * (n(p, 'blockSize', 36) + n(p, 'streetWidth', 12));
      return box(bx, n(p, 'maxFloors', 22) * 3.2, bz);
    },
    anchors: () => ({ center: [0, 20, 0] }),
  },
  {
    type: 'stairs',
    category: 'architecture',
    label: '樓梯',
    en: 'Stairs',
    description: 'Straight staircase; bottom step at the origin, ascending toward -Z.',
    icon: '🪜',
    defaultColor: '#a3a39d',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 1.2, 0.4, 20, { unit: 'm', step: 0.05 }),
      int('steps', '階數', 'steps', 12, 2, 60),
      num('rise', '級高', 'step rise', 0.17, 0.05, 0.4, { unit: 'm', step: 0.01 }),
      num('run', '級深', 'step run', 0.28, 0.15, 0.6, { unit: 'm', step: 0.01 }),
    ],
    bounds: (p) => {
      const s = n(p, 'steps', 12);
      return { min: [-n(p, 'width', 1.2) / 2, 0, -s * n(p, 'run', 0.28)], max: [n(p, 'width', 1.2) / 2, s * n(p, 'rise', 0.17), 0] };
    },
  },
  {
    type: 'pillar',
    category: 'architecture',
    label: '柱子',
    en: 'Pillar',
    description: 'Round or square column.',
    icon: '🏛️',
    defaultColor: '#d8d2c4',
    groundBased: true,
    fields: [
      num('height', '高', 'height', 3, 0.3, 50, { unit: 'm', step: 0.1 }),
      num('radius', '半徑', 'radius', 0.25, 0.05, 5, { unit: 'm', step: 0.01 }),
      choice('shape', '形狀', 'shape', [['round', '圓柱'], ['square', '方柱']], 'round'),
    ],
    bounds: (p) => box(n(p, 'radius', 0.25) * 2, n(p, 'height', 3), n(p, 'radius', 0.25) * 2),
  },

  // Props ----------------------------------------------------------------------
  {
    type: 'box',
    category: 'prop',
    label: '方塊',
    en: 'Box',
    description: 'Generic box, base on the ground.',
    icon: '📦',
    defaultColor: '#c9a26b',
    groundBased: true,
    fields: [
      num('width', '寬', 'width (X)', 1, 0.01, 500, { unit: 'm', step: 0.05 }),
      num('height', '高', 'height (Y)', 1, 0.01, 500, { unit: 'm', step: 0.05 }),
      num('depth', '深', 'depth (Z)', 1, 0.01, 500, { unit: 'm', step: 0.05 }),
    ],
    bounds: (p) => box(n(p, 'width', 1), n(p, 'height', 1), n(p, 'depth', 1)),
  },
  {
    type: 'sphere',
    category: 'prop',
    label: '球',
    en: 'Sphere',
    description: 'Low-poly sphere resting on the ground.',
    icon: '⚪',
    defaultColor: '#9aa4b2',
    groundBased: true,
    fields: [
      num('radius', '半徑', 'radius', 0.5, 0.01, 200, { unit: 'm', step: 0.05 }),
      int('detail', '細緻度', 'detail', 1, 0, 3, { advanced: true }),
    ],
    bounds: (p) => {
      const r = n(p, 'radius', 0.5);
      return { min: [-r, 0, -r], max: [r, 2 * r, r] };
    },
  },
  {
    type: 'cylinder',
    category: 'prop',
    label: '圓柱體',
    en: 'Cylinder',
    description: 'Low-poly cylinder.',
    icon: '🛢️',
    defaultColor: '#9aa4b2',
    groundBased: true,
    fields: [
      num('radius', '半徑', 'radius', 0.5, 0.01, 200, { unit: 'm', step: 0.05 }),
      num('height', '高', 'height', 1, 0.01, 500, { unit: 'm', step: 0.05 }),
      int('sides', '邊數', 'sides', 10, 3, 48, { advanced: true }),
    ],
    bounds: (p) => box(n(p, 'radius', 0.5) * 2, n(p, 'height', 1), n(p, 'radius', 0.5) * 2),
  },
  {
    type: 'cone',
    category: 'prop',
    label: '圓錐',
    en: 'Cone',
    description: 'Low-poly cone.',
    icon: '🔺',
    defaultColor: '#ec8a2f',
    groundBased: true,
    fields: [
      num('radius', '半徑', 'radius', 0.5, 0.01, 200, { unit: 'm', step: 0.05 }),
      num('height', '高', 'height', 1, 0.01, 500, { unit: 'm', step: 0.05 }),
      int('sides', '邊數', 'sides', 10, 3, 48, { advanced: true }),
    ],
    bounds: (p) => box(n(p, 'radius', 0.5) * 2, n(p, 'height', 1), n(p, 'radius', 0.5) * 2),
  },
  {
    type: 'plane',
    category: 'prop',
    label: '平板',
    en: 'Panel',
    description: 'Thin panel, lying on the floor or standing like a wall/screen (facing +Z).',
    icon: '▭',
    defaultColor: '#9aa4b2',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 2, 0.01, 1000, { unit: 'm', step: 0.05 }),
      num('height', '長/高', 'length or height', 2, 0.01, 1000, { unit: 'm', step: 0.05 }),
      choice('orientation', '方向', 'orientation', [['floor', '平放'], ['wall', '直立']], 'floor'),
    ],
    bounds: (p) =>
      p.orientation === 'wall'
        ? { min: [-n(p, 'width', 2) / 2, 0, -0.01], max: [n(p, 'width', 2) / 2, n(p, 'height', 2), 0.01] }
        : { min: [-n(p, 'width', 2) / 2, 0, -n(p, 'height', 2) / 2], max: [n(p, 'width', 2) / 2, 0.02, n(p, 'height', 2) / 2] },
  },
  {
    type: 'table',
    category: 'prop',
    label: '桌子',
    en: 'Table',
    description: 'Dining/meeting table.',
    icon: '🍽️',
    defaultColor: '#9c6b43',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 1.4, 0.3, 10, { unit: 'm', step: 0.05 }),
      num('depth', '深', 'depth', 0.8, 0.3, 10, { unit: 'm', step: 0.05 }),
      num('height', '高', 'height', 0.75, 0.3, 1.5, { unit: 'm', step: 0.01 }),
      choice('shape', '形狀', 'shape', [['rect', '方桌'], ['round', '圓桌']], 'rect'),
    ],
    bounds: (p) => (p.shape === 'round' ? box(n(p, 'width', 1.4), n(p, 'height', 0.75), n(p, 'width', 1.4)) : box(n(p, 'width', 1.4), n(p, 'height', 0.75), n(p, 'depth', 0.8))),
  },
  {
    type: 'chair',
    category: 'prop',
    label: '椅子',
    en: 'Chair',
    description: 'Chair facing +Z (backrest at -Z). Put a sitting character at the same position and rotation.',
    icon: '🪑',
    defaultColor: '#7a5a3a',
    groundBased: true,
    fields: [num('seatHeight', '座高', 'seat height', 0.45, 0.2, 1, { unit: 'm', step: 0.01 })],
    bounds: (p) => ({ min: [-0.24, 0, -0.26], max: [0.24, n(p, 'seatHeight', 0.45) + 0.5, 0.24] }),
  },
  {
    type: 'sofa',
    category: 'prop',
    label: '沙發',
    en: 'Sofa',
    description: 'Sofa facing +Z.',
    icon: '🛋️',
    defaultColor: '#5d6d7e',
    groundBased: true,
    fields: [num('width', '寬', 'width', 2.1, 0.8, 6, { unit: 'm', step: 0.05 })],
    bounds: (p) => box(n(p, 'width', 2.1), 0.85, 0.9),
  },
  {
    type: 'bed',
    category: 'prop',
    label: '床',
    en: 'Bed',
    description: 'Bed with headboard at -Z.',
    icon: '🛏️',
    defaultColor: '#e0dcd2',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 1.6, 0.8, 3, { unit: 'm', step: 0.05 }),
      num('length', '長', 'length', 2.05, 1.5, 3, { unit: 'm', step: 0.05 }),
    ],
    bounds: (p) => box(n(p, 'width', 1.6), 1.0, n(p, 'length', 2.05)),
  },
  {
    type: 'desk',
    category: 'prop',
    label: '書桌',
    en: 'Desk',
    description: 'Office desk with a monitor, user side at +Z.',
    icon: '🖥️',
    defaultColor: '#9c6b43',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 1.4, 0.6, 4, { unit: 'm', step: 0.05 }),
      num('depth', '深', 'depth', 0.7, 0.4, 2, { unit: 'm', step: 0.05 }),
      bool('monitor', '螢幕', 'monitor', true),
    ],
    bounds: (p) => box(n(p, 'width', 1.4), p.monitor === false ? 0.75 : 1.2, n(p, 'depth', 0.7)),
  },
  {
    type: 'door',
    category: 'prop',
    label: '門',
    en: 'Door',
    description: 'Door in a frame; hinge on the -X side, opens toward +Z. "open" (degrees) can be animated.',
    icon: '🚪',
    defaultColor: '#8a5a3c',
    groundBased: true,
    fields: [
      num('width', '寬', 'width', 0.9, 0.4, 3, { unit: 'm', step: 0.05 }),
      num('height', '高', 'height', 2.1, 1.5, 4, { unit: 'm', step: 0.05 }),
      num('open', '開啟角度', 'open angle', 0, 0, 120, { unit: '°', step: 1, animatable: true }),
    ],
    bounds: (p) => ({
      min: [-n(p, 'width', 0.9) / 2 - 0.06, 0, -0.06],
      max: [n(p, 'width', 0.9) / 2 + 0.06, n(p, 'height', 2.1) + 0.06, Math.max(0.06, n(p, 'width', 0.9) * Math.sin((n(p, 'open', 0) * Math.PI) / 180))],
    }),
  },
  {
    type: 'car',
    category: 'prop',
    label: '汽車',
    en: 'Car',
    description: 'Low-poly vehicle, front toward +Z.',
    icon: '🚗',
    defaultColor: '#c0392b',
    groundBased: true,
    fields: [choice('style', '車型', 'style', [['sedan', '轎車'], ['suv', '休旅車'], ['van', '廂型車'], ['truck', '卡車']], 'sedan')],
    bounds: (p) => {
      switch (p.style) {
        case 'suv':
          return box(1.9, 1.75, 4.7);
        case 'van':
          return box(2.0, 2.1, 5.0);
        case 'truck':
          return box(2.4, 3.0, 7.0);
        default:
          return box(1.8, 1.45, 4.5);
      }
    },
  },
  {
    type: 'tree',
    category: 'prop',
    label: '樹',
    en: 'Tree',
    description: 'Low-poly tree (broadleaf or pine).',
    icon: '🌳',
    defaultColor: '#4f8a3c',
    groundBased: true,
    fields: [
      choice('style', '樹種', 'style', [['round', '闊葉'], ['pine', '針葉']], 'round'),
      num('height', '高', 'height', 6, 1, 40, { unit: 'm', step: 0.1 }),
      color('trunkColor', '樹幹顏色', 'trunk color', '#6b4f3a'),
      seed(1),
    ],
    bounds: (p) => {
      const h = n(p, 'height', 6);
      const r = p.style === 'pine' ? 0.22 * h : 0.32 * h;
      return box(r * 2, h, r * 2);
    },
  },
  {
    type: 'bush',
    category: 'prop',
    label: '灌木',
    en: 'Bush',
    description: 'Low-poly bush.',
    icon: '🌿',
    defaultColor: '#5a8f45',
    groundBased: true,
    fields: [num('size', '大小', 'size', 1.2, 0.2, 6, { unit: 'm', step: 0.05 }), seed(2)],
    bounds: (p) => box(n(p, 'size', 1.2), n(p, 'size', 1.2) * 0.8, n(p, 'size', 1.2)),
  },
  {
    type: 'streetLight',
    category: 'prop',
    label: '路燈',
    en: 'Street light',
    description: 'Street lamp; the arm points toward +X.',
    icon: '💡',
    defaultColor: '#4a4d52',
    groundBased: true,
    fields: [num('height', '高', 'height', 5, 2, 15, { unit: 'm', step: 0.1 }), bool('arm', '燈臂', 'arm', true)],
    bounds: (p) => ({ min: [-0.2, 0, -0.2], max: [p.arm === false ? 0.2 : 1.4, n(p, 'height', 5) + 0.2, 0.2] }),
  },
  {
    type: 'bench',
    category: 'prop',
    label: '長椅',
    en: 'Bench',
    description: 'Park bench facing +Z.',
    icon: '🪵',
    defaultColor: '#7a5a3a',
    groundBased: true,
    fields: [num('width', '寬', 'width', 1.8, 0.6, 6, { unit: 'm', step: 0.05 })],
    bounds: (p) => box(n(p, 'width', 1.8), 0.85, 0.6),
  },

  // Camera & helpers -------------------------------------------------------------
  {
    type: 'camera',
    category: 'camera',
    label: '攝影機',
    en: 'Camera',
    description:
      'Shot camera. Settings live in the object\'s "camera" block (lens, focalLength, sensor, lookAt, follow, shake). rotation = [tilt, pan, roll]. Looks down -Z at rotation 0.',
    icon: '🎥',
    defaultColor: '#f0b429',
    groundBased: false,
    fields: [],
    bounds: () => ({ min: [-0.15, -0.15, -0.3], max: [0.15, 0.15, 0.15] }),
    anchors: () => ({ head: [0, 0, 0], chest: [0, 0, 0], center: [0, 0, 0], feet: [0, 0, 0] }),
  },
  {
    type: 'target',
    category: 'helper',
    label: '注視目標',
    en: 'Aim target',
    description: 'Invisible point (editor only) for cameras to look at or follow.',
    icon: '🎯',
    defaultColor: '#ff5c8a',
    editorOnly: true,
    groundBased: false,
    fields: [num('size', '大小', 'display size', 0.4, 0.05, 10, { unit: 'm', step: 0.05 })],
    bounds: (p) => {
      const s = n(p, 'size', 0.4) / 2;
      return { min: [-s, -s, -s], max: [s, s, s] };
    },
    anchors: () => ({ head: [0, 0, 0], chest: [0, 0, 0], center: [0, 0, 0], feet: [0, 0, 0] }),
  },
  {
    type: 'mark',
    category: 'helper',
    label: '走位標記',
    en: 'Floor mark',
    description: 'Actor floor mark (editor only), useful as a waypoint.',
    icon: '✚',
    defaultColor: '#ffd166',
    editorOnly: true,
    groundBased: true,
    fields: [num('size', '大小', 'size', 0.6, 0.1, 5, { unit: 'm', step: 0.05 })],
    bounds: (p) => box(n(p, 'size', 0.6), 0.02, n(p, 'size', 0.6)),
  },
];

const BY_TYPE = new Map<string, AssetTypeDef>(DEFS.map((d) => [d.type, d]));
const SCHEMAS = new Map<string, z.ZodObject>();

export function listAssetTypes(): readonly AssetTypeDef[] {
  return DEFS;
}

/** Plain-JSON description of every object type and its params (for agents / MCP / HTTP). */
export function assetTypeInfo() {
  return DEFS.map((d) => ({
    type: d.type,
    category: d.category,
    label: d.label,
    en: d.en,
    description: d.description,
    defaultColor: d.defaultColor,
    editorOnly: !!d.editorOnly,
    params: d.fields.map((f) => ({ ...f })),
  }));
}

export function getAssetType(type: string): AssetTypeDef | undefined {
  return BY_TYPE.get(type);
}

export function paramSchema(type: string): z.ZodObject | undefined {
  const def = BY_TYPE.get(type);
  if (!def) return undefined;
  let s = SCHEMAS.get(type);
  if (!s) {
    s = fieldsToZod(def.fields);
    SCHEMAS.set(type, s);
  }
  return s;
}

export function defaultParams(type: string): Params {
  const def = BY_TYPE.get(type);
  return def ? fieldDefaults(def.fields) : {};
}

export function isCharacterType(type: string): boolean {
  return BY_TYPE.get(type)?.category === 'character' && type !== 'crowd';
}

/** Resolve a named anchor (local coordinates) for an object type with params. */
export function localAnchor(type: string, params: Params, name: AnchorName): Vec3 {
  const def = BY_TYPE.get(type);
  if (!def) return [0, 0, 0];
  const a = def.anchors?.(params)?.[name];
  if (a) return a;
  const b = def.bounds(params);
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const h = b.max[1] - b.min[1];
  switch (name) {
    case 'head':
      return [cx, b.max[1], cz];
    case 'chest':
      return [cx, b.min[1] + h * 0.7, cz];
    case 'feet':
      return [cx, b.min[1], cz];
    default:
      return [cx, b.min[1] + h / 2, cz];
  }
}

/** Close-match suggestion for unknown type names (helps agents). */
export function suggestType(input: string): string | undefined {
  const s = input.toLowerCase();
  const aliases: Record<string, string> = {
    man: 'male', boy: 'child', girl: 'child', woman: 'female', lady: 'female', kid: 'child', person: 'male',
    human: 'male', people: 'crowd', extra: 'passerby', pedestrian: 'passerby', terrain: 'hills', floor: 'ground',
    plane: 'plane', street: 'road', city: 'cityBlock', skyscraper: 'building', home: 'house', lamp: 'streetLight',
    light: 'streetLight', vehicle: 'car', cam: 'camera', cube: 'box', column: 'pillar', staircase: 'stairs',
    couch: 'sofa', 男: 'male', 女: 'female', 男性: 'male', 女性: 'female', 小孩: 'child', 路人: 'passerby',
    人群: 'crowd', 地面: 'ground', 牆: 'wall', 房間: 'room', 建築: 'building', 攝影機: 'camera', 樹: 'tree',
  };
  if (aliases[s] || aliases[input]) return aliases[s] ?? aliases[input];
  let best: string | undefined;
  let bestScore = Infinity;
  for (const d of DEFS) {
    const score = editDistance(s, d.type.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = d.type;
    }
  }
  return bestScore <= 3 ? best : undefined;
}

export function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
