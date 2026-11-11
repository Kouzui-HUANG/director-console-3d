/**
 * Starter scenes. Each template is just a list of ordinary commands, so they double
 * as worked examples for agents (see AGENTS.md).
 */
import type { CommandCall } from './commands/execute.ts';
import { buildProject } from './project.ts';
import type { Project } from './schema.ts';

export interface TemplateDef {
  id: string;
  label: string;
  description: string;
  commands: CommandCall[];
}

const c = (cmd: string, args: Record<string, unknown> = {}): CommandCall => ({ cmd, args });

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'blank',
    label: '空白',
    description: '地面＋一台攝影機',
    commands: [
      c('object.add', { type: 'ground', id: 'ground', name: '地面' }),
      c('object.add', { type: 'camera', id: 'camA', name: 'A 機', position: [0, 1.6, 8] }),
    ],
  },
  {
    id: 'street',
    label: '街頭對話',
    description: '街道、兩位演員、正反打與過肩鏡頭、剪輯',
    commands: [
      c('project.update', { name: '街頭對話', settings: { duration: 12 } }),
      c('object.add', { type: 'ground', id: 'ground', name: '地面', color: '#8f9488' }),
      c('object.add', { type: 'road', id: 'road', name: '道路', position: [-6, 0, 0], params: { length: 120, width: 8 } }),
      c('object.add', { type: 'building', id: 'bldgA', name: '大樓 A', position: [14, 0, -10], params: { width: 14, depth: 12, floors: 8 } }),
      c('object.add', { type: 'building', id: 'bldgB', name: '大樓 B', position: [14, 0, 8], params: { width: 12, depth: 10, floors: 5 }, color: '#c9b9a6' }),
      c('object.add', { type: 'building', id: 'bldgC', name: '大樓 C', position: [-24, 0, -6], params: { width: 16, depth: 14, floors: 12 }, color: '#a9b4bf' }),
      c('object.add', { type: 'streetLight', id: 'lamp1', position: [-1.2, 0, -6], rotation: [0, 180, 0] }),
      c('object.add', { type: 'streetLight', id: 'lamp2', position: [-1.2, 0, 10], rotation: [0, 180, 0] }),
      c('object.add', { type: 'tree', id: 'tree1', position: [-0.8, 0, 3] }),
      c('object.add', { type: 'bench', id: 'bench', position: [1.2, 0, -2], rotation: [0, -90, 0] }),
      c('object.add', { type: 'car', id: 'car', name: '路過的車', position: [-8, 0, 30], rotation: [0, 180, 0] }),
      c('object.add', { type: 'male', id: 'hero', name: '主角', position: [0.2, 0, 4], rotation: [0, 180, 0] }),
      c('object.add', { type: 'female', id: 'heroine', name: '女主角', position: [0.4, 0, -1.2], rotation: [0, 0, 0] }),
      c('object.add', { type: 'crowd', id: 'crowd', name: '路人', position: [3.5, 0, 2], params: { count: 14, width: 4, depth: 30, pose: 'walk', facing: 'random' } }),
      c('object.moveTo', { id: 'hero', to: [0.3, 0.3], start: 0, duration: 2.6 }),
      c('object.face', { id: 'heroine', target: 'hero' }),
      c('object.moveTo', { id: 'car', to: [-8, 0, -40], start: 0, duration: 8, ease: 'linear' }),
      c('object.add', { type: 'camera', id: 'camA', name: 'A 機 全景' }),
      c('camera.frame', { camera: 'camA', target: 'heroine', shot: 'LS', side: 'frontRight', focalLength: 28 }),
      c('object.add', { type: 'camera', id: 'camB', name: 'B 機 過肩' }),
      c('camera.frame', { camera: 'camB', target: 'heroine', shot: 'MCU', over: 'hero', shoulder: 'right', t: 3 }),
      c('object.add', { type: 'camera', id: 'camC', name: 'C 機 反打', camera: { rig: 'handheld' } }),
      c('camera.frame', { camera: 'camC', target: 'hero', shot: 'MCU', over: 'heroine', shoulder: 'left', t: 3 }),
      c('cut.set', { t: 0, camera: 'camA' }),
      c('cut.set', { t: 4, camera: 'camB' }),
      c('cut.set', { t: 7, camera: 'camC' }),
      c('cut.set', { t: 9.5, camera: 'camB' }),
      c('marker.set', { t: 2.6, label: '主角停下' }),
      c('marker.set', { t: 4, label: '台詞 1' }),
      c('marker.set', { t: 7, label: '台詞 2' }),
    ],
  },
  {
    id: 'livingRoom',
    label: '室內客廳',
    description: '房間、沙發、兩人對坐，推軌與特寫',
    commands: [
      c('project.update', { name: '室內客廳', settings: { duration: 10, environment: { preset: 'studio', fog: false } } }),
      c('object.add', { type: 'room', id: 'room', name: '客廳', params: { width: 7, depth: 6, height: 2.8 } }),
      c('object.add', { type: 'sofa', id: 'sofa', position: [0, 0, -2.3] }),
      c('object.add', { type: 'chair', id: 'chair', position: [1.6, 0, 0.6], rotation: [0, -120, 0] }),
      c('object.add', { type: 'table', id: 'table', position: [0.2, 0, -0.6], params: { width: 1.1, depth: 0.6, height: 0.45 } }),
      c('object.add', { type: 'female', id: 'mom', name: '母親', position: [-0.4, 0, -2.25], params: { pose: 'sit' } }),
      c('object.add', { type: 'male', id: 'son', name: '兒子', position: [1.6, 0, 0.6], rotation: [0, -120, 0], params: { pose: 'sit' } }),
      c('object.add', { type: 'door', id: 'door', position: [-2, 0, 3], params: { open: 0 } }),
      c('object.add', { type: 'camera', id: 'camA', name: 'A 機' }),
      c('camera.frame', { camera: 'camA', target: 'mom', shot: 'MLS', side: 'frontRight', focalLength: 24 }),
      c('camera.move', { camera: 'camA', preset: 'dollyIn', start: 0, duration: 6, amount: 1.2 }),
      c('object.add', { type: 'camera', id: 'camB', name: 'B 機 特寫' }),
      c('camera.frame', { camera: 'camB', target: 'son', shot: 'CU', side: 'frontLeft', focalLength: 85 }),
      c('cut.set', { t: 0, camera: 'camA' }),
      c('cut.set', { t: 6, camera: 'camB' }),
    ],
  },
  {
    id: 'cityAerial',
    label: '城市空拍',
    description: '城市街區、空拍機環繞與拉升',
    commands: [
      c('project.update', { name: '城市空拍', settings: { duration: 15, environment: { preset: 'golden', fogDensity: 0.35 } } }),
      c('object.add', { type: 'ground', id: 'ground', params: { size: 1200 }, color: '#7c8571' }),
      c('object.add', { type: 'cityBlock', id: 'city', name: '市中心', params: { blocksX: 5, blocksZ: 5, maxFloors: 30 } }),
      c('object.add', { type: 'target', id: 'center', name: '環繞中心', position: [0, 30, 0] }),
      c('object.add', { type: 'camera', id: 'drone', name: '空拍機', position: [0, 60, 160], camera: { rig: 'drone', lookAt: { target: 'center' } } }),
      c('camera.move', { camera: 'drone', preset: 'droneOrbit', start: 0, duration: 15, amount: 120 }),
      c('object.add', { type: 'camera', id: 'drone2', name: '空拍機 2', position: [-60, 12, 150], rotation: [-5, -20, 0], camera: { rig: 'drone' } }),
      c('camera.move', { camera: 'drone2', preset: 'droneRise', start: 0, duration: 8, amount: 70, target: 'center' }),
      c('cut.set', { t: 0, camera: 'drone2' }),
      c('cut.set', { t: 7, camera: 'drone' }),
    ],
  },
  {
    id: 'lenses',
    label: '特殊鏡頭示範',
    description: '魚眼、小行星、360° 全景，依序剪輯',
    commands: [
      c('project.update', { name: '特殊鏡頭示範', settings: { duration: 12, environment: { preset: 'golden', fogDensity: 0.3 } } }),
      c('object.add', { type: 'ground', id: 'ground', params: { size: 1200 }, color: '#7c8571' }),
      c('object.add', { type: 'cityBlock', id: 'city', name: '市區', params: { blocksX: 4, blocksZ: 4, maxFloors: 26 } }),
      c('object.add', { type: 'target', id: 'center', name: '市中心', position: [0, 20, 0] }),
      c('object.add', { type: 'female', id: 'walker', name: '行人', position: [0, 0.15, 28], rotation: [0, 180, 0] }),
      c('object.add', { type: 'male', id: 'friend', name: '朋友', position: [1.3, 0.15, 29.5], rotation: [0, 200, 0], params: { pose: 'phone' } }),
      c('object.moveTo', { id: 'walker', to: [0, 23], start: 0, duration: 12 }),
      c('object.add', { type: 'camera', id: 'fisheye', name: '魚眼 180°', position: [0.2, 1.1, 21], camera: { lens: 'fisheye', fisheye: { fov: 180 }, lookAt: { target: 'walker', aim: 'head' } } }),
      c('object.add', { type: 'camera', id: 'planet', name: '小行星', position: [0, 26, 0], rotation: [-89.9, 0, 0], camera: { lens: 'fisheye', fisheye: { fov: 300, mapping: 'stereographic' } } }),
      c('camera.move', { camera: 'planet', preset: 'pedestalUp', start: 4, duration: 4, amount: 18 }),
      c('object.add', { type: 'camera', id: 'pano', name: '360° 全景', position: [0, 3, 24], camera: { lens: 'panorama' } }),
      c('cut.set', { t: 0, camera: 'fisheye' }),
      c('cut.set', { t: 4, camera: 'planet' }),
      c('cut.set', { t: 8, camera: 'pano' }),
      c('marker.set', { t: 8, label: '360° 建議改用 2:1 畫面輸出' }),
    ],
  },
  {
    id: 'hillside',
    label: '山丘外景',
    description: '丘陵、樹林、奔跑的人物與跟拍',
    commands: [
      c('project.update', { name: '山丘外景', settings: { duration: 10 } }),
      c('object.add', { type: 'hills', id: 'hills', name: '丘陵', params: { size: 400, height: 30, flatRadius: 30 } }),
      c('object.add', { type: 'tree', id: 'tree1', position: [-8, 0, -6] }),
      c('object.add', { type: 'tree', id: 'tree2', position: [10, 0, -12], params: { style: 'pine', height: 9 } }),
      c('object.add', { type: 'tree', id: 'tree3', position: [6, 0, 8], params: { height: 5 } }),
      c('object.add', { type: 'bush', id: 'bush1', position: [-3, 0, 4] }),
      c('object.add', { type: 'female', id: 'runner', name: '跑者', position: [-12, 0, 10] }),
      c('object.followPath', { id: 'runner', points: [[-4, 4], [4, -2], [12, -10]], start: 0, speed: 3.6, gait: 'run' }),
      c('object.add', { type: 'camera', id: 'follow', name: '跟拍機', camera: { rig: 'handheld', focalLength: 35, follow: { target: 'runner', offset: [3, 1.8, 5], lag: 0.3 }, lookAt: { target: 'runner' } } }),
      c('object.add', { type: 'camera', id: 'wide', name: '大遠景' }),
      c('camera.frame', { camera: 'wide', target: 'runner', shot: 'ELS', angle: 'high', side: 'frontLeft', t: 5, focalLength: 24 }),
      c('cut.set', { t: 0, camera: 'wide' }),
      c('cut.set', { t: 4, camera: 'follow' }),
    ],
  },
];

export function templateProject(id: string, name?: string): Project {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0]!;
  const p = buildProject(t.label, t.commands);
  return name ? { ...p, name } : p;
}
