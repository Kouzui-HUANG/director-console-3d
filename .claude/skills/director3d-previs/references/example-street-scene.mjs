// Worked example: 「誰先給台階」 — 15 s, 4 cuts, a couple walking toward camera on a Taipei arcade sidewalk.
// Built with previs-kit.mjs. Read this when you need a full build.mjs to copy patterns from:
// a street set, blocking computed from timing functions, a lead stopping with ease-out, props riding on
// the leads, extras and a scooter that are always moving, a backward-tracking camera, static cameras.
// Usage: node build.mjs projects/<id>.json
import * as kit from './previs-kit.mjs';

const FILE = process.argv[2];
const END = 15;
const S = kit.createScene({ duration: END });
const { add } = S;
const { keys } = kit;

// ---------------------------------------------------------------------------
// Timing + blocking (walk direction = +Z, toward the cameras). Change these, regenerate, re-check.
// ---------------------------------------------------------------------------
const Y0 = 0.02; // sidewalk plane thickness
const V = 1.5; // brisk walk (the user asked for faster than 1.1)
const SHE_X = 0.35;
const sheStepT = 8.8; // third step shorter: cubic ease-out over 0.5 s
const sheStopT = 9.3;
const sheZ0 = 9.51 - (V * sheStepT + kit.easeOutDistance(V, sheStopT - sheStepT));
const sheZ = (t) => {
  if (t <= sheStepT) return sheZ0 + V * t;
  const d = kit.easeOutDistance(V, sheStopT - sheStepT);
  if (t >= sheStopT) return sheZ0 + V * sheStepT + d;
  return sheZ0 + V * sheStepT + d * kit.applyEase((t - sheStepT) / (sheStopT - sheStepT), 'out');
};
const SHIFT0 = 14.5, SHIFT1 = 14.85; // her weight shifts → cut
const sheShift = [0.025, 0, 0.02];

// He: half a step behind, catches up, falls back, slows at 6.0, stops at 7.2 (ease-out).
const heKeys = [
  [0, -0.35, sheZ(0) - 0.35, 'linear'],
  [3.0, -0.35, sheZ(3.0) - 0.35, 'linear'],
  [3.9, -0.25, sheZ(3.9), 'linear'],
  [4.5, -0.22, sheZ(4.5), 'linear'],
  [5.5, -0.38, sheZ(5.5) - 0.18, 'linear'],
  [6.0, -0.45, sheZ(6.0) - 0.3, 'out'],
];
const heV = (heKeys[5][2] - heKeys[4][2]) / 0.5;
const HE_STOP_T = 7.2;
const HE_STOP_Z = heKeys[5][2] + kit.easeOutDistance(heV, HE_STOP_T - 6.0);
heKeys.push([HE_STOP_T, -0.45, HE_STOP_Z, 'linear']);
const GL0 = 9.7, GLm = 9.85, GL1 = 10.05; // sunglasses flicked down
const hePos = heKeys.map(([t, x, z, e]) => [t, [x, Y0, z], e]);
const heYaw = [[0, 15, 'linear'], [4.6, 15, 'inOut'], [5.6, 0, 'linear'], [6.0, 0, 'inOut'], [HE_STOP_T, 9, 'linear']];

// ---------------------------------------------------------------------------
// Set: west (−X) street trees + road, east (+X) arcade shopfronts.
// ---------------------------------------------------------------------------
add({ id: 'ground', type: 'ground', name: '地面', color: '#8c8a83', params: { size: 160 } });
add({ id: 'road', type: 'road', name: '車道', color: '#5a5c60', position: [-6, 0, -10], params: { length: 150, width: 7, centerLine: true, sidewalks: false } });
add({ id: 'sidewalk', type: 'plane', name: '人行道（紅磚）', color: '#a9806a', position: [0.15, 0, -10], params: { width: 3.7, height: 150, orientation: 'floor' } });
add({ id: 'curb', type: 'box', name: '路緣石', color: '#a3a29b', position: [-2.5, 0, -10], params: { width: 0.18, height: 0.14, depth: 150 } });
add({ id: 'arcadeFloor', type: 'plane', name: '騎樓地面', color: '#bdb19c', position: [3.6, 0, -10], params: { width: 2.8, height: 150, orientation: 'floor' } });
add({ id: 'farWalk', type: 'plane', name: '對面人行道', color: '#a58a78', position: [-11, 0, -10], params: { width: 3, height: 150, orientation: 'floor' } });

// Street trees 7 m apart → shade / sun patches. Sun az 240, el 50: kit.shadowOffset(240, 50, 4) ≈ [2.9, −1.7],
// so crown shadows land on the sidewalk ~1.7 m north of each trunk. Shift the row so the script's
// "he stops in the sun, she in shade" is true at their stop points.
let ti = 0;
for (let z = -60.3 + (HE_STOP_Z - 4.7); z <= 40; z += 7) {
  ti++;
  add({ id: `tree${ti}`, type: 'tree', name: `行道樹 ${ti}`, color: ti % 3 === 0 ? '#5d8f3f' : '#4f8a3c', position: [-2.05, 0, z + (((ti * 13) % 5) - 2) * 0.12], params: { style: 'round', height: 5.2 + ((ti * 37) % 9) / 10, trunkColor: '#6b4f3a', seed: ti } });
}
for (const [i, z] of [[1, -13.5], [2, 13.5], [3, -40.5]]) add({ id: `lamp${i}`, type: 'streetLight', name: '路燈', position: [-2.3, 0, z], rotation: [0, 180, 0], params: { height: 6 } });

// Arcade: pillars + upper floors overhanging + recessed shopfronts.
const bColors = ['#cbbfa9', '#b9b2a4', '#d3c4a2', '#aaa79e', '#c8b59b', '#bfb7ab', '#d6cbb8'];
const shopColors = ['#6b625a', '#5d5853', '#71665a', '#625e58', '#5a5650'];
for (let z = -70, bi = 1; z < 42; bi++) {
  const w = 4 + ((bi * 7) % 4);
  const cz = z + w / 2;
  add({ id: `upper${bi}`, type: 'building', name: `騎樓樓上 ${bi}`, color: bColors[bi % bColors.length], position: [6.0, 3.6, cz], params: { width: 7.8, depth: w - 0.05, floors: 2 + ((bi * 5) % 3), floorHeight: 3.1, roof: 'flat', windows: true } });
  add({ id: `shop${bi}`, type: 'box', name: `店面 ${bi}`, color: shopColors[bi % shopColors.length], position: [7.4, 0, cz], params: { width: 5.0, height: 3.6, depth: w - 0.1 } });
  add({ id: `pillar${bi}`, type: 'pillar', name: `騎樓柱 ${bi}`, color: '#d9d0bf', position: [2.25, 0, z + 0.25], params: { height: 3.6, radius: 0.24, shape: 'square' } });
  z += w;
}
for (let z = -72, fi = 1; z < 42; fi++) {
  const w = 6 + ((fi * 5) % 5);
  add({ id: `far${fi}`, type: 'building', name: `對面街屋 ${fi}`, color: bColors[(fi + 3) % bColors.length], position: [-16.5, 0, z + w / 2], params: { width: 8, depth: w - 0.1, floors: 3 + ((fi * 3) % 4), floorHeight: 3.2, roof: 'flat', windows: true } });
  z += w;
}
add({ id: 'endBldg', type: 'building', name: '街底大樓', color: '#b3b8bd', position: [-2, 0, -96], params: { width: 34, depth: 12, floors: 9, floorHeight: 3.2 } });

// Background detail from the script: a hardware-shop owner hosing the floor (in-place action, so he may stand).
const HW_Z = -30;
add({ id: 'hwShop', type: 'box', name: '五金行店面', color: '#4f5a52', position: [7.4, 0, HW_Z], params: { width: 5.02, height: 3.62, depth: 5.2 } });
add({ id: 'hwShelf', type: 'box', name: '五金貨架', color: '#8a8f94', position: [4.75, 0, HW_Z - 1.6], params: { width: 0.5, height: 1.6, depth: 1.6 } });
add({ id: 'hwBucketR', type: 'cylinder', name: '紅水桶', color: '#c0392b', position: [4.6, 0, HW_Z + 1.3], params: { radius: 0.18, height: 0.32 } });
add({ id: 'hwBucketB', type: 'cylinder', name: '藍水桶', color: '#2f6fb0', position: [4.6, 0.32, HW_Z + 1.3], params: { radius: 0.17, height: 0.3 } });
add({ id: 'hwBox', type: 'box', name: '紙箱', color: '#b08a5a', position: [4.7, 0, HW_Z + 2.0], params: { width: 0.5, height: 0.45, depth: 0.5 } });
add({ id: 'hwOwner', type: 'passerby', name: '五金行老闆（沖地）', color: '#7a7f86', position: [3.7, 0, HW_Z + 0.2], rotation: [0, -110, 0], params: { seed: 4, gender: 'male', pose: 'point' } });
// Flickering water: color is animatable. Keep keys inside 0..END.
const flick = [];
for (let i = 0; i * 0.4 <= END; i++) flick.push([i * 0.4, i % 2 ? '#e6eef2' : '#8fa6b4', 'linear']);
add({ id: 'hwWater', type: 'water', name: '沖地的水', color: '#8fa6b4', position: [2.9, 0.005, HW_Z + 0.3], params: { width: 2.2, depth: 2.6 }, tracks: { color: keys(flick) } });

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------
const sheTimes = [0, sheStepT, sheStopT, SHIFT0, SHIFT1];
const sheP = (t) => (t >= SHIFT1 ? [SHE_X + sheShift[0], Y0, sheZ(t) + sheShift[2]] : [SHE_X, Y0, sheZ(t)]);
const shePos = sheTimes.map((t) => [t, sheP(t), t === sheStepT ? 'out' : t === SHIFT0 ? 'inOut' : 'linear']);
const sheYaw = [[0, 0, 'linear'], [4.45, 0, 'inOut'], [4.62, 18, 'inOut'], [5.0, 0, 'linear'], [SHIFT0, 0, 'inOut'], [SHIFT1, -4, 'linear']];
add({
  id: 'she', type: 'female', name: '她', color: '#6f8fb0', position: sheP(0),
  params: { height: 1.62, build: 'slim', hair: 'long', outfit: 'skirt', pose: 'walk' },
  note: '不放慢的步子；托特包先在靠他那側（右肩），CUT2 換到左肩。抿嘴、拇指搓背帶等表演人偶做不出來，見 markers。',
  tracks: { position: keys(shePos), rotation: keys(sheYaw.map(([t, y, e]) => [t, [0, y, 0], e])), 'params.pose': keys([[0, 'walk'], [sheStopT, 'stand']]) },
});
// Tote on her right shoulder (toward him) → left shoulder at 4.5–4.9. Offsets are [right, up, forward] in her frame.
const bagOffsets = [[4.5, [0.24, 0.78, -0.03], 'linear'], [4.6, [0.16, 0.84, 0.12], 'linear'], [4.75, [-0.02, 0.93, 0.2], 'linear'], [4.9, [-0.24, 0.78, -0.03]]];
kit.attached(S, { id: 'tote', parent: 'she', name: '米白托特包', color: '#efe7d6', params: { width: 0.3, height: 0.34, depth: 0.11 }, pos: shePos, yaw: sheYaw, offset: (t) => kit.sample(bagOffsets, t) });

// He is mirrored (scale x = −1) so the one-armed "point" pose reaches with the arm on her side.
add({
  id: 'he', type: 'male', name: '他', color: '#e8792b', position: hePos[0][1], rotation: [0, 15, 0], scale: [-1, 1, 1],
  params: { height: 1.78, build: 'average', pose: 'walk' },
  note: '橘色花襯衫、七分褲、啪噠響的涼鞋、墨鏡推在頭頂。scale x = −1 只是鏡像，讓勾背帶的手在她那側。',
  tracks: {
    position: keys(hePos),
    rotation: keys(heYaw.map(([t, y, e]) => [t, [0, y, 0], e])),
    'params.pose': keys([[0, 'walk'], [4.0, 'point'], [5.5, 'walk'], [HE_STOP_T, 'stand'], [9.65, 'raiseHand'], [GL1, 'stand']]),
  },
});
// Sunglasses pushed up on his head (1.78 m male: up 1.685, forward 0.075, pitch 35) → on his eyes (1.648, 0.098, 0).
const up = (t) => kit.sample([[GL0, 1, 'linear'], [GLm, 0.4, 'linear'], [GL1, 0]], t);
kit.attached(S, {
  id: 'shades', parent: 'he', name: '墨鏡', color: '#141414', params: { width: 0.18, height: 0.045, depth: 0.05 },
  pos: hePos, yaw: heYaw, extraTimes: [GL0, GLm, GL1],
  offset: (t) => [0, 1.685 * up(t) + 1.648 * (1 - up(t)), 0.075 * up(t) + 0.098 * (1 - up(t))],
  rot: (t, y) => [35 * up(t), y, 0],
});

// ---------------------------------------------------------------------------
// Extras: every one is walking from t = 0 to the end; none starts or stops on camera.
// ---------------------------------------------------------------------------
kit.walker(S, { id: 'pbArcade', name: '騎樓下走遠的人', seed: 11, gender: 'female', at: [3.5, -13], heading: 180, speed: 1.0, y: Y0 });
kit.walker(S, { id: 'pbBehind', name: '後方同向行人', seed: 23, gender: 'male', at: [-1.15, -36], heading: 0, speed: 1.0, y: Y0 });
kit.walker(S, { id: 'pbFar1', name: '遠處行人', seed: 31, at: [0.9, -44], heading: 0, speed: 1.2, y: Y0 });
kit.walker(S, { id: 'pbFar2', name: '對面行人', seed: 8, at: [-11, -30], heading: 0, speed: 1.25, y: Y0 });
kit.walker(S, { id: 'pbFar3', name: '對面行人', seed: 17, at: [-10.6, 5], heading: 180, speed: 1.2, y: Y0 });
add({ id: 'pbPhone', type: 'passerby', name: '騎樓下講電話', position: [3.9, 0, -44], rotation: [0, -70, 0], params: { seed: 5, gender: 'female', pose: 'phone' } });
// The far end of the street: moving walkers, not a crowd mesh (a crowd in pose walk looks frozen).
for (const [id, x, z, heading, speed] of [['pbFar4', -0.8, -52, 180, 1.1], ['pbFar5', 1.3, -66, 0, 1.0], ['pbFar6', 0.3, -60, 0, 1.3], ['pbFar7', 3.4, -55, 180, 1.05], ['pbFar8', -1.4, -70, 0, 1.2], ['pbFar9', 4.0, -63, 0, 0.95]]) {
  kit.walker(S, { id, name: '街底行人', seed: 60 + Number(id.slice(5)), at: [x, z], heading, speed, y: Y0 });
}

// CUT 3 business. Anchor each crossing at the moment the script needs it, the kit stretches it back to t = 0.
kit.walker(S, { id: 'pcDown', name: '從她身旁往北走', seed: 41, gender: 'male', at: [1.1, 8], atT: 13.5, heading: 180, speed: 1.25, y: Y0 });
// Up the curb side from behind the camera, turns into the arcade at 8.3 s (behind him), on north under the arcade.
kit.pathWalker(S, { id: 'pcBehind', name: '從他身後橫穿', seed: 52, gender: 'female', points: [[-1.5, 20], [-1.5, HE_STOP_Z - 2.4], [3.0, HE_STOP_Z - 0.66], [3.0, -10]], speed: 1.52, anchor: [1, 8.3], y: Y0 });
// Up the arcade from behind the camera, cuts across between them at 9.4 s, on north along the trees.
kit.pathWalker(S, { id: 'pcCross', name: '從兩人中間橫穿', seed: 77, gender: 'female', points: [[3.0, 30], [3.0, 7.6], [-1.7, 7.6 - 4.7 / 5.3], [-1.7, -10]], speed: 1.4, anchor: [1, 9.4], y: Y0 });
// Scooter north-bound in the lane next to the curb (Taiwan keeps right); passes the CUT 3 camera and enters its frame at 11.2 s.
kit.scooter(S, { id: 'scooter', at: [-4.4, -3.5], atT: 11.2, heading: 180, speed: 11 });

// ---------------------------------------------------------------------------
// Cameras (no depth of field in the app: "失焦" is only distance + long lens)
// ---------------------------------------------------------------------------
// CUT 1 — stabilizer walking backward in front of them: follow + lag, walk shake 0.2, long lens.
kit.camera(S, {
  id: 'cut1', name: 'CUT1 倒退跟拍 中全景', position: [0, 1.57, -3.5], rig: 'dolly', focalLength: 60,
  follow: { target: 'she', offset: [-0.35, 1.55, 6.6], space: 'world', lag: 0.2 },
  lookAt: { target: 'she', point: null, aim: 'feet', offset: [-0.35, 1.22, -0.17] }, // aim between them, headroom kept
  shake: { preset: 'walk', amount: 0.2, seed: 3 },
});
// CUT 2 — the long take follows HER (does not stop with him); it brakes when she stops (follow lag).
kit.camera(S, {
  id: 'cut2', name: 'CUT2 長拍 跟著她走', position: [0, 1.57, 2], rig: 'dolly', focalLength: 85,
  follow: { target: 'she', offset: [-0.35, 1.55, 6.3], space: 'world', lag: 0.25 },
  lookAt: { target: 'she', point: null, aim: 'feet', offset: [-0.35, 1.38, -0.08] },
  shake: { preset: 'walk', amount: 0.2, seed: 5 },
});
// CUT 3 — "behind her" literally can't see him (he is behind her): camera at her shoulder looking back at him.
kit.camera(S, { id: 'cut3', name: 'CUT3 她肩旁反打 他 中全景（固定）', position: [0.2, 1.45, 11.5], focalLength: 63.2, lookAt: { target: 'he', point: null, aim: 'feet', offset: [0, 1.193, 0] } });
// CUT 4 — the only shot closer than the base distance: her face, him a blur over her shoulder.
kit.camera(S, { id: 'cut4', name: 'CUT4 她的臉 中近景（固定）', position: [0.62, 1.53, 13.67], focalLength: 100, lookAt: { target: 'she', point: null, aim: 'feet', offset: [0, 1.393, 0] } });

kit.writeProject(FILE, S, {
  name: '誰先給台階',
  notes: '鬧彆扭裡的拉鋸：誰先給台階。初秋午後台北老城區人行道，一側騎樓、一側行道樹。基準距離＝倒退走在兩人前方幾步的同行者。',
  settings: { fps: 24, environment: { preset: 'day', skyColor: null, sunAzimuth: 240, sunElevation: 50, fog: true, fogDensity: 0.22, shadows: true } },
  cuts: [{ t: 0, camera: 'cut1' }, { t: 3, camera: 'cut2' }, { t: 9.6, camera: 'cut3' }, { t: 12.7, camera: 'cut4' }],
  markers: [
    { t: 0.2, label: '男：「欸，走慢一點啦，我穿拖鞋欸。」（涼鞋啪噠啪噠）' },
    { t: 3, label: 'CUT2 長拍開始' },
    { t: 3.6, label: '男：「那個……你上次講那家，叫什麼？去吃啊。」' },
    { t: 4.0, label: '他勾住背帶' },
    { t: 4.5, label: '她肩膀一轉，換肩，手壓背帶' },
    { t: 5.45, label: '他的手停一拍才垂下' },
    { t: 6.0, label: '他慢下來' },
    { t: HE_STOP_T, label: '他停住：啪噠聲斷' },
    { t: sheStepT, label: '她第三步短了一截' },
    { t: sheStopT, label: '她停下（沒回頭）→ 鏡頭煞住' },
    { t: 9.6, label: 'CUT3 第一顆靜止鏡頭' },
    { t: GL0, label: '墨鏡往下一撥' },
    { t: 10.2, label: '雙手插進口袋' },
    { t: 10.4, label: '男：「你夠了喔。」（平，不挑不壓）' },
    { t: 12.7, label: 'CUT4 她的臉：抿嘴、吸氣、拇指搓背帶' },
    { t: SHIFT0, label: '重心動了一下 → 切' },
  ],
});
