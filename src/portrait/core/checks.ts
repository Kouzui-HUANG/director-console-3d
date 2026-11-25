/**
 * Plausibility checks on a built portrait: parameter problems, exaggerated proportions, solver
 * limits and geometric conflicts (eyelids or lips crossing, nose behind the lips …). Each issue
 * says what is wrong and which parameters usually fix it — written for people and agents.
 */
import type { V3 } from './mh/measure.ts';
import type { HumanMesh } from './mh/human.ts';
import type { ParamValues, ResolvedParams } from './params/resolve.ts';

export interface CheckIssue {
  code: string;
  level: 'error' | 'warning' | 'note';
  message: string;
  hint?: string;
  keys?: string[];
}

const mm = (v: number) => `${Math.round(v * 10) / 10} mm`;

export function checkPortrait(m: Pick<HumanMesh, 'measures' | 'landmarks' | 'solve' | 'positions'>, r: ResolvedParams, params: ParamValues): CheckIssue[] {
  const out: CheckIssue[] = r.issues.map((i) => ({ code: i.code, level: i.level, message: i.message, hint: i.hint, keys: [i.key] }));
  const M = m.measures;
  const L = m.landmarks as Record<string, V3 | undefined>;
  const p = (k: string) => (params[k] as number | undefined) ?? 0;

  for (let i = 0; i < m.positions.length; i++) {
    if (!Number.isFinite(m.positions[i]!)) {
      out.push({ code: 'NON_FINITE', level: 'error', message: '網格出現無效的座標（NaN）', hint: '請回報這組參數；先把最後改的參數還原' });
      break;
    }
  }

  // proportions
  if (M.headsTall < 4) out.push({ code: 'HEADS_TALL', level: 'warning', message: `頭身比 ${M.headsTall.toFixed(2)} 低於 4，已超出這個工具的設計範圍（不做 Q 版）`, keys: ['body.headsTall'] });
  else if (M.headsTall < 5.5) out.push({ code: 'HEADS_TALL', level: 'note', message: `頭身比 ${M.headsTall.toFixed(2)}：明顯誇張的大頭比例`, keys: ['body.headsTall'] });
  else if (M.headsTall > 9.2) out.push({ code: 'HEADS_TALL', level: 'note', message: `頭身比 ${M.headsTall.toFixed(2)}：時裝插畫式的修長比例`, keys: ['body.headsTall'] });
  if (Math.abs(m.solve.scale - 1) > 0.04)
    out.push({ code: 'HEIGHT_SCALED', level: 'note', message: `身高超出 MakeHuman 身高參數的範圍，整體${m.solve.scale > 1 ? '放大' : '縮小'}了 ${Math.round(Math.abs(m.solve.scale - 1) * 100)}%（五官尺寸也跟著變）`, keys: ['body.heightCm'] });
  if (m.solve.headScale > 1.5 || m.solve.headScale < 0.75)
    out.push({ code: 'HEAD_SCALE', level: 'note', message: `頭部縮放 ${m.solve.headScale.toFixed(2)} 倍，頸部銜接處可能看起來被拉伸`, hint: '可以同時調 neck.thickness 或 neck.length', keys: ['body.headsTall', 'head.size'] });

  // eyes
  if (M.eyeOpening < 0) out.push({ code: 'EYELIDS_CROSS', level: 'error', message: `上下眼瞼交錯（睜眼高度 ${mm(M.eyeOpening)}）`, hint: '降低 expr.squint，或提高 face.eyes.opening', keys: ['face.eyes.opening', 'expr.squint'] });
  else if (M.eyeOpening < 3 && p('expr.squint') < 0.5) out.push({ code: 'EYES_CLOSED', level: 'warning', message: `眼睛幾乎閉上（睜眼高度 ${mm(M.eyeOpening)}）`, hint: '提高 face.eyes.opening', keys: ['face.eyes.opening'] });
  else if (M.eyeOpening > 14) out.push({ code: 'EYES_WIDE', level: 'note', message: `眼睛睜得很圓（${mm(M.eyeOpening)}），可能露出整圈眼白`, keys: ['face.eyes.opening', 'expr.browRaise'] });
  if (M.eyeWidth > 0 && (M.intercanthal / M.eyeWidth < 0.7 || M.intercanthal / M.eyeWidth > 2.2))
    out.push({ code: 'EYE_SPACING', level: 'note', message: `內眼角距離是眼裂寬的 ${(M.intercanthal / M.eyeWidth).toFixed(2)} 倍（一般約 1～1.7）`, keys: ['face.eyes.spacing', 'face.eyes.width'] });

  // nose, lips, mouth
  if (L.pronasale && L.labraleSuperius && L.pronasale[2] < L.labraleSuperius[2] + 2)
    out.push({ code: 'NOSE_BEHIND_LIPS', level: 'warning', message: '鼻尖幾乎沒有突出於上唇', hint: '提高 face.nose.projection 或降低 face.mouth.protrusion', keys: ['face.nose.projection', 'face.mouth.protrusion'] });
  if (M.lipGap < -1.5) out.push({ code: 'LIPS_CROSS', level: 'warning', message: `上下唇互相穿插（${mm(M.lipGap)}）`, hint: '降低唇厚或嘴的高低差，或加一點 expr.mouthOpen', keys: ['face.mouth.upperLip', 'face.mouth.lowerLip', 'expr.mouthOpen'] });
  if (M.jawWidth > 0 && M.mouthWidth > 0.95 * M.jawWidth) out.push({ code: 'MOUTH_WIDE', level: 'warning', message: `嘴寬 ${mm(M.mouthWidth)} 接近下顎寬 ${mm(M.jawWidth)}`, keys: ['face.mouth.width', 'face.jaw.width'] });
  if (M.mouthWidth < M.noseWidth) out.push({ code: 'MOUTH_NARROW', level: 'note', message: `嘴寬 ${mm(M.mouthWidth)} 比鼻翼 ${mm(M.noseWidth)} 還窄`, keys: ['face.mouth.width', 'face.nose.alarWidth'] });
  if (p('expr.mouthOpen') > 0.3) out.push({ code: 'OPEN_MOUTH', level: 'note', message: '嘴張開時看得到口腔內部（目前沒有雕刻牙齒）', keys: ['expr.mouthOpen'] });

  // face layout
  if (M.lowerFace > 0 && (M.midFace / M.lowerFace < 0.7 || M.midFace / M.lowerFace > 1.45))
    out.push({ code: 'FACE_THIRDS', level: 'note', message: `中庭與下庭比 ${(M.midFace / M.lowerFace).toFixed(2)}（一般約 0.85～1.2）`, keys: ['face.nose.length', 'face.chin.height', 'head.length'] });
  if (L.superauraleL && L.subauraleL && L.subnasale && L.pupilL) {
    if (L.subauraleL[1] > L.pupilL[1] - 15 || L.superauraleL[1] < L.subnasale[1] + 15)
      out.push({ code: 'EAR_POSITION', level: 'note', message: '耳朵位置偏離一般範圍（約在眉毛到鼻底之間）', keys: ['face.ears.height', 'face.ears.length'] });
  }

  // symmetry (only meaningful without asymmetry parameters)
  const asym = Object.keys(params).some((k) => k.startsWith('asym.') && params[k]) || Math.abs(p('face.eyes.gazeYaw')) > 0;
  if (!asym && L.exocanthionL && L.exocanthionR && Math.abs(L.exocanthionL[1] - L.exocanthionR[1]) > 1)
    out.push({ code: 'ASYMMETRIC', level: 'warning', message: '沒有設定左右差，但左右眼角高度不同（引擎問題，請回報）' });
  return out;
}
