/**
 * Semantic parameter registry: the keys people and agents use (`face.nose.width`, `body.heightCm`)
 * with Traditional Chinese labels, ranges and how each drives the engine (MakeHuman modifiers,
 * macros, expression units, pose, absolute height and heads-tall). Parameter files only store
 * keys from here, so the backend can change without breaking them.
 *
 * Conventions: local shape parameters are −1…+1 (0 = unchanged; ±1 ≈ the realistic extreme,
 * up to ±2 allowed as exaggeration); macros are mixes (0…1) or centred −1…+1; absolute values
 * have units (years, cm, degrees). "Left" always means the figure's own left.
 */
import type { MacroVar } from '../mh/modifiers.ts';

export type ParamGroup = 'base' | 'head' | 'brow' | 'eyes' | 'nose' | 'mouth' | 'cheek' | 'chin' | 'ears' | 'neck' | 'body' | 'expr' | 'pose' | 'asym';

export const GROUPS: { id: ParamGroup; label: string }[] = [
  { id: 'base', label: '基本' },
  { id: 'head', label: '頭顱與臉型' },
  { id: 'brow', label: '眉' },
  { id: 'eyes', label: '眼' },
  { id: 'nose', label: '鼻' },
  { id: 'mouth', label: '嘴' },
  { id: 'cheek', label: '頰' },
  { id: 'chin', label: '下巴與下顎' },
  { id: 'ears', label: '耳' },
  { id: 'neck', label: '頸' },
  { id: 'body', label: '身體' },
  { id: 'expr', label: '表情' },
  { id: 'pose', label: '姿勢' },
  { id: 'asym', label: '左右差' },
];

/** value × factor, or [factor for negative values, factor for positive values]. */
export type Factor = number | [number, number];

export type PoseKey = 'headYaw' | 'headPitch' | 'headRoll' | 'armAngle' | 'elbow' | 'shoulderWidth' | 'shoulderLift';

/** Sculpted-eyebrow inputs (core/mh/brows.ts). */
export type BrowKey = 'relief' | 'density' | 'thickness' | 'length' | 'arch' | 'peak' | 'gap' | 'head' | 'texture' | 'asym';

export interface ParamDef {
  key: string;
  group: ParamGroup;
  label: string;
  /** What the low and high ends look like. */
  neg?: string;
  pos?: string;
  unit?: 'years' | 'cm' | 'deg' | 'ratio' | 'mix';
  /** Realistic range (sliders); `limit` is what is accepted (exaggeration). */
  range: [number, number];
  limit: [number, number];
  /** Default; null = automatic (derived from the other parameters). */
  def: number | null;
  step?: number;
  /** MakeHuman modifiers driven linearly; `{s}` expands to both sides (l, r). */
  mh?: Record<string, Factor>;
  /** Expression units (value 0…1 × weight). */
  expr?: Record<string, number>;
  macro?: MacroVar;
  /** Centred macro: MakeHuman value = 0.5 + 0.5·v. */
  centred?: boolean;
  special?: 'age' | 'ethnic' | 'heightCm' | 'headsTall' | 'gazeYaw' | 'gazePitch' | 'cranium';
  pose?: PoseKey;
  brow?: BrowKey;
}

const LOCAL: [number, number] = [-1, 1];
const EXAG: [number, number] = [-2, 2];

function local(key: string, group: ParamGroup, label: string, neg: string, pos: string, mh: Record<string, Factor>, limit: [number, number] = EXAG): ParamDef {
  return { key, group, label, neg, pos, range: LOCAL, limit, def: 0, step: 0.05, mh };
}
function single(key: string, group: ParamGroup, label: string, mh: Record<string, Factor>, range: [number, number] = [0, 1], limit: [number, number] = [0, 1.5]): ParamDef {
  return { key, group, label, neg: '無', pos: '明顯', range, limit, def: 0, step: 0.05, mh };
}
/** MakeHuman face shapes are strong at 1: realistic up to 0.6. */
const SHAPE: [[number, number], [number, number]] = [
  [0, 0.6],
  [0, 1],
];
function centredMacro(key: string, group: ParamGroup, label: string, neg: string, pos: string, macro: MacroVar): ParamDef {
  return { key, group, label, neg, pos, range: LOCAL, limit: LOCAL, def: 0, step: 0.05, macro, centred: true };
}
function expr(key: string, label: string, units: Record<string, number>): ParamDef {
  return { key, group: 'expr', label, neg: '無', pos: '強', range: [0, 1], limit: [0, 1.3], def: 0, step: 0.05, expr: units };
}
/** Eyebrow shape (the relief itself, not the skin): −1…+1, 0 = average for the sex and age. */
function brow(key: string, label: string, neg: string, pos: string, b: BrowKey, group: ParamGroup = 'brow'): ParamDef {
  return { key, group, label, neg, pos, range: LOCAL, limit: EXAG, def: 0, step: 0.05, brow: b };
}
function angle(key: string, group: ParamGroup, label: string, neg: string, pos: string, pose: PoseKey | null, range: [number, number], limit: [number, number], def = 0, special?: ParamDef['special']): ParamDef {
  return { key, group, label, neg, pos, unit: 'deg', range, limit, def, step: 1, ...(pose ? { pose } : {}), ...(special ? { special } : {}) };
}

export const PARAMS: ParamDef[] = [
  // ---- base ------------------------------------------------------------------------------------
  { key: 'base.sex', group: 'base', label: '性別', neg: '女', pos: '男', unit: 'mix', range: [0, 1], limit: [0, 1], def: 0.5, step: 0.01, macro: 'Gender' },
  { key: 'base.age', group: 'base', label: '年齡', unit: 'years', range: [18, 80], limit: [1, 90], def: 25, step: 1, special: 'age' },
  { key: 'base.eastAsian', group: 'base', label: '族群：東亞', unit: 'mix', range: [0, 1], limit: [0, 1], def: 0, step: 0.05, special: 'ethnic', macro: 'Asian' },
  { key: 'base.european', group: 'base', label: '族群：歐美', unit: 'mix', range: [0, 1], limit: [0, 1], def: 0, step: 0.05, special: 'ethnic', macro: 'Caucasian' },
  { key: 'base.african', group: 'base', label: '族群：非洲', unit: 'mix', range: [0, 1], limit: [0, 1], def: 0, step: 0.05, special: 'ethnic', macro: 'African' },
  centredMacro('base.weight', 'base', '體重', '瘦', '胖', 'Weight'),
  centredMacro('base.muscle', 'base', '肌肉', '少', '多', 'Muscle'),

  // ---- head and face shape -------------------------------------------------------------------------
  local('head.size', 'head', '頭部大小', '小', '大', { 'head/head-scale-horiz-decr|incr': 1, 'head/head-scale-vert-decr|incr': 1, 'head/head-scale-depth-decr|incr': 1 }),
  local('head.width', 'head', '頭寬', '窄', '寬', { 'head/head-scale-horiz-decr|incr': 1 }),
  local('head.length', 'head', '頭高（臉長）', '短', '長', { 'head/head-scale-vert-decr|incr': 1 }),
  local('head.depth', 'head', '頭部前後深度', '扁', '深', { 'head/head-scale-depth-decr|incr': 1 }),
  local('head.occiput', 'head', '後腦勺', '扁平', '突出', { 'head/head-back-scale-depth-decr|incr': 1 }),
  local('head.fat', 'head', '臉部肉感', '骨感', '圓潤', { 'head/head-fat-decr|incr': 1 }),
  local('head.age', 'head', '臉部年齡感', '年輕', '成熟', { 'head/head-age-decr|incr': 1 }),
  local('head.foreheadHeight', 'head', '額頭高度', '低', '高', { 'forehead/forehead-scale-vert-decr|incr': 1 }),
  local('head.foreheadSlope', 'head', '額頭傾斜', '後斜', '飽滿直立', { 'forehead/forehead-trans-backward|forward': 1 }),
  local('head.temples', 'head', '太陽穴', '凹陷', '飽滿', { 'forehead/forehead-temple-decr|incr': 1 }),
  // our own deformation (MakeHuman's head width scales the face with the skull): the skull above the brows only
  { key: 'head.craniumWidth', group: 'head', label: '頭顱寬度', neg: '窄（蛋形）', pos: '寬（圓）', range: LOCAL, limit: EXAG, def: 0, step: 0.05, special: 'cranium' },
  single('head.shape.oval', 'head', '臉型：鵝蛋', { 'head/head-oval': 1 }, ...SHAPE),
  single('head.shape.round', 'head', '臉型：圓', { 'head/head-round': 1 }, ...SHAPE),
  single('head.shape.square', 'head', '臉型：方（國字）', { 'head/head-square': 1 }, ...SHAPE),
  single('head.shape.long', 'head', '臉型：長方', { 'head/head-rectangular': 1 }, ...SHAPE),
  single('head.shape.triangle', 'head', '臉型：三角（下寬）', { 'head/head-triangular': 1 }, ...SHAPE),
  single('head.shape.heart', 'head', '臉型：心形（瓜子）', { 'head/head-invertedtriangular': 1 }, ...SHAPE),
  single('head.shape.diamond', 'head', '臉型：菱形', { 'head/head-diamond': 1 }, ...SHAPE),

  // ---- brows -------------------------------------------------------------------------------------
  local('face.brow.ridge', 'brow', '眉骨突出', '平', '突出', { 'eyebrows/eyebrows-trans-backward|forward': 0.6 }),
  local('face.brow.height', 'brow', '眉毛高低', '低', '高', { 'eyebrows/eyebrows-trans-down|up': 1 }),
  local('face.brow.tilt', 'brow', '眉尾角度', '下垂（八字眉）', '上揚（劍眉）', { 'eyebrows/eyebrows-angle-down|up': -1 }),
  // the eyebrows themselves: a relief on the skin (MakeHuman has none)
  { key: 'face.brow.relief', group: 'brow', label: '眉毛浮雕', neg: '不雕（古典石膏像）', pos: '明顯', range: [0, 1], limit: [0, 1.5], def: 1, step: 0.05, brow: 'relief' },
  brow('face.brow.density', '眉毛濃淡', '淡', '濃', 'density'),
  brow('face.brow.thickness', '眉毛粗細', '細', '粗', 'thickness'),
  brow('face.brow.length', '眉毛長度', '短', '長', 'length'),
  brow('face.brow.arch', '眉峰高度', '平直（一字眉）', '高挑', 'arch'),
  brow('face.brow.peak', '眉峰位置', '靠眉頭', '靠眉尾', 'peak'),
  brow('face.brow.gap', '眉間距', '近', '遠', 'gap'),
  brow('face.brow.head', '眉頭形狀', '漸淡尖細', '方鈍', 'head'),
  { key: 'face.brow.texture', group: 'brow', label: '毛流刻紋', neg: '平滑塊面', pos: '明顯毛流', range: [0, 1], limit: [0, 1], def: 0.6, step: 0.05, brow: 'texture' },

  // ---- eyes --------------------------------------------------------------------------------------
  local('face.eyes.size', 'eyes', '眼睛大小', '小', '大', { 'eyes/{s}-eye-scale-decr|incr': 1 }),
  local('face.eyes.width', 'eyes', '眼裂長度', '短', '長', { 'eyes/{s}-eye-push1-in|out': 1, 'eyes/{s}-eye-push2-in|out': 1 }),
  local('face.eyes.opening', 'eyes', '睜眼高度', '細', '圓', { 'eyes/{s}-eye-height1-decr|incr': 0.55, 'eyes/{s}-eye-height2-decr|incr': 0.55, 'eyes/{s}-eye-height3-decr|incr': 0.55 }),
  local('face.eyes.openingInner', 'eyes', '內側睜眼', '窄', '開', { 'eyes/{s}-eye-height1-decr|incr': 1 }),
  local('face.eyes.openingOuter', 'eyes', '外側睜眼', '窄', '開', { 'eyes/{s}-eye-height3-decr|incr': 1 }),
  local('face.eyes.spacing', 'eyes', '眼距', '近', '遠', { 'eyes/{s}-eye-trans-in|out': 1 }),
  local('face.eyes.height', 'eyes', '眼睛高低', '低', '高', { 'eyes/{s}-eye-trans-down|up': 1 }),
  local('face.eyes.tilt', 'eyes', '眼尾角度', '下垂', '上揚', { 'eyes/{s}-eye-corner1-down|up': 1, 'eyes/{s}-eye-corner2-down|up': -0.5 }),
  local('face.eyes.innerCorner', 'eyes', '內眼角高低', '低', '高', { 'eyes/{s}-eye-corner2-down|up': 1 }),
  local('face.eyes.lidCrease', 'eyes', '雙眼皮', '單眼皮（腫）', '深雙眼皮', { 'eyes/{s}-eye-eyefold-concave|convex': -1 }),
  local('face.eyes.lidFold', 'eyes', '眼皮摺線高低', '低（內雙）', '高', { 'eyes/{s}-eye-eyefold-down|up': 1 }),
  local('face.eyes.foldAngle', 'eyes', '摺線走向', '外側高', '內側高', { 'eyes/{s}-eye-eyefold-angle-down|up': 1 }),
  local('face.eyes.epicanthus', 'eyes', '內眥贅皮', '無', '明顯', { 'eyes/{s}-eye-epicanthus-in|out': 1 }),
  local('face.eyes.bags', 'eyes', '眼袋', '平', '明顯', { 'eyes/{s}-eye-bag-decr|incr': 1 }),
  local('face.eyes.bagHeight', 'eyes', '眼袋位置', '高', '低', { 'eyes/{s}-eye-bag-height-decr|incr': 1 }),
  angle('face.eyes.gazeYaw', 'eyes', '視線左右', '看右', '看左', null, [-30, 30], [-40, 40], 0, 'gazeYaw'),
  angle('face.eyes.gazePitch', 'eyes', '視線上下', '往下', '往上', null, [-20, 20], [-30, 30], 0, 'gazePitch'),

  // ---- nose --------------------------------------------------------------------------------------
  local('face.nose.length', 'nose', '鼻長', '短', '長', { 'nose/nose-scale-vert-decr|incr': 1 }),
  local('face.nose.width', 'nose', '鼻子寬度', '窄', '寬', { 'nose/nose-scale-horiz-decr|incr': 1 }),
  local('face.nose.projection', 'nose', '鼻子立體度', '扁', '挺', { 'nose/nose-scale-depth-decr|incr': 1 }),
  local('face.nose.height', 'nose', '鼻子位置', '低', '高', { 'nose/nose-trans-down|up': 1 }),
  local('face.nose.bridgeHeight', 'nose', '山根高度', '塌', '高', { 'nose/nose-greek-decr|incr': 1 }),
  local('face.nose.bridgeWidth', 'nose', '鼻樑寬度', '窄', '寬', { 'nose/nose-width1-decr|incr': 1, 'nose/nose-width2-decr|incr': 1 }),
  local('face.nose.alarWidth', 'nose', '鼻翼寬', '窄', '寬', { 'nose/nose-width3-decr|incr': 1 }),
  local('face.nose.flare', 'nose', '鼻翼外張', '收', '張', { 'nose/nose-flaring-decr|incr': 1 }),
  local('face.nose.nostrils', 'nose', '鼻孔大小', '小', '大', { 'nose/nose-nostrils-width-decr|incr': 1 }),
  local('face.nose.nostrilAngle', 'nose', '鼻孔角度', '朝下', '朝前', { 'nose/nose-nostrils-angle-down|up': 1 }),
  local('face.nose.tipWidth', 'nose', '鼻頭寬', '尖', '寬', { 'nose/nose-point-width-decr|incr': 1 }),
  local('face.nose.tipRound', 'nose', '鼻頭肉感', '少', '多（蒜頭）', { 'nose/nose-volume-decr|incr': 1 }),
  local('face.nose.tipLift', 'nose', '鼻尖角度', '下垂', '上翹', { 'nose/nose-point-down|up': 1 }),
  local('face.nose.curve', 'nose', '鼻背曲線', '凹', '凸（鷹勾）', { 'nose/nose-curve-concave|convex': 1 }),
  local('face.nose.hump', 'nose', '駝峰', '無', '明顯', { 'nose/nose-hump-decr|incr': 1 }),
  local('face.nose.columella', 'nose', '鼻小柱（鼻唇角）', '下垂', '上提', { 'nose/nose-septumangle-decr|incr': 1 }),
  local('face.nose.base', 'nose', '鼻底高低', '低', '高', { 'nose/nose-base-down|up': 1 }),

  // ---- mouth -------------------------------------------------------------------------------------
  local('face.mouth.width', 'mouth', '嘴寬', '窄', '寬', { 'mouth/mouth-scale-horiz-decr|incr': 1 }),
  local('face.mouth.height', 'mouth', '嘴的高低', '低', '高', { 'mouth/mouth-trans-down|up': 1 }),
  local('face.mouth.protrusion', 'mouth', '嘴唇突出', '內收', '前突', { 'mouth/mouth-trans-backward|forward': 1 }),
  local('face.mouth.upperLip', 'mouth', '上唇厚', '薄', '厚', { 'mouth/mouth-upperlip-height-decr|incr': 1 }),
  local('face.mouth.lowerLip', 'mouth', '下唇厚', '薄', '厚', { 'mouth/mouth-lowerlip-height-decr|incr': 1 }),
  local('face.mouth.upperLipVolume', 'mouth', '上唇豐滿', '扁', '豐', { 'mouth/mouth-upperlip-volume-decr|incr': 1 }),
  local('face.mouth.lowerLipVolume', 'mouth', '下唇豐滿', '扁', '豐', { 'mouth/mouth-lowerlip-volume-decr|incr': 1 }),
  local('face.mouth.cupidsBow', 'mouth', '唇峰', '平', '明顯', { 'mouth/mouth-cupidsbow-decr|incr': 1 }),
  local('face.mouth.cupidsBowWidth', 'mouth', '唇峰間距', '窄', '寬', { 'mouth/mouth-cupidsbow-width-decr|incr': 1 }),
  local('face.mouth.tubercle', 'mouth', '唇珠', '無', '明顯', { 'mouth/mouth-upperlip-middle-down|up': -1 }),
  local('face.mouth.corners', 'mouth', '嘴角', '下垂', '上揚', { 'mouth/mouth-angles-down|up': 1 }),
  local('face.mouth.philtrum', 'mouth', '人中深度', '淺', '深', { 'mouth/mouth-philtrum-volume-decr|incr': 1 }),
  local('face.mouth.dimples', 'mouth', '酒窩', '無', '深', { 'mouth/mouth-dimples-in|out': -1 }),

  // ---- cheeks ------------------------------------------------------------------------------------
  local('face.cheek.bones', 'cheek', '顴骨突出', '平', '高聳', { 'cheek/{s}-cheek-bones-decr|incr': 1 }),
  local('face.cheek.height', 'cheek', '顴骨高低', '低', '高', { 'cheek/{s}-cheek-trans-down|up': 1 }),
  local('face.cheek.fullness', 'cheek', '臉頰豐滿', '凹陷', '豐滿', { 'cheek/{s}-cheek-volume-decr|incr': 0.6 }),
  local('face.cheek.apple', 'cheek', '蘋果肌', '平', '飽滿', { 'cheek/{s}-cheek-inner-decr|incr': 1 }),
  single('face.cheek.nasolabial', 'cheek', '法令紋', { 'mouth/mouth-laugh-lines-in|out': -1 }),

  // ---- chin and jaw ------------------------------------------------------------------------------
  local('face.chin.height', 'chin', '下巴長度', '短', '長', { 'chin/chin-height-decr|incr': 1 }),
  local('face.chin.width', 'chin', '下巴寬度', '尖', '寬', { 'chin/chin-width-decr|incr': 1 }),
  local('face.chin.projection', 'chin', '下巴前突', '後縮', '前突', { 'chin/chin-prominent-decr|incr': 1 }),
  local('face.chin.prognathism', 'chin', '下顎前突（戽斗）', '後縮', '前突', { 'chin/chin-prognathism-decr|incr': 1 }),
  local('face.chin.cleft', 'chin', '美人溝', '無', '明顯', { 'chin/chin-cleft-decr|incr': 1 }),
  local('face.chin.double', 'chin', '雙下巴', '緊實', '明顯', { 'neck/neck-double-decr|incr': 1 }),
  local('face.jaw.angle', 'chin', '下顎角', '柔和', '明顯', { 'chin/chin-bones-decr|incr': 1 }),
  local('face.jaw.width', 'chin', '下顎寬', '窄（瓜子）', '寬（方）', { 'head/head-square': [0, 0.6], 'head/head-invertedtriangular': [-0.8, 0] }, [-1.5, 1.5]),

  // ---- ears --------------------------------------------------------------------------------------
  local('face.ears.size', 'ears', '耳朵大小', '小', '大', { 'ears/{s}-ear-scale-decr|incr': 1 }),
  local('face.ears.length', 'ears', '耳朵長度', '短', '長', { 'ears/{s}-ear-scale-vert-decr|incr': 1 }),
  local('face.ears.height', 'ears', '耳朵高低', '低', '高', { 'ears/{s}-ear-trans-down|up': 1 }),
  local('face.ears.forward', 'ears', '耳朵前後', '後', '前', { 'ears/{s}-ear-trans-backward|forward': 1 }),
  local('face.ears.tilt', 'ears', '耳朵傾斜', '後傾', '前傾', { 'ears/{s}-ear-rot-backward|forward': 1 }),
  local('face.ears.protrusion', 'ears', '招風耳', '貼頭', '外張', { 'ears/{s}-ear-wing-decr|incr': 1 }),
  local('face.ears.flap', 'ears', '耳輪外翻', '收', '翻', { 'ears/{s}-ear-flap-decr|incr': 1 }),
  local('face.ears.lobe', 'ears', '耳垂', '小', '大', { 'ears/{s}-ear-lobe-decr|incr': 1 }),
  local('face.ears.round', 'ears', '耳型方圓', '方', '圓', { 'ears/{s}-ear-shape-square|round': 1 }),
  local('face.ears.pointed', 'ears', '耳尖', '三角', '尖（精靈）', { 'ears/{s}-ear-shape-pointed|triangle': -1 }),

  // ---- neck --------------------------------------------------------------------------------------
  local('neck.length', 'neck', '脖子長度', '短', '長', { 'neck/neck-scale-vert-decr|incr': 1 }),
  local('neck.thickness', 'neck', '脖子粗細', '細', '粗', { 'neck/neck-scale-horiz-decr|incr': 1, 'neck/neck-scale-depth-decr|incr': 1 }),

  // ---- body --------------------------------------------------------------------------------------
  { key: 'body.heightCm', group: 'body', label: '身高', unit: 'cm', range: [140, 200], limit: [90, 240], def: null, step: 0.5, special: 'heightCm' },
  { key: 'body.headsTall', group: 'body', label: '頭身比', unit: 'ratio', range: [6, 9], limit: [4, 10], def: null, step: 0.05, special: 'headsTall' },
  centredMacro('body.proportions', 'body', '身材比例', '不尋常', '理想', 'BodyProportions'),
  { key: 'body.shoulderWidth', group: 'body', label: '肩寬', neg: '窄', pos: '寬', range: LOCAL, limit: EXAG, def: 0, step: 0.05, pose: 'shoulderWidth' },
  { key: 'body.shoulderSlope', group: 'body', label: '肩膀斜度', neg: '溜肩', pos: '平肩', range: LOCAL, limit: EXAG, def: 0, step: 0.05, pose: 'shoulderLift' },
  local('body.torsoWidth', 'body', '軀幹寬度', '窄', '寬', { 'torso/torso-scale-horiz-decr|incr': 1 }),
  local('body.chestDepth', 'body', '胸廓厚度', '薄', '厚', { 'torso/torso-scale-depth-decr|incr': 1 }),
  local('body.torsoLength', 'body', '軀幹長度', '短', '長', { 'torso/torso-scale-vert-decr|incr': 1 }),
  local('body.vShape', 'body', '倒三角身形', '直筒', '倒三角', { 'torso/torso-vshape-decr|incr': 1 }),
  local('body.pecs', 'body', '胸肌', '平', '發達', { 'torso/torso-muscle-pectoral-decr|incr': 1 }),
  local('body.lats', 'body', '背闊肌', '平', '發達', { 'torso/torso-muscle-dorsi-decr|incr': 1 }),
  centredMacro('body.breastSize', 'body', '胸部大小', '小', '大', 'BreastSize'),
  centredMacro('body.breastFirmness', 'body', '胸部挺度', '柔軟下垂', '挺', 'BreastFirmness'),
  local('body.breastLift', 'body', '胸部位置', '低', '高', { 'breast/breast-trans-down|up': 1 }),
  local('body.breastSpacing', 'body', '胸部間距', '近', '遠', { 'breast/breast-dist-decr|incr': 1 }),
  local('body.breastPoint', 'body', '胸型', '圓', '尖挺', { 'breast/breast-point-decr|incr': 1 }),
  local('body.breastUpper', 'body', '上胸豐滿', '下半豐滿', '上半豐滿', { 'breast/breast-volume-vert-down|up': 1 }),
  local('body.bust', 'body', '胸圍', '小', '大', { 'measure/measure-bust-circ-decr|incr': 1 }),
  local('body.waist', 'body', '腰圍', '細', '粗', { 'measure/measure-waist-circ-decr|incr': 1 }),
  local('body.hips', 'body', '臀圍', '小', '大', { 'measure/measure-hips-circ-decr|incr': 1 }),
  local('body.waistHeight', 'body', '腰線高低', '低', '高', { 'hip/hip-waist-down|up': 1 }),
  local('body.hipWidth', 'body', '骨盆寬', '窄', '寬', { 'hip/hip-scale-horiz-decr|incr': 1 }),
  local('body.belly', 'body', '腹部', '平坦', '凸出', { 'stomach/stomach-pregnant-decr|incr': 1 }),
  local('body.buttocks', 'body', '臀部', '扁', '翹', { 'buttocks/buttocks-volume-decr|incr': 1 }),
  local('body.armLength', 'body', '手臂長度', '短', '長', { 'armslegs/{s}-upperarm-scale-horiz-decr|incr': 1, 'armslegs/{s}-lowerarm-scale-horiz-decr|incr': 1 }),
  local('body.armFat', 'body', '手臂脂肪', '細', '粗', { 'armslegs/{s}-upperarm-fat-decr|incr': 1, 'armslegs/{s}-lowerarm-fat-decr|incr': 1 }),
  local('body.armMuscle', 'body', '手臂肌肉', '少', '發達', { 'armslegs/{s}-upperarm-muscle-decr|incr': 1, 'armslegs/{s}-lowerarm-muscle-decr|incr': 1, 'armslegs/{s}-upperarm-shoulder-muscle-decr|incr': 1 }),
  local('body.legLength', 'body', '腿長', '短', '長', { 'armslegs/upperlegs-height-decr|incr': 1, 'armslegs/lowerlegs-height-decr|incr': 1 }),
  local('body.legFat', 'body', '腿部脂肪', '細', '粗', { 'armslegs/{s}-upperleg-fat-decr|incr': 1, 'armslegs/{s}-lowerleg-fat-decr|incr': 1 }),
  local('body.legMuscle', 'body', '腿部肌肉', '少', '發達', { 'armslegs/{s}-upperleg-muscle-decr|incr': 1, 'armslegs/{s}-lowerleg-muscle-decr|incr': 1 }),
  local('body.handSize', 'body', '手掌大小', '小', '大', { 'armslegs/{s}-hand-scale-decr|incr': 1 }),
  local('body.footSize', 'body', '腳掌大小', '小', '大', { 'armslegs/{s}-foot-scale-decr|incr': 1 }),

  // ---- expressions (static) ----------------------------------------------------------------------
  expr('expr.smile', '微笑', { 'mouth-corner-puller': 0.6, 'mouth-upward-retraction': 0.1, 'eye-left-slit': 0.2, 'eye-right-slit': 0.2 }),
  expr('expr.mouthOpen', '嘴微張', { 'mouth-open': 0.3, 'mouth-parling': 0.55 }),
  expr('expr.browRaise', '挑眉', { 'eyebrows-left-up': 1.3, 'eyebrows-right-up': 1.3, 'eye-left-opened-up': 0.4, 'eye-right-opened-up': 0.4 }),
  expr('expr.frown', '皺眉', { 'eyebrows-left-down': 1, 'eyebrows-right-down': 1, 'eyebrows-left-inner-up': 0.25, 'eyebrows-right-inner-up': 0.25 }),
  expr('expr.squint', '瞇眼', { 'eye-left-slit': 0.55, 'eye-right-slit': 0.55, 'eye-left-closure': 0.08, 'eye-right-closure': 0.08 }),

  // ---- pose --------------------------------------------------------------------------------------
  angle('pose.headYaw', 'pose', '頭部左右轉', '轉向右', '轉向左', 'headYaw', [-45, 45], [-75, 75]),
  angle('pose.headPitch', 'pose', '抬頭低頭', '低頭', '抬頭', 'headPitch', [-25, 25], [-40, 40]),
  angle('pose.headRoll', 'pose', '頭部側傾', '向右肩', '向左肩', 'headRoll', [-20, 20], [-30, 30]),
  angle('pose.arms', 'pose', '手臂張開角度', '下垂', '張開', 'armAngle', [0, 45], [-5, 90], 10),
  angle('pose.elbow', 'pose', '手肘彎曲', '伸直', '彎曲', 'elbow', [0, 60], [0, 120], 10),

  // ---- asymmetry (positive = the figure's left side higher / bigger / shifted left) ------------
  local('asym.eyes.height', 'asym', '左右眼高低差', '右眼高', '左眼高', { 'eyes/l-eye-trans-down|up': 0.5, 'eyes/r-eye-trans-down|up': -0.5 }),
  local('asym.eyes.size', 'asym', '左右眼大小差', '右眼大', '左眼大', { 'eyes/l-eye-scale-decr|incr': 0.5, 'eyes/r-eye-scale-decr|incr': -0.5 }),
  brow('asym.brow.height', '左右眉高低差', '右眉高', '左眉高', 'asym', 'asym'),
  local('asym.ears.height', 'asym', '左右耳高低差', '右耳高', '左耳高', { 'ears/l-ear-trans-down|up': 0.5, 'ears/r-ear-trans-down|up': -0.5 }),
  local('asym.cheek.height', 'asym', '左右顴骨高低差', '右高', '左高', { 'cheek/l-cheek-trans-down|up': 0.5, 'cheek/r-cheek-trans-down|up': -0.5 }),
  local('asym.nose.shift', 'asym', '鼻子偏移', '偏右', '偏左', { 'nose/nose-trans-in|out': 0.5 }),
  local('asym.mouth.shift', 'asym', '嘴巴偏移', '偏右', '偏左', { 'mouth/mouth-trans-in|out': 0.5 }),
  local('asym.mouth.corner', 'asym', '嘴角高低差', '右高', '左高', { 'asym/asym-mouth-1-l': [0, 1], 'asym/asym-mouth-1-r': [-1, 0] }, [-1.5, 1.5]),
];

export const PARAM_BY_KEY = new Map(PARAMS.map((p) => [p.key, p]));

/** Expand `{s}` patterns of a modifier id to both sides. */
export function expandSides(id: string): string[] {
  return id.includes('{s}') ? [id.replace('{s}', 'l'), id.replace('{s}', 'r')] : [id];
}
