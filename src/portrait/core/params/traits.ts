/**
 * Trait vocabulary: common Chinese descriptions turned into parameter recipes. People and agents
 * apply them by name (with an amount, 1 = the recipe as written); the resulting parameters can
 * still be fine-tuned. Values are the recipe at amount 1, inside each parameter's realistic range.
 */
import { PARAM_BY_KEY } from './registry.ts';

export type TraitGroup = 'face' | 'eyes' | 'brow' | 'nose' | 'mouth' | 'chin' | 'other' | 'body';

export const TRAIT_GROUPS: { id: TraitGroup; label: string }[] = [
  { id: 'face', label: '臉型' },
  { id: 'eyes', label: '眼' },
  { id: 'brow', label: '眉' },
  { id: 'nose', label: '鼻' },
  { id: 'mouth', label: '嘴' },
  { id: 'chin', label: '下巴' },
  { id: 'other', label: '其他' },
  { id: 'body', label: '身材' },
];

export interface Trait {
  name: string;
  aliases?: string[];
  group: TraitGroup;
  params: Record<string, number>;
}

export const TRAITS: Trait[] = [
  // face shape
  // MakeHuman's oval target alone widens the face (like round); narrow it and taper the jaw and chin
  { name: '鵝蛋臉', group: 'face', params: { 'head.shape.oval': 0.2, 'head.width': -0.3, 'face.chin.width': -0.25, 'face.jaw.width': -0.2 } },
  { name: '圓臉', group: 'face', params: { 'head.shape.round': 0.5, 'head.fat': 0.3, 'face.chin.height': -0.2 } },
  { name: '方臉', aliases: ['國字臉'], group: 'face', params: { 'head.shape.square': 0.45, 'face.jaw.width': 0.6, 'face.jaw.angle': 0.5 } },
  { name: '瓜子臉', group: 'face', params: { 'head.shape.heart': 0.45, 'face.chin.width': -0.5, 'face.jaw.width': -0.5 } },
  { name: '長臉', group: 'face', params: { 'head.shape.long': 0.4, 'head.length': 0.4, 'face.chin.height': 0.3 } },
  { name: '菱形臉', group: 'face', params: { 'head.shape.diamond': 0.4, 'face.cheek.bones': 0.5, 'face.chin.width': -0.3 } },
  { name: '心形臉', group: 'face', params: { 'head.shape.heart': 0.55, 'head.temples': 0.3, 'face.chin.width': -0.4 } },
  { name: '小臉', group: 'face', params: { 'head.size': -0.5 } },
  { name: '骨感臉', group: 'face', params: { 'head.fat': -0.6, 'face.cheek.fullness': -0.5, 'face.cheek.bones': 0.4 } },
  { name: '肉肉臉', aliases: ['嬰兒肥'], group: 'face', params: { 'head.fat': 0.6, 'face.cheek.fullness': 0.5, 'face.cheek.apple': 0.4 } },

  // eyes
  { name: '丹鳳眼', aliases: ['鳳眼'], group: 'eyes', params: { 'face.eyes.tilt': 0.7, 'face.eyes.opening': -0.4, 'face.eyes.width': 0.3, 'face.eyes.lidCrease': -0.4 } },
  { name: '杏眼', group: 'eyes', params: { 'face.eyes.opening': 0.3, 'face.eyes.width': 0.2, 'face.eyes.tilt': 0.2 } },
  { name: '桃花眼', group: 'eyes', params: { 'face.eyes.tilt': 0.3, 'face.eyes.openingOuter': 0.3, 'face.eyes.lidCrease': 0.4, 'face.eyes.bags': 0.25 } },
  { name: '細長眼', group: 'eyes', params: { 'face.eyes.width': 0.6, 'face.eyes.opening': -0.5 } },
  { name: '大眼睛', group: 'eyes', params: { 'face.eyes.size': 0.6, 'face.eyes.opening': 0.4 } },
  { name: '小眼睛', group: 'eyes', params: { 'face.eyes.size': -0.5, 'face.eyes.opening': -0.3 } },
  { name: '單眼皮', group: 'eyes', params: { 'face.eyes.lidCrease': -0.8, 'face.eyes.epicanthus': 0.3 } },
  { name: '內雙', group: 'eyes', params: { 'face.eyes.lidCrease': 0.2, 'face.eyes.lidFold': -0.5 } },
  { name: '雙眼皮', group: 'eyes', params: { 'face.eyes.lidCrease': 0.7, 'face.eyes.lidFold': 0.3 } },
  { name: '深邃眼窩', aliases: ['眼窩深'], group: 'eyes', params: { 'face.brow.ridge': 0.7, 'face.eyes.lidCrease': 0.6 } },
  { name: '下垂眼', aliases: ['狗狗眼'], group: 'eyes', params: { 'face.eyes.tilt': -0.7 } },
  { name: '上揚眼', aliases: ['貓眼'], group: 'eyes', params: { 'face.eyes.tilt': 0.7 } },
  { name: '眼距寬', group: 'eyes', params: { 'face.eyes.spacing': 0.7 } },
  { name: '眼距窄', group: 'eyes', params: { 'face.eyes.spacing': -0.6 } },
  { name: '眼袋', group: 'eyes', params: { 'face.eyes.bags': 0.8 } },

  // brows
  { name: '劍眉', group: 'brow', params: { 'face.brow.tilt': 0.7, 'face.brow.height': -0.2, 'face.brow.thickness': 0.4, 'face.brow.density': 0.4, 'face.brow.arch': -0.3, 'face.brow.head': 0.4 } },
  { name: '八字眉', group: 'brow', params: { 'face.brow.tilt': -0.7, 'face.brow.arch': -0.3 } },
  { name: '一字眉', aliases: ['平眉'], group: 'brow', params: { 'face.brow.arch': -0.9, 'face.brow.peak': -0.3, 'face.brow.thickness': 0.2 } },
  { name: '柳葉眉', group: 'brow', params: { 'face.brow.arch': 0.4, 'face.brow.thickness': -0.5, 'face.brow.head': -0.4, 'face.brow.length': 0.3 } },
  { name: '挑眉', aliases: ['高挑眉'], group: 'brow', params: { 'face.brow.arch': 0.9, 'face.brow.peak': 0.2 } },
  { name: '濃眉', group: 'brow', params: { 'face.brow.density': 0.8, 'face.brow.thickness': 0.5 } },
  { name: '淡眉', aliases: ['眉毛稀疏'], group: 'brow', params: { 'face.brow.density': -0.8, 'face.brow.thickness': -0.2 } },
  { name: '粗眉', group: 'brow', params: { 'face.brow.thickness': 0.8 } },
  { name: '細眉', group: 'brow', params: { 'face.brow.thickness': -0.8 } },
  { name: '短眉', group: 'brow', params: { 'face.brow.length': -0.8 } },
  { name: '長眉', group: 'brow', params: { 'face.brow.length': 0.7 } },
  { name: '眉距寬', group: 'brow', params: { 'face.brow.gap': 0.8 } },
  { name: '眉距近', aliases: ['眉頭靠近'], group: 'brow', params: { 'face.brow.gap': -0.7 } },
  { name: '眉頭方', group: 'brow', params: { 'face.brow.head': 0.8 } },
  { name: '高眉骨', group: 'brow', params: { 'face.brow.ridge': 0.7 } },
  { name: '眉眼距近', group: 'brow', params: { 'face.brow.height': -0.6 } },
  { name: '不雕眉毛', aliases: ['古典無眉'], group: 'brow', params: { 'face.brow.relief': 0 } },
  { name: '眉毛平滑', aliases: ['無毛流'], group: 'brow', params: { 'face.brow.texture': 0 } },

  // nose
  { name: '高鼻樑', aliases: ['挺鼻'], group: 'nose', params: { 'face.nose.bridgeHeight': 0.7, 'face.nose.projection': 0.4 } },
  { name: '塌鼻', group: 'nose', params: { 'face.nose.bridgeHeight': -0.7, 'face.nose.projection': -0.4 } },
  { name: '鷹勾鼻', group: 'nose', params: { 'face.nose.curve': 0.7, 'face.nose.tipLift': -0.5, 'face.nose.hump': 0.4 } },
  { name: '蒜頭鼻', group: 'nose', params: { 'face.nose.tipRound': 0.8, 'face.nose.tipWidth': 0.6 } },
  { name: '朝天鼻', group: 'nose', params: { 'face.nose.tipLift': 0.8, 'face.nose.nostrilAngle': 0.7 } },
  { name: '駝峰鼻', group: 'nose', params: { 'face.nose.hump': 0.8, 'face.nose.curve': 0.3 } },
  { name: '小巧鼻', group: 'nose', params: { 'face.nose.length': -0.5, 'face.nose.width': -0.4, 'face.nose.projection': -0.2 } },
  { name: '鼻翼寬', group: 'nose', params: { 'face.nose.alarWidth': 0.7, 'face.nose.flare': 0.4 } },
  { name: '窄鼻樑', group: 'nose', params: { 'face.nose.bridgeWidth': -0.6 } },

  // mouth
  { name: '厚唇', group: 'mouth', params: { 'face.mouth.upperLip': 0.6, 'face.mouth.lowerLip': 0.6, 'face.mouth.upperLipVolume': 0.5, 'face.mouth.lowerLipVolume': 0.5 } },
  { name: '薄唇', group: 'mouth', params: { 'face.mouth.upperLip': -0.6, 'face.mouth.lowerLip': -0.6, 'face.mouth.upperLipVolume': -0.4, 'face.mouth.lowerLipVolume': -0.4 } },
  { name: '櫻桃小嘴', group: 'mouth', params: { 'face.mouth.width': -0.6, 'face.mouth.upperLipVolume': 0.3, 'face.mouth.lowerLipVolume': 0.4 } },
  { name: '大嘴', group: 'mouth', params: { 'face.mouth.width': 0.6 } },
  { name: 'M 唇', aliases: ['M唇'], group: 'mouth', params: { 'face.mouth.cupidsBow': 0.8, 'face.mouth.tubercle': 0.4 } },
  { name: '微笑唇', group: 'mouth', params: { 'face.mouth.corners': 0.6 } },
  { name: '嘴角下垂', group: 'mouth', params: { 'face.mouth.corners': -0.6 } },
  { name: '暴牙嘴', aliases: ['嘴凸'], group: 'mouth', params: { 'face.mouth.protrusion': 0.7 } },
  { name: '酒窩', group: 'mouth', params: { 'face.mouth.dimples': 0.8 } },

  // chin and jaw
  { name: '戽斗', group: 'chin', params: { 'face.chin.prognathism': 0.8, 'face.chin.projection': 0.4 } },
  { name: '小下巴', aliases: ['後縮下巴'], group: 'chin', params: { 'face.chin.projection': -0.6, 'face.chin.height': -0.4 } },
  { name: '方下巴', group: 'chin', params: { 'face.chin.width': 0.6, 'face.jaw.angle': 0.5 } },
  { name: '尖下巴', group: 'chin', params: { 'face.chin.width': -0.6, 'face.chin.height': 0.3 } },
  { name: '美人溝', group: 'chin', params: { 'face.chin.cleft': 0.8 } },
  { name: '雙下巴', group: 'chin', params: { 'face.chin.double': 0.8, 'head.fat': 0.3 } },
  { name: '下顎線明顯', group: 'chin', params: { 'face.jaw.angle': 0.7, 'face.chin.double': -0.5 } },

  // other
  { name: '高顴骨', group: 'other', params: { 'face.cheek.bones': 0.7, 'face.cheek.height': 0.3 } },
  { name: '蘋果肌', group: 'other', params: { 'face.cheek.apple': 0.7 } },
  { name: '凹陷臉頰', group: 'other', params: { 'face.cheek.fullness': -0.8 } },
  { name: '法令紋', group: 'other', params: { 'face.cheek.nasolabial': 0.7 } },
  { name: '招風耳', group: 'other', params: { 'face.ears.protrusion': 0.8 } },
  { name: '大耳垂', group: 'other', params: { 'face.ears.lobe': 0.8 } },
  { name: '高額頭', group: 'other', params: { 'head.foreheadHeight': 0.6 } },
  { name: '飽滿額頭', group: 'other', params: { 'head.foreheadSlope': 0.6, 'head.temples': 0.3 } },
  { name: '後腦勺扁', group: 'other', params: { 'head.occiput': -0.6 } },
  { name: '長脖子', group: 'other', params: { 'neck.length': 0.6 } },
  { name: '短脖子', group: 'other', params: { 'neck.length': -0.6, 'neck.thickness': 0.3 } },

  // body
  { name: '寬肩', group: 'body', params: { 'body.shoulderWidth': 0.7 } },
  { name: '窄肩', group: 'body', params: { 'body.shoulderWidth': -0.6 } },
  { name: '溜肩', group: 'body', params: { 'body.shoulderSlope': -0.7 } },
  { name: '平肩', aliases: ['直角肩'], group: 'body', params: { 'body.shoulderSlope': 0.6 } },
  { name: '沙漏身材', group: 'body', params: { 'body.waist': -0.6, 'body.hips': 0.5, 'body.bust': 0.4 } },
  { name: '梨形身材', group: 'body', params: { 'body.hips': 0.7, 'body.hipWidth': 0.5, 'body.shoulderWidth': -0.3 } },
  { name: '蘋果身材', group: 'body', params: { 'body.belly': 0.6, 'body.waist': 0.6 } },
  { name: '運動員體型', group: 'body', params: { 'base.muscle': 0.6, 'base.weight': -0.2, 'body.vShape': 0.5, 'body.shoulderWidth': 0.4 } },
  { name: '倒三角', group: 'body', params: { 'body.vShape': 0.8, 'body.shoulderWidth': 0.5 } },
  { name: '纖瘦', group: 'body', params: { 'base.weight': -0.6 } },
  { name: '豐滿', group: 'body', params: { 'base.weight': 0.5, 'body.breastSize': 0.5, 'body.hips': 0.3 } },
  { name: '啤酒肚', group: 'body', params: { 'body.belly': 0.8, 'base.weight': 0.2 } },
  { name: '長腿', group: 'body', params: { 'body.legLength': 0.7 } },
];

const BY_NAME = new Map<string, Trait>();
for (const t of TRAITS) for (const n of [t.name, ...(t.aliases ?? [])]) BY_NAME.set(n.replace(/\s+/g, ''), t);

export function findTrait(name: string): Trait | undefined {
  return BY_NAME.get(name.trim().replace(/\s+/g, ''));
}

/** Trait names containing any character of the query, for "did you mean" hints. */
export function suggestTraits(name: string, n = 5): string[] {
  const q = name.replace(/\s+/g, '');
  return TRAITS.map((t) => ({ t, s: [...q].filter((ch) => t.name.includes(ch) || t.aliases?.some((a) => a.includes(ch))).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.t.name);
}

/** Parameter values of a trait at an amount (1 = as written), relative to each default. */
export function traitValues(t: Trait, amount = 1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, v] of Object.entries(t.params)) {
    const def = PARAM_BY_KEY.get(key)?.def ?? 0;
    out[key] = def + (v - def) * amount;
  }
  return out;
}
