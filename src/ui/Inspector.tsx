import { useState } from 'react';
import { app } from '../app/app.ts';
import { getAssetType } from '../core/assetTypes.ts';
import { evaluateObject } from '../core/evaluate.ts';
import { ASPECT_PRESETS, detectTier, RESOLUTION_TIERS } from '../core/lens.ts';
import type { Vec3 } from '../core/math.ts';
import { propDefsFor } from '../core/properties.ts';
import { ENV_PRESETS, type SceneObject } from '../core/schema.ts';
import { CameraInspector } from './CameraInspector.tsx';
import { ColorField, KeyToggle, newEditKey, NumberField, ParamForm, Row, Section, Select, Toggle, Vec3Field } from './fields.tsx';
import { useDirector, useThrottledTime } from './hooks.ts';

const ENV_LABELS: Record<(typeof ENV_PRESETS)[number], string> = {
  day: '白天',
  golden: '黃金時刻',
  dusk: '黃昏',
  night: '夜晚',
  overcast: '陰天',
  studio: '攝影棚',
};

export function update(id: string, args: Record<string, unknown>, gestureKey?: string) {
  const autoKey = app.store.getState().ui.autoKey;
  app.run({ cmd: 'object.update', args: { id, ...args, ...(autoKey ? { key: true } : {}) } }, gestureKey ? { mergeKey: gestureKey } : {});
}

export function Inspector() {
  const selection = useDirector((s) => s.ui.selection);
  if (selection.length === 0) return <ProjectSettings />;
  if (selection.length > 1) return <MultiInspector ids={selection} />;
  return <ObjectInspector id={selection[0]!} />;
}

function MultiInspector({ ids }: { ids: string[] }) {
  const [color, setColor] = useState('#9aa4b2');
  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong>已選取 {ids.length} 個物件</strong>
      </div>
      <Section title="批次操作">
        <Row label="顏色">
          <ColorField
            value={color}
            onChange={(c) => {
              setColor(c);
              app.run(ids.map((id) => ({ cmd: 'object.update', args: { id, color: c } })));
            }}
          />
        </Row>
        <div className="button-row">
          <button onClick={() => app.run(ids.map((id) => ({ cmd: 'object.duplicate', args: { id } })))}>複製</button>
          <button className="danger" onClick={() => app.run({ cmd: 'object.remove', args: { ids } })}>
            刪除
          </button>
        </div>
      </Section>
    </div>
  );
}

function ObjectInspector({ id }: { id: string }) {
  const obj = useDirector((s) => s.project.objects.find((o) => o.id === id));
  const t = useThrottledTime();
  const [advanced, setAdvanced] = useState(false);
  if (!obj) return null;
  const def = getAssetType(obj.type);
  const e = evaluateObject(obj, t);
  const animatable = new Set(propDefsFor(obj).map((d) => d.path));
  const isCamera = obj.type === 'camera';
  const kt = (path: string) => (animatable.has(path) ? <KeyToggle obj={obj} path={path} t={t} /> : null);

  return (
    <div className="inspector" aria-label="屬性面板">
      <div className="inspector-head">
        <span className="type-icon">{def?.icon}</span>
        <input aria-label="物件名稱" className="name-input" value={obj.name} onChange={(ev) => update(id, { name: ev.target.value }, `name:${id}`)} />
      </div>
      <div className="inspector-sub">
        <span>{def?.label ?? obj.type}</span>
        <code title="物件 ID（AI 指令用）" onClick={() => void navigator.clipboard?.writeText(obj.id)}>
          {obj.id}
        </code>
      </div>

      <Section title="變形">
        <Row label="位置" keyToggle={kt('position')}>
          <Vec3Field ariaLabel="位置" value={e.position} step={0.05} onChange={(v: Vec3, k) => update(id, { position: v }, k)} />
        </Row>
        <Row label={isCamera ? '俯仰／水平／滾轉' : '旋轉'} keyToggle={kt('rotation')} hint={isCamera ? '攝影機旋轉 [俯仰, 水平搖, 滾轉]（度）' : '[X, Y(轉向), Z]（度）；Y 正值＝向左轉'}>
          <Vec3Field
            ariaLabel="旋轉"
            value={e.rotation}
            step={1}
            precision={2}
            labels={isCamera ? ['俯', '搖', '滾'] : ['X', 'Y', 'Z']}
            onChange={(v: Vec3, k) => update(id, { rotation: v }, k)}
          />
        </Row>
        {!isCamera && (
          <Row label="縮放" keyToggle={kt('scale')}>
            <Vec3Field ariaLabel="縮放" value={e.scale} step={0.05} onChange={(v: Vec3, k) => update(id, { scale: v }, k)} />
          </Row>
        )}
        <div className="button-row compact">
          {!isCamera && <button onClick={() => update(id, { position: [e.position[0], 0, e.position[2]] })}>放到地面</button>}
          {!isCamera && (
            <button
              onClick={() => {
                const s = app.store.getState();
                const cam = s.project.objects.find((o) => o.type === 'camera');
                if (cam) app.run({ cmd: 'object.face', args: { id, target: cam.id } });
              }}
            >
              面向攝影機
            </button>
          )}
          <button onClick={() => app.viewport?.frameSelection()}>聚焦 (F)</button>
        </div>
      </Section>

      <Section title="外觀">
        <Row label="顏色" keyToggle={kt('color')}>
          <ColorField value={e.color} onChange={(c) => update(id, { color: c }, `color:${id}`)} />
        </Row>
        <Row label="顯示" keyToggle={kt('visible')}>
          <Toggle checked={e.visible} onChange={(v) => update(id, { visible: v })} />
        </Row>
        <Row label="鎖定">
          <Toggle checked={obj.locked} onChange={(v) => app.run({ cmd: 'object.update', args: { id, locked: v } })} />
        </Row>
      </Section>

      {def && def.fields.length > 0 && (
        <Section
          title="參數"
          right={
            def.fields.some((f) => f.advanced) ? (
              <button className="mini" onClick={() => setAdvanced(!advanced)}>
                {advanced ? '隱藏進階' : '進階'}
              </button>
            ) : null
          }
        >
          <ParamForm
            fields={def.fields}
            values={e.params}
            showAdvanced={advanced}
            keyToggle={(key) => kt(`params.${key}`)}
            onChange={(key, value, k) => update(id, { params: { [key]: value } }, k)}
          />
        </Section>
      )}

      {isCamera && <CameraInspector obj={obj} t={t} />}

      <Section title="備註" defaultOpen={false}>
        <textarea aria-label="備註" rows={3} value={obj.note ?? ''} placeholder="走位、台詞、提醒…" onChange={(ev) => app.run({ cmd: 'object.update', args: { id, note: ev.target.value } }, { mergeKey: `note:${id}` })} />
      </Section>

      <div className="button-row">
        <button onClick={() => app.run({ cmd: 'object.duplicate', args: { id } })}>複製 (⌘D)</button>
        <button className="danger" onClick={() => app.run({ cmd: 'object.remove', args: { id } })}>
          刪除
        </button>
      </div>
      <AnimationSummary obj={obj} />
    </div>
  );
}

function AnimationSummary({ obj }: { obj: SceneObject }) {
  const tracks = Object.entries(obj.tracks);
  if (!tracks.length) return <p className="hint pad">尚無動畫。按屬性旁的 ◇ 或開啟「自動關鍵影格」後拖動物件，即可建立動畫。</p>;
  return (
    <Section title={`動畫（${tracks.length} 條軌）`} defaultOpen={false}>
      {tracks.map(([path, tr]) => (
        <div key={path} className="track-summary">
          <code>{path}</code>
          <span>{tr.keys.map((k) => `${k.t}s`).join(' · ')}</span>
          {path === 'position' && (
            <Select
              value={(tr.path ?? 'linear') as 'linear' | 'smooth'}
              options={[
                ['linear', '直線'],
                ['smooth', '平滑曲線'],
              ]}
              onChange={(v) => app.run({ cmd: 'key.path', args: { id: obj.id, path: v } })}
            />
          )}
          <button className="mini danger" onClick={() => app.run({ cmd: 'key.clear', args: { id: obj.id, prop: path } })}>
            清除
          </button>
        </div>
      ))}
    </Section>
  );
}

function ProjectSettings() {
  const p = useDirector((s) => s.project);
  const s = p.settings;
  const env = s.environment;
  const tier = detectTier(s.resolution);
  const setSettings = (settings: Record<string, unknown>, k?: string) => app.run({ cmd: 'project.update', args: { settings } }, k ? { mergeKey: k } : {});
  const cams = p.objects.filter((o) => o.type === 'camera').length;
  return (
    <div className="inspector" aria-label="專案設定">
      <div className="inspector-head">
        <span className="type-icon">🎬</span>
        <input aria-label="專案名稱" className="name-input" value={p.name} onChange={(e) => app.run({ cmd: 'project.update', args: { name: e.target.value } }, { mergeKey: 'pname' })} />
      </div>
      <div className="inspector-sub">
        <span>
          {p.objects.length} 個物件 · {cams} 台攝影機 · {p.cuts.length} 個剪輯點
        </span>
      </div>
      <Section title="時間">
        <Row label="長度">
          <NumberField value={s.duration} min={1} max={30} step={0.5} unit="秒" label="↔" onChange={(v, k) => setSettings({ duration: Math.round(v * 100) / 100 }, k)} />
        </Row>
        <Row label="影格率">
          <Select
            value={String(s.fps) as '24'}
            options={[
              ['24', '24 fps（電影）'],
              ['25', '25 fps'],
              ['30', '30 fps'],
              ['50', '50 fps'],
              ['60', '60 fps'],
            ]}
            onChange={(v) => setSettings({ fps: Number(v) })}
          />
        </Row>
      </Section>
      <Section title="畫面">
        <Row label="比例">
          <Select
            value={s.aspect as string}
            options={[...ASPECT_PRESETS.map((a) => [a.key, a.label] as const), ['custom', '自訂']]}
            onChange={(v) => v !== 'custom' && setSettings({ aspect: v })}
          />
        </Row>
        <Row label="解析度">
          <Select
            value={(tier ?? 'custom') as string}
            options={[...RESOLUTION_TIERS.map((r) => [r.key, r.label] as const), ['custom', '自訂']]}
            onChange={(v) => v !== 'custom' && setSettings({ resolutionTier: v })}
          />
        </Row>
        <Row label="尺寸">
          <div className="vec2">
            <NumberField label="寬" value={s.resolution[0]} step={2} min={16} max={8192} precision={0} onChange={(v) => setSettings({ resolution: [Math.round(v), s.resolution[1]] })} />
            <NumberField label="高" value={s.resolution[1]} step={2} min={16} max={8192} precision={0} onChange={(v) => setSettings({ resolution: [s.resolution[0], Math.round(v)] })} />
          </div>
        </Row>
      </Section>
      <Section title="環境">
        <Row label="時段">
          <Select value={env.preset} options={ENV_PRESETS.map((e) => [e, ENV_LABELS[e]] as const)} onChange={(v) => setSettings({ environment: { preset: v, skyColor: null } })} />
        </Row>
        <Row label="天空顏色">
          <span className="color-field">
            <input type="color" aria-label="天空顏色" value={env.skyColor ?? '#8fb6dc'} onChange={(e) => setSettings({ environment: { skyColor: e.target.value } }, 'sky')} />
            {env.skyColor && (
              <button className="mini" onClick={() => setSettings({ environment: { skyColor: null } })}>
                還原
              </button>
            )}
          </span>
        </Row>
        <Row label="太陽方位">
          <NumberField value={env.sunAzimuth} step={5} min={-360} max={360} unit="°" label="↔" onChange={(v, k) => setSettings({ environment: { sunAzimuth: v } }, k)} />
        </Row>
        <Row label="太陽高度">
          <NumberField value={env.sunElevation} step={2} min={-10} max={90} unit="°" label="↔" onChange={(v, k) => setSettings({ environment: { sunElevation: v } }, k)} />
        </Row>
        <Row label="霧">
          <Toggle checked={env.fog} onChange={(v) => setSettings({ environment: { fog: v } })} />
        </Row>
        {env.fog && (
          <Row label="霧濃度">
            <input type="range" aria-label="霧濃度" min={0} max={1} step={0.01} value={env.fogDensity} onChange={(e) => setSettings({ environment: { fogDensity: Number(e.target.value) } }, 'fog')} />
          </Row>
        )}
        <Row label="陰影" hint="輸出影片時計算即時陰影（預覽是否顯示陰影可在效能設定調整）">
          <Toggle checked={env.shadows} onChange={(v) => setSettings({ environment: { shadows: v } })} />
        </Row>
      </Section>
      <Section title="劇本／備註" defaultOpen={false}>
        <textarea aria-label="劇本備註" rows={6} value={p.notes ?? ''} placeholder="貼上劇本或分鏡說明…" onChange={(e) => app.run({ cmd: 'project.update', args: { notes: e.target.value } }, { mergeKey: 'notes' })} />
      </Section>
      <p className="hint pad">提示：點選場景中的物件可編輯它的屬性；未選取時這裡顯示專案設定。</p>
    </div>
  );
}

export { newEditKey };
