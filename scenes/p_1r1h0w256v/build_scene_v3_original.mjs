// Generates the project JSON for 「誰先給台階」 (4 cuts, 15 s; extras always in motion).
// Usage: node build_scene.mjs <projectFile>
import fs from 'node:fs';

const file = process.argv[2];
const base = JSON.parse(fs.readFileSync(file, 'utf8'));

const r3 = (v) => v.map((n) => Math.round(n * 1000) / 1000);
const objects = [];
const add = (o) => {
  objects.push({ name: '', color: '#9aa4b2', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, params: {}, tracks: {}, ...o });
  return o;
};
const keys = (list) => ({ keys: list.map(([t, v, ease]) => ({ t, v: Array.isArray(v) ? r3(v) : v, ...(ease ? { ease } : {}) })) });

// ---------------------------------------------------------------------------
// Blocking (meters / seconds). Walk direction = +Z (toward the cameras).
// ---------------------------------------------------------------------------
const Y0 = 0.02; // sidewalk plane thickness
const V = 1.5; // walking speed (brisk)
// 她: constant pace until 8.8, third step shorter (cubic ease-out over 0.5 s => v*T/3), stops 9.3.
const SHE_X = 0.35;
const sheStepT = 8.8;
const sheStopT = 9.3;
const sheZ0 = 9.51 - (V * sheStepT + (V * (sheStopT - sheStepT)) / 3);
const sheZ = (t) => {
  if (t <= sheStepT) return sheZ0 + V * t;
  const d = (V * (sheStopT - sheStepT)) / 3;
  if (t >= sheStopT) return sheZ0 + V * sheStepT + d;
  const u = (t - sheStepT) / (sheStopT - sheStepT);
  return sheZ0 + V * sheStepT + d * (1 - (1 - u) ** 3);
};
const SHE_STOP = sheZ(sheStopT); // ≈ 9.51
const sheShift = [0.025, 0, 0.02]; // 重心動了一下 (14.5 → 14.85)
const SHIFT0 = 14.5, SHIFT1 = 14.85;

// 他: half a step behind, catches up in CUT 2, falls back, slows at 6.0 and stops at 7.2.
const heKeys = [
  // t, x, z, ease
  [0, -0.35, sheZ(0) - 0.35, 'linear'],
  [3.0, -0.35, sheZ(3.0) - 0.35, 'linear'],
  [3.9, -0.25, sheZ(3.9), 'linear'],
  [4.5, -0.22, sheZ(4.5), 'linear'],
  [5.5, -0.38, sheZ(5.5) - 0.18, 'linear'],
  [6.0, -0.45, sheZ(6.0) - 0.3, 'out'],
];
const heV = (heKeys[5][2] - heKeys[4][2]) / (6.0 - 5.5);
const HE_STOP_T = 7.2;
const HE_STOP_Z = heKeys[5][2] + (heV * (HE_STOP_T - 6.0)) / 3; // cubic ease-out from walking speed
heKeys.push([HE_STOP_T, -0.45, HE_STOP_Z, 'linear']);
const HE = { x: -0.45, z: HE_STOP_Z };
// 墨鏡往下一撥 (CUT 3)
const GL0 = 9.7, GLm = 9.85, GL1 = 10.05;

function heAt(t) {
  for (let i = 0; i < heKeys.length - 1; i++) {
    const [t1, x1, z1, e] = heKeys[i];
    const [t2, x2, z2] = heKeys[i + 1];
    if (t >= t1 && t <= t2) {
      let u = (t - t1) / (t2 - t1);
      if (e === 'out') u = 1 - (1 - u) ** 3;
      return [x1 + (x2 - x1) * u, z1 + (z2 - z1) * u];
    }
  }
  const last = heKeys[heKeys.length - 1];
  return [last[1], last[2]];
}
// his yaw (deg, + = turn left toward her at +X)
const heYawKeys = [
  [0, 15, 'linear'],
  [4.6, 15, 'inOut'],
  [5.6, 0, 'linear'],
  [6.0, 0, 'inOut'],
  [HE_STOP_T, 9, 'linear'],
];
function yawAt(t) {
  for (let i = 0; i < heYawKeys.length - 1; i++) {
    const [t1, a, e] = heYawKeys[i];
    const [t2, b] = heYawKeys[i + 1];
    if (t >= t1 && t <= t2) {
      let u = (t - t1) / (t2 - t1);
      if (e === 'inOut') u = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
      return a + (b - a) * u;
    }
  }
  return heYawKeys[heYawKeys.length - 1][1];
}

// ---------------------------------------------------------------------------
// Set: 初秋午後的老城區人行道。西側 (−X) 行道樹＋車道，東側 (+X) 騎樓店面。
// ---------------------------------------------------------------------------
add({ id: 'ground', type: 'ground', name: '地面', color: '#8c8a83', params: { size: 160 } });
add({ id: 'road', type: 'road', name: '車道', color: '#5a5c60', position: [-6, 0, -10], params: { length: 150, width: 7, centerLine: true, sidewalks: false } });
add({ id: 'sidewalk', type: 'plane', name: '人行道（紅磚）', color: '#a9806a', position: [0.15, 0, -10], params: { width: 3.7, height: 150, orientation: 'floor' } });
add({ id: 'curb', type: 'box', name: '路緣石', color: '#a3a29b', position: [-2.5, 0, -10], params: { width: 0.18, height: 0.14, depth: 150 } });
add({ id: 'arcadeFloor', type: 'plane', name: '騎樓地面', color: '#bdb19c', position: [3.6, 0, -10], params: { width: 2.8, height: 150, orientation: 'floor' } });
add({ id: 'farWalk', type: 'plane', name: '對面人行道', color: '#a58a78', position: [-11, 0, -10], params: { width: 3, height: 150, orientation: 'floor' } });

// 行道樹: shadow of each crown lands ~1.5 m north of the trunk (sun from WSW, 50°).
// Spacing 7 m → 一塊樹蔭一塊日光; his stop point sits in a sun gap, hers in shade.
let ti = 0;
for (let z = -60.3 + (HE_STOP_Z - 4.7); z <= 40; z += 7) {
  ti++;
  const h = 5.2 + ((ti * 37) % 9) / 10; // 5.2–6.0
  add({ id: `tree${ti}`, type: 'tree', name: `行道樹 ${ti}`, color: ti % 3 === 0 ? '#5d8f3f' : '#4f8a3c', position: [-2.05, 0, z + (((ti * 13) % 5) - 2) * 0.12], params: { style: 'round', height: h, trunkColor: '#6b4f3a', seed: ti } });
}
add({ id: 'lamp1', type: 'streetLight', name: '路燈', position: [-2.3, 0, -13.5], rotation: [0, 180, 0], params: { height: 6 } });
add({ id: 'lamp2', type: 'streetLight', name: '路燈', position: [-2.3, 0, 13.5], rotation: [0, 180, 0], params: { height: 6 } });
add({ id: 'lamp3', type: 'streetLight', name: '路燈', position: [-2.3, 0, -40.5], rotation: [0, 180, 0], params: { height: 6 } });

// 騎樓: pillars + upper floors overhanging the arcade + recessed shopfronts.
const bColors = ['#cbbfa9', '#b9b2a4', '#d3c4a2', '#aaa79e', '#c8b59b', '#bfb7ab', '#d6cbb8'];
const shopColors = ['#6b625a', '#5d5853', '#71665a', '#625e58', '#5a5650'];
let bi = 0;
for (let z = -70; z < 42; ) {
  bi++;
  const w = 4 + ((bi * 7) % 4); // 4–7 m wide shopfronts
  const cz = z + w / 2;
  const floors = 2 + ((bi * 5) % 3);
  add({ id: `upper${bi}`, type: 'building', name: `騎樓樓上 ${bi}`, color: bColors[bi % bColors.length], position: [6.0, 3.6, cz], params: { width: 7.8, depth: w - 0.05, floors, floorHeight: 3.1, roof: 'flat', windows: true } });
  add({ id: `shop${bi}`, type: 'box', name: `店面 ${bi}`, color: shopColors[bi % shopColors.length], position: [7.4, 0, cz], params: { width: 5.0, height: 3.6, depth: w - 0.1 } });
  add({ id: `pillar${bi}`, type: 'pillar', name: `騎樓柱 ${bi}`, color: '#d9d0bf', position: [2.25, 0, z + 0.25], params: { height: 3.6, radius: 0.24, shape: 'square' } });
  z += w;
}
// 對面街屋
let fi = 0;
for (let z = -72; z < 42; ) {
  fi++;
  const w = 6 + ((fi * 5) % 5);
  const floors = 3 + ((fi * 3) % 4);
  add({ id: `far${fi}`, type: 'building', name: `對面街屋 ${fi}`, color: bColors[(fi + 3) % bColors.length], position: [-16.5, 0, z + w / 2], params: { width: 8, depth: w - 0.1, floors, floorHeight: 3.2, roof: 'flat', windows: true } });
  z += w;
}
add({ id: 'endBldg', type: 'building', name: '街底大樓', color: '#b3b8bd', position: [-2, 0, -96], params: { width: 34, depth: 12, floors: 9, floorHeight: 3.2 } });

// 五金行 (background of CUT 1): goods under the arcade, the owner hosing the floor.
const HW_Z = -30;
add({ id: 'hwShop', type: 'box', name: '五金行店面', color: '#4f5a52', position: [7.4, 0, HW_Z], params: { width: 5.02, height: 3.62, depth: 5.2 } });
add({ id: 'hwShelf', type: 'box', name: '五金貨架', color: '#8a8f94', position: [4.75, 0, HW_Z - 1.6], params: { width: 0.5, height: 1.6, depth: 1.6 } });
add({ id: 'hwBucketR', type: 'cylinder', name: '紅水桶', color: '#c0392b', position: [4.6, 0, HW_Z + 1.3], params: { radius: 0.18, height: 0.32 } });
add({ id: 'hwBucketB', type: 'cylinder', name: '藍水桶', color: '#2f6fb0', position: [4.6, 0.32, HW_Z + 1.3], params: { radius: 0.17, height: 0.3 } });
add({ id: 'hwBox', type: 'box', name: '紙箱', color: '#b08a5a', position: [4.7, 0, HW_Z + 2.0], params: { width: 0.5, height: 0.45, depth: 0.5 } });
add({ id: 'hwOwner', type: 'passerby', name: '五金行老闆（沖地）', color: '#7a7f86', position: [3.7, 0, HW_Z + 0.2], rotation: [0, -110, 0], params: { seed: 4, gender: 'male', pose: 'point' } });
// 水光一閃一閃: the wet patch flickers between two tones (color is animatable).
const flick = [];
for (let i = 0; i <= 38; i++) flick.push([i * 0.4, i % 2 ? '#e6eef2' : '#8fa6b4', 'linear']);
add({ id: 'hwWater', type: 'water', name: '沖地的水', color: '#8fa6b4', position: [2.9, 0.005, HW_Z + 0.3], params: { width: 2.2, depth: 2.6 }, tracks: { color: keys(flick) } });

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------
// 她
const sheTimes = [0, 4.5, 4.6, 4.75, 4.9, sheStepT, sheStopT, SHIFT0, SHIFT1];
const sheP = (t) => {
  const p = [SHE_X, Y0, sheZ(t)];
  if (t >= SHIFT1) return [p[0] + sheShift[0], Y0, p[2] + sheShift[2]];
  return p;
};
add({
  id: 'she', type: 'female', name: '她', color: '#6f8fb0', position: sheP(0),
  params: { height: 1.62, build: 'slim', hair: 'long', outfit: 'skirt', pose: 'walk' },
  note: '不放慢的步子；托特包先在靠他那側（右肩），CUT2 換到左肩。抿嘴、拇指搓背帶等表演人偶做不出來，見 markers。',
  tracks: {
    position: keys(sheTimes.map((t) => [t, sheP(t), t === sheStepT ? 'out' : t === SHIFT0 ? 'inOut' : 'linear'])),
    rotation: keys([[0, [0, 0, 0], 'linear'], [4.45, [0, 0, 0], 'inOut'], [4.62, [0, 18, 0], 'inOut'], [5.0, [0, 0, 0], 'linear'], [SHIFT0, [0, 0, 0], 'inOut'], [SHIFT1, [0, -4, 0], 'linear']]),
    'params.pose': keys([[0, 'walk'], [sheStopT, 'stand']]),
  },
});
// 米白托特包 (box) riding on her shoulder: right (−X, toward him) → left (+X) at 4.5–4.9.
const bagOff = (t) => {
  if (t <= 4.5) return [-0.24, 0.8, -0.03];
  if (t <= 4.6) return [-0.16, 0.86, 0.12];
  if (t <= 4.75) return [0.02, 0.95, 0.2];
  return [0.24, 0.8, -0.03];
};
add({
  id: 'tote', type: 'box', name: '米白托特包', color: '#efe7d6', params: { width: 0.3, height: 0.34, depth: 0.11 },
  position: [SHE_X - 0.24, 0.8, sheZ0 - 0.03],
  tracks: {
    position: keys(sheTimes.map((t) => {
      const p = sheP(t);
      const o = bagOff(t);
      return [t, [p[0] + o[0], o[1], p[2] + o[2]], t === sheStepT ? 'out' : t === SHIFT0 ? 'inOut' : 'linear'];
    })),
  },
});

// 他 (mirrored with scale x = −1 so his reaching "point" pose uses the arm on her side)
const heTimes = [...new Set([...heKeys.map((k) => k[0]), 4.6, 5.6, GL0, GL1])].sort((a, b) => a - b);
add({
  id: 'he', type: 'male', name: '他', color: '#e8792b', position: [heKeys[0][1], Y0, heKeys[0][2]], rotation: [0, 15, 0], scale: [-1, 1, 1],
  params: { height: 1.78, build: 'average', pose: 'walk' },
  note: '橘色花襯衫、七分褲、啪噠響的涼鞋、墨鏡推在頭頂。scale x = −1 只是鏡像，讓勾背帶的手在她那側。',
  tracks: {
    position: keys(heTimes.map((t) => { const [x, z] = heAt(t); return [t, [x, Y0, z], t === 6.0 ? 'out' : 'linear']; })),
    rotation: keys(heYawKeys.map(([t, y, e]) => [t, [0, y, 0], e])),
    'params.pose': keys([[0, 'walk'], [4.0, 'point'], [5.5, 'walk'], [HE_STOP_T, 'stand'], [9.65, 'raiseHand'], [GL1, 'stand']]),
  },
});
// 墨鏡: pushed up on his head, flicked down onto his eyes in CUT 3.
const shadesOn = GL1;
const shadesKeysT = [...heTimes, GLm];
const shadesAt = (t) => {
  const [x, z] = heAt(t);
  const yaw = yawAt(t);
  const up = t < GL0 ? 1 : t >= shadesOn ? 0 : t < GLm ? 0.6 : 0.2;
  const ly = 1.705 * up + 1.668 * (1 - up);
  const lz = 0.075 * up + 0.098 * (1 - up);
  const a = (yaw * Math.PI) / 180;
  return [[x + lz * Math.sin(a), Y0 + ly, z + lz * Math.cos(a)], [35 * up, yaw, 0]];
};
add({
  id: 'shades', type: 'box', name: '墨鏡', color: '#141414', params: { width: 0.18, height: 0.045, depth: 0.05 },
  position: shadesAt(0)[0], rotation: shadesAt(0)[1],
  tracks: {
    position: keys(shadesKeysT.sort((a, b) => a - b).map((t) => [t, shadesAt(t)[0], t === 6.0 ? 'out' : 'linear'])),
    rotation: keys([...heYawKeys.map(([t, y, e]) => [t, [35, y, 0], e]), [GL0, [35, 9, 0], 'linear'], [GLm, [20, 9, 0], 'linear'], [shadesOn, [0, 9, 0], 'linear']]),
  },
});

// Background extras (CUT 1–2): nobody walks into the couple's path.
const walker = (id, name, seed, gender, x, z0, t0, t1, speed, dir) => {
  const zA = z0, zB = z0 + dir * speed * (t1 - t0);
  add({ id, type: 'passerby', name, position: [x, Y0, zA], rotation: [0, dir > 0 ? 0 : 180, 0], params: { seed, gender, pose: 'walk' },
    tracks: { position: keys([[t0, [x, Y0, zA], 'linear'], [t1, [x, Y0, zB]]]) } });
};
walker('pbArcade', '騎樓下走遠的人', 11, 'female', 3.5, -13, 0, 15, 1.0, -1);
walker('pbBehind', '後方同向行人', 23, 'male', -1.15, -36, 0, 15, 1.0, 1);
walker('pbFar1', '遠處行人', 31, 'auto', 0.9, -44, 0, 15, 1.2, 1);
walker('pbFar2', '對面行人', 8, 'auto', -11, -30, 0, 15, 1.25, 1);
walker('pbFar3', '對面行人', 17, 'auto', -10.6, 5, 0, 15, 1.2, -1);
add({ id: 'pbPhone', type: 'passerby', name: '騎樓下講電話', position: [3.9, 0, -44], rotation: [0, -70, 0], params: { seed: 5, gender: 'female', pose: 'phone' } });
// 街底人潮：原本是一整塊定格在走路姿勢的群眾，改成幾個真的在走的人。
walker('pbFar4', '街底行人', 61, 'auto', -0.8, -52, 0, 15, 1.1, -1);
walker('pbFar5', '街底行人', 62, 'auto', 1.3, -66, 0, 15, 1.0, 1);
walker('pbFar6', '街底行人', 64, 'auto', 0.3, -60, 0, 15, 1.3, 1);
walker('pbFar7', '街底騎樓行人', 65, 'auto', 3.4, -55, 0, 15, 1.05, -1);
walker('pbFar8', '街底行人', 66, 'auto', -1.4, -70, 0, 15, 1.2, 1);
walker('pbFar9', '街底騎樓行人', 67, 'auto', 4.0, -63, 0, 15, 0.95, 1);

// Extras on a polyline at constant speed. They are already walking at t = 0 and keep
// walking to the end, so nobody starts or stops on camera. `anchor` pins when the
// walker reaches corner `anchor[0]` (time `anchor[1]`); the first and last segments are
// stretched so the walk covers 0 → END.
const END = 15;
const pathWalker = (id, name, seed, gender, pts, speed, anchor, turn = 0.6) => {
  const P = pts.map((p) => [...p]);
  const seg = (i) => Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
  const timesOf = () => {
    const ts = [anchor[1]];
    for (let i = anchor[0]; i > 0; i--) ts.unshift(ts[0] - seg(i - 1) / speed);
    for (let i = anchor[0]; i < P.length - 1; i++) ts.push(ts[ts.length - 1] + seg(i) / speed);
    return ts;
  };
  let ts = timesOf();
  const stretch = (i, j, dt) => { // move point i away from j by speed*dt
    const L = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
    const k = (L + speed * dt) / L;
    P[i] = [P[j][0] + (P[i][0] - P[j][0]) * k, P[j][1] + (P[i][1] - P[j][1]) * k];
  };
  stretch(0, 1, ts[0]); // ts[0] > 0 → extend backward so t = 0 is the first key
  ts = timesOf();
  stretch(P.length - 1, P.length - 2, END - ts[ts.length - 1]);
  ts = timesOf();
  const yaws = [];
  for (let i = 0; i < P.length - 1; i++) {
    let y = (Math.atan2(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) * 180) / Math.PI;
    if (yaws.length) { const prev = yaws[yaws.length - 1]; while (y - prev > 180) y -= 360; while (y - prev < -180) y += 360; }
    yaws.push(y);
  }
  const rot = [[0, [0, yaws[0], 0], 'linear']];
  for (let i = 1; i < yaws.length; i++) {
    rot.push([+(ts[i] - turn / 2).toFixed(3), [0, yaws[i - 1], 0], 'inOut']);
    rot.push([+(ts[i] + turn / 2).toFixed(3), [0, yaws[i], 0], 'linear']);
  }
  add({ id, type: 'passerby', name, position: [P[0][0], Y0, P[0][1]], rotation: [0, yaws[0], 0], params: { seed, gender, pose: 'walk' },
    tracks: { position: keys(P.map((p, i) => [+ts[i].toFixed(3), [p[0], Y0, p[1]], 'linear'])), rotation: keys(rot) } });
  return { P, ts };
};

// CUT 3: passers-by cross the gap between them; a scooter goes by on the road.
walker('pcDown', '從她身旁往北走', 41, 'male', 1.1, 8 + 1.25 * 13.5, 0, 15, 1.25, -1);
// 從他身後橫穿：從鏡頭後方沿路緣往北走，8.3 秒轉進騎樓（橫穿他身後），再沿騎樓繼續往北。
const pcBehindPath = pathWalker('pcBehind', '從他身後橫穿', 52, 'female',
  [[-1.5, 20], [-1.5, HE_STOP_Z - 2.4], [3.0, HE_STOP_Z - 0.66], [3.0, -10]], 1.52, [1, 8.3]);
// 從兩人中間橫穿：從鏡頭後方沿騎樓往北走，9.4 秒斜切過人行道（兩人之間），到樹邊再沿人行道往北。
const pcCrossPath = pathWalker('pcCross', '從兩人中間橫穿', 77, 'female',
  [[3.0, 30], [3.0, 7.6], [-1.7, 7.6 - 4.7 / 5.3], [-1.7, -10]], 1.4, [1, 9.4]);
// 機車：往北騎在靠人行道的車道（台灣靠右行駛），全程等速；從 CUT3 鏡頭左後方超過去，
// 約 11.2 秒從畫面左緣進來、往街底騎遠。
const SC_V = 11, SC_X = -4.4, SC_ENTER_T = 11.2, SC_ENTER_Z = -3.5;
const scooterZ = (t) => SC_ENTER_Z - SC_V * (t - SC_ENTER_T);
const scTrack = (dy, dz) => ({ position: keys([[0, [SC_X, dy, scooterZ(0) + dz], 'linear'], [END, [SC_X, dy, scooterZ(END) + dz]]]) });
add({ id: 'scooterBody', type: 'box', name: '機車', color: '#2c4f7c', position: [SC_X, 0.18, scooterZ(0)], params: { width: 0.55, height: 0.62, depth: 1.7 }, tracks: scTrack(0.18, 0) });
add({ id: 'scooterWheelF', type: 'cylinder', name: '機車前輪', color: '#1e1e1e', position: [SC_X, 0, scooterZ(0) - 0.65], rotation: [0, 0, 90], params: { radius: 0.22, height: 0.12, sides: 12 }, tracks: scTrack(0.22, -0.65) });
add({ id: 'scooterWheelR', type: 'cylinder', name: '機車後輪', color: '#1e1e1e', position: [SC_X, 0, scooterZ(0) + 0.6], rotation: [0, 0, 90], params: { radius: 0.22, height: 0.12, sides: 12 }, tracks: scTrack(0.22, 0.6) });
add({ id: 'scooterRider', type: 'passerby', name: '騎士', position: [SC_X, 0.36, scooterZ(0) + 0.2], rotation: [0, 180, 0], params: { seed: 63, gender: 'male', pose: 'sit' }, tracks: scTrack(0.36, 0.2) });

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------
const cam = (id, name, position, camera, extra = {}) =>
  add({ id, type: 'camera', name, color: '#f0b429', position, camera: {
    rig: 'tripod', lens: 'standard', focalLength: 35, sensor: 'super35',
    fisheye: { fov: 180, mapping: 'equidistant', circular: false }, lookAt: null, follow: null,
    dof: { enabled: false, focusDistance: 5, focusTarget: null, fStop: 2.8 },
    tiltShift: { enabled: false, center: 0.55, width: 0.2, blur: 0.6 },
    shake: { preset: 'none', amount: 0.5, seed: 1 }, ...camera }, ...extra });

// CUT 1 — 基準距離：穩定器倒退跟拍，中全景，長焦，正前方。
cam('cut1', 'CUT1 倒退跟拍 中全景', [0, 1.57, -3.5], {
  rig: 'dolly', focalLength: 60,
  follow: { target: 'she', offset: [-0.35, 1.55, 6.6], space: 'world', lag: 0.2 },
  lookAt: { target: 'she', point: null, aim: 'feet', offset: [-0.35, 1.22, -0.17] },
  dof: { enabled: true, focusDistance: 6.5, focusTarget: 'she', fStop: 4 },
  shake: { preset: 'walk', amount: 0.2, seed: 3 },
});
// CUT 2 — 中景兩人鏡，稍近；跟著她（不陪他停），她停鏡頭跟著煞住。
cam('cut2', 'CUT2 長拍 跟著她走', [0, 1.57, 2], {
  rig: 'dolly', focalLength: 85,
  follow: { target: 'she', offset: [-0.35, 1.55, 6.3], space: 'world', lag: 0.25 },
  lookAt: { target: 'she', point: null, aim: 'feet', offset: [-0.35, 1.38, -0.08] },
  dof: { enabled: true, focusDistance: 6, focusTarget: 'she', fStop: 2.5 },
  shake: { preset: 'walk', amount: 0.2, seed: 5 },
});
// CUT 3 — 第一顆靜止鏡頭：站在她肩旁回望他（她的肩膀、頭髮在右側前景失焦），守在基準距離的中全景。
cam('cut3', 'CUT3 她肩旁反打 他 中全景（固定）', [0.2, 1.45, 11.5], {
  focalLength: 63.2,
  lookAt: { target: 'he', point: null, aim: 'feet', offset: [0, 1.193, 0] },
  dof: { enabled: true, focusDistance: 6.3, focusTarget: 'he', fStop: 2.8 },
});
// CUT 4 — 全片唯一比基準更近：她沒回頭的臉，他在她肩後糊成一塊橘色。
cam('cut4', 'CUT4 她的臉 中近景（固定）', [0.62, 1.53, 13.67], {
  focalLength: 100,
  lookAt: { target: 'she', point: null, aim: 'feet', offset: [0, 1.393, 0] },
  dof: { enabled: true, focusDistance: 4.2, focusTarget: 'she', fStop: 2.0 },
});

const project = {
  ...base,
  name: '誰先給台階',
  notes: '鬧彆扭裡的拉鋸：誰先給台階。寫實輕喜劇，暖色日光下藏一根小刺。初秋午後台北老城區人行道，一側騎樓、一側行道樹。基準距離＝倒退走在兩人前方幾步的同行者。',
  settings: {
    ...base.settings,
    duration: 15,
    fps: 24,
    environment: { preset: 'day', skyColor: null, sunAzimuth: 240, sunElevation: 50, fog: true, fogDensity: 0.22, shadows: true },
  },
  objects,
  cuts: [
    { t: 0, camera: 'cut1' },
    { t: 3, camera: 'cut2' },
    { t: 9.6, camera: 'cut3' },
    { t: 12.7, camera: 'cut4' },
  ],
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
};
fs.writeFileSync(file, JSON.stringify(project, null, 2));
console.log(JSON.stringify({ objects: objects.length, sheZ0, sheStop: SHE_STOP, heStop: HE, gap: SHE_STOP - HE.z, pcBehindPath, pcCrossPath, scooterZ0: scooterZ(0) }));
