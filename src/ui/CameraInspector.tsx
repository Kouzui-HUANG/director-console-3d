import { useState } from 'react';
import { app } from '../app/app.ts';
import { getAssetType, isCharacterType } from '../core/assetTypes.ts';
import { evaluateCamera, programCameraAt, sampleProp } from '../core/evaluate.ts';
import { ANGLES, SHOT_SIZES, SIDES, type ShotAngle, type ShotSide, type ShotSize } from '../core/framing.ts';
import { equivalentFocal, FOCAL_PRESETS, lensFov, rigDefaults, SENSOR_SIZES } from '../core/lens.ts';
import type { Vec3 } from '../core/math.ts';
import { MOVE_PRESETS, type MovePreset } from '../core/moves.ts';
import { FISHEYE_MAPPINGS, SENSORS, SHAKES, type SceneObject } from '../core/schema.ts';
import { KeyToggle, NumberField, Row, Section, Select, Toggle, Vec3Field } from './fields.tsx';
import { useDirector } from './hooks.ts';
import { update } from './Inspector.tsx';

const RIG_LABELS = [
  ['tripod', '腳架'],
  ['handheld', '手持'],
  ['dolly', '軌道車'],
  ['crane', '搖臂'],
  ['drone', '空拍機'],
] as const;
const LENS_LABELS = [
  ['standard', '標準鏡頭'],
  ['fisheye', '魚眼'],
  ['panorama', '360° 全景'],
] as const;
const MAPPING_LABELS: Record<(typeof FISHEYE_MAPPINGS)[number], string> = {
  equidistant: '等距（常見魚眼）',
  equisolid: '等立體角',
  stereographic: '球極投影（小行星）',
  orthographic: '正交',
};
const SHAKE_LABELS: Record<(typeof SHAKES)[number], string> = {
  none: '無',
  handheld: '手持',
  walk: '走動手持',
  drone: '空拍漂移',
  vehicle: '車載',
  earthquake: '劇烈震動',
};
const AIM_LABELS = [
  ['auto', '自動'],
  ['head', '頭部'],
  ['chest', '胸口'],
  ['center', '中心'],
  ['feet', '腳下'],
] as const;

export function CameraInspector({ obj, t }: { obj: SceneObject; t: number }) {
  const project = useDirector((s) => s.project);
  const cam = obj.camera!;
  const id = obj.id;
  const [rw, rh] = project.settings.resolution;
  const ev = evaluateCamera(project, obj, t);
  const fov = lensFov(ev.focalLength, cam.sensor, rw / rh);
  const setCam = (camera: Record<string, unknown>, k?: string) => update(id, { camera }, k);
  const kt = (path: string) => <KeyToggle obj={obj} path={path} t={t} />;
  const others = project.objects.filter((o) => o.id !== id && !['ground'].includes(o.type));
  const targetOptions = [['', '（無）'] as const, ...others.map((o) => [o.id, `${getAssetType(o.type)?.icon ?? ''} ${o.name || o.id}`] as const)];
  const isLive = programCameraAt(project, t) === id;

  return (
    <>
      <Section title="攝影機">
        <div className="button-row compact">
          <button className="primary" onClick={() => app.setView('camera', id)}>
            看穿此攝影機 (C)
          </button>
          <button
            onClick={() => app.run({ cmd: 'cut.set', args: { t, camera: id } })}
            title="在目前時間點把節目切到這台攝影機"
            className={isLive ? 'live' : ''}
          >
            {isLive ? '● 節目中' : '在此時間切到這台'}
          </button>
        </div>
        <Row label="拍攝方式">
          <Select
            value={cam.rig}
            options={RIG_LABELS}
            onChange={(rig) => {
              const d = rigDefaults(rig);
              const shake = rig === 'handheld' ? { preset: 'handheld', amount: 0.5 } : rig === 'drone' ? { preset: 'drone', amount: 0.5 } : { preset: 'none' };
              setCam({ rig, sensor: d.sensor, focalLength: d.focalLength, shake });
            }}
          />
        </Row>
        <Row label="鏡頭">
          <div className="segmented">
            {LENS_LABELS.map(([v, l]) => (
              <button key={v} className={cam.lens === v ? 'on' : ''} onClick={() => setCam({ lens: v })}>
                {l}
              </button>
            ))}
          </div>
        </Row>
        {cam.lens === 'standard' && (
          <>
            <Row label="焦距" keyToggle={kt('camera.focalLength')}>
              <NumberField value={ev.focalLength} min={2} max={1200} step={1} unit="mm" label="↔" precision={1} onChange={(v, k) => setCam({ focalLength: v }, k)} />
            </Row>
            <div className="chips">
              {FOCAL_PRESETS.map((f) => (
                <button key={f} className={Math.abs(ev.focalLength - f) < 0.5 ? 'on' : ''} onClick={() => setCam({ focalLength: f })}>
                  {f}
                </button>
              ))}
            </div>
            <Row label="感光元件">
              <Select value={cam.sensor} options={SENSORS.map((s) => [s, SENSOR_SIZES[s].label] as const)} onChange={(v) => setCam({ sensor: v })} />
            </Row>
            <p className="hint">
              水平視角 {fov.hfov.toFixed(1)}° · 垂直 {fov.vfov.toFixed(1)}° · 等效全片幅 {Math.round(equivalentFocal(ev.focalLength, cam.sensor))}mm
            </p>
          </>
        )}
        {cam.lens === 'fisheye' && (
          <>
            <Row label="魚眼視角" keyToggle={kt('camera.fisheye.fov')}>
              <NumberField value={ev.fisheye.fov} min={60} max={360} step={5} unit="°" label="↔" precision={0} onChange={(v, k) => setCam({ fisheye: { fov: v } }, k)} />
            </Row>
            <Row label="投影方式">
              <Select value={cam.fisheye.mapping} options={FISHEYE_MAPPINGS.map((m) => [m, MAPPING_LABELS[m]] as const)} onChange={(v) => setCam({ fisheye: { mapping: v } })} />
            </Row>
            <Row label="圓形畫面">
              <Toggle checked={cam.fisheye.circular} onChange={(v) => setCam({ fisheye: { circular: v } })} />
            </Row>
            <div className="chips">
              <button onClick={() => setCam({ fisheye: { fov: 180, mapping: 'equidistant', circular: false } })}>180° 全幅</button>
              <button onClick={() => setCam({ fisheye: { fov: 200, mapping: 'equidistant', circular: true } })}>200° 圓形</button>
              <button
                onClick={() => {
                  update(id, { camera: { lookAt: null, fisheye: { fov: 300, mapping: 'stereographic', circular: false } }, rotation: [-90, ev.rotation[1], 0] });
                }}
              >
                小行星
              </button>
            </div>
          </>
        )}
        {cam.lens === 'panorama' && (
          <p className="hint">
            360° 等距柱狀投影；畫面比例建議 2:1。
            {rw / rh !== 2 && (
              <button className="mini" onClick={() => app.run({ cmd: 'project.update', args: { settings: { aspect: '2:1' } } })}>
                套用 2:1
              </button>
            )}
          </p>
        )}
      </Section>

      <Section title="注視與跟隨">
        <Row label="注視目標" hint="攝影機會一直對準這個物件（自動搖鏡）">
          <Select
            value={cam.lookAt?.target ?? ''}
            options={targetOptions}
            onChange={(v) => setCam({ lookAt: v ? { target: v, aim: cam.lookAt?.aim ?? 'auto', offset: cam.lookAt?.offset ?? [0, 0, 0], point: null } : null })}
          />
        </Row>
        {cam.lookAt?.target && (
          <>
            <Row label="對準部位">
              <Select value={cam.lookAt.aim} options={AIM_LABELS} onChange={(v) => setCam({ lookAt: { aim: v } })} />
            </Row>
            <Row label="對準偏移">
              <Vec3Field value={cam.lookAt.offset as Vec3} step={0.05} onChange={(v, k) => setCam({ lookAt: { offset: v } }, k)} />
            </Row>
          </>
        )}
        <Row label="跟隨目標" hint="攝影機位置跟著物件移動（跟拍）">
          <Select
            value={cam.follow?.target ?? ''}
            options={targetOptions}
            onChange={(v) => {
              if (!v) return setCam({ follow: null });
              const target = project.objects.find((o) => o.id === v)!;
              const offset = [ev.position[0] - target.position[0], ev.position[1] - target.position[1], ev.position[2] - target.position[2]].map((n) => Math.round(n * 100) / 100);
              setCam({ follow: { target: v, offset, space: 'world', lag: 0 } });
            }}
          />
        </Row>
        {cam.follow && (
          <>
            <Row label="跟隨偏移">
              <Vec3Field value={cam.follow.offset as Vec3} step={0.1} onChange={(v, k) => setCam({ follow: { offset: v } }, k)} />
            </Row>
            <Row label="座標">
              <Select
                value={cam.follow.space}
                options={[
                  ['world', '世界（固定方向）'],
                  ['local', '跟著目標轉向'],
                ]}
                onChange={(v) => setCam({ follow: { space: v } })}
              />
            </Row>
            <Row label="延遲">
              <NumberField value={cam.follow.lag} min={0} max={5} step={0.05} unit="秒" label="↔" onChange={(v, k) => setCam({ follow: { lag: v } }, k)} />
            </Row>
          </>
        )}
      </Section>

      <Section title="晃動" defaultOpen={cam.shake.preset !== 'none'}>
        <Row label="類型">
          <Select value={cam.shake.preset} options={SHAKES.map((s) => [s, SHAKE_LABELS[s]] as const)} onChange={(v) => setCam({ shake: { preset: v } })} />
        </Row>
        {cam.shake.preset !== 'none' && (
          <>
            <Row label="強度" keyToggle={kt('camera.shake.amount')}>
              <input type="range" aria-label="晃動強度" min={0} max={2} step={0.01} value={Number(sampleProp(obj, 'camera.shake.amount', t) ?? cam.shake.amount)} onChange={(e) => setCam({ shake: { amount: Number(e.target.value) } }, 'shake')} />
            </Row>
            <Row label="亂數種子">
              <NumberField value={cam.shake.seed} min={0} max={1000000} step={1} precision={0} label="↔" onChange={(v) => setCam({ shake: { seed: Math.round(v) } })} />
            </Row>
          </>
        )}
      </Section>

      <FramingTools obj={obj} t={t} />
      <MoveTools obj={obj} t={t} />
    </>
  );
}

function FramingTools({ obj, t }: { obj: SceneObject; t: number }) {
  const project = useDirector((s) => s.project);
  const subjects = project.objects.filter((o) => o.type !== 'camera' && !['ground', 'hills', 'water', 'road'].includes(o.type));
  const people = subjects.filter((o) => isCharacterType(o.type));
  const [target, setTarget] = useState(obj.camera?.lookAt?.target ?? people[0]?.id ?? subjects[0]?.id ?? '');
  const [angle, setAngle] = useState<ShotAngle>('eye');
  const [side, setSide] = useState<ShotSide>('front');
  const [over, setOver] = useState('');
  const [keep, setKeep] = useState(false);
  if (!subjects.length) return null;
  const frame = (shot: ShotSize) => {
    const animated = (obj.tracks.position?.keys.length ?? 0) > 0 || app.store.getState().ui.autoKey;
    app.run({
      cmd: 'camera.frame',
      args: { camera: obj.id, target, shot, angle, side, ...(over ? { over, shoulder: 'right' } : {}), ...(keep ? { keepPosition: true } : {}), ...(animated ? { t } : {}) },
    });
  };
  return (
    <Section title="一鍵構圖" defaultOpen>
      <Row label="主體">
        <Select value={target} options={subjects.map((o) => [o.id, `${getAssetType(o.type)?.icon ?? ''} ${o.name || o.id}`] as const)} onChange={setTarget} />
      </Row>
      <Row label="角度">
        <Select value={angle} options={Object.entries(ANGLES).map(([k, v]) => [k as ShotAngle, v.label] as const)} onChange={setAngle} />
      </Row>
      <Row label="方位">
        <Select value={side} options={Object.entries(SIDES).map(([k, v]) => [k as ShotSide, v.label] as const)} onChange={setSide} />
      </Row>
      <Row label="過肩" hint="從這個人物的肩後拍主體">
        <Select value={over} options={[['', '（不用）'] as const, ...people.filter((p) => p.id !== target).map((p) => [p.id, p.name || p.id] as const)]} onChange={setOver} />
      </Row>
      <Row label="固定機位" hint="不移動攝影機，只改焦距">
        <Toggle checked={keep} onChange={setKeep} />
      </Row>
      <div className="chips shot-chips">
        {(Object.keys(SHOT_SIZES) as ShotSize[]).map((s) => (
          <button key={s} onClick={() => frame(s)} title={SHOT_SIZES[s].en}>
            <b>{s}</b>
            <span>{SHOT_SIZES[s].label}</span>
          </button>
        ))}
      </div>
      <div className="button-row compact">
        <button
          onClick={() => {
            const pose = app.viewport?.editorPose();
            if (!pose) return;
            const s = app.store.getState();
            const animated = (obj.tracks.position?.keys.length ?? 0) > 0 || s.ui.autoKey;
            app.run({ cmd: 'object.update', args: { id: obj.id, position: pose.position, rotation: pose.rotation, camera: { lookAt: null, follow: null }, ...(animated ? { t } : {}) } });
          }}
          title="把攝影機放到目前編輯視角的位置與方向"
        >
          從編輯視角設定
        </button>
        <button onClick={() => app.viewport?.matchEditorToCamera(obj.id)}>編輯視角對齊此機</button>
      </div>
    </Section>
  );
}

function MoveTools({ obj, t }: { obj: SceneObject; t: number }) {
  const [preset, setPreset] = useState<MovePreset>('dollyIn');
  const [duration, setDuration] = useState(4);
  const [amount, setAmount] = useState<number | null>(null);
  const info = MOVE_PRESETS[preset];
  return (
    <Section title="運鏡預設" defaultOpen={false}>
      <Row label="運鏡">
        <Select
          value={preset}
          options={Object.entries(MOVE_PRESETS).map(([k, v]) => [k as MovePreset, v.label] as const)}
          onChange={(v) => {
            setPreset(v);
            setAmount(null);
          }}
        />
      </Row>
      <Row label="時長">
        <NumberField value={duration} min={0.2} max={30} step={0.5} unit="秒" label="↔" onChange={setDuration} />
      </Row>
      <Row label="幅度">
        <NumberField value={amount ?? info.amount} step={preset.startsWith('pan') || preset.startsWith('tilt') || preset.includes('rbit') ? 5 : 0.5} unit={info.unit} label="↔" onChange={setAmount} />
      </Row>
      <button
        className="primary block"
        onClick={() => app.run({ cmd: 'camera.move', args: { camera: obj.id, preset, start: t, duration, amount: amount ?? info.amount } })}
      >
        從目前時間（{t.toFixed(2)}s）套用
      </button>
      <p className="hint">會產生關鍵影格，之後可在時間軸上微調。</p>
    </Section>
  );
}
