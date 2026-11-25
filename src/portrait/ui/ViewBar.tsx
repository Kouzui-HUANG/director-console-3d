import { FOCALS, studio } from '../app.ts';
import { LIGHTS, MATERIALS, VIEWS, type LightPreset, type MaterialPreset, type ViewName } from '../render/viewer.ts';
import { setUI, useUI } from './hooks.ts';

export const VIEW_KEYS: ViewName[] = ['front', 'threeQuarterLeft', 'left', 'back', 'right', 'threeQuarterRight', 'top'];

export function ViewBar() {
  const s = useUI((x) => x);
  return (
    <div className="pt-viewbar" role="toolbar" aria-label="檢視">
      <div className="segmented" role="group" aria-label="視角">
        {VIEW_KEYS.map((v, i) => (
          <button key={v} className={s.view === v ? 'on' : ''} aria-pressed={s.view === v} title={`${VIEWS[v].label}${i < 6 ? ` (${i + 1})` : ''}`} onClick={() => {
            setUI({ view: v });
            studio.viewer?.setView(v);
          }}>
            {VIEWS[v].label}
          </button>
        ))}
      </div>
      <button title="重設鏡頭 (F)" onClick={() => studio.frame()}>
        ⌖
      </button>
      <button title="臉部特寫" onClick={() => studio.frame('face')}>
        臉
      </button>
      <select aria-label="焦距" value={s.focal} onChange={(e) => setUI({ focal: Number(e.target.value) })}>
        {FOCALS.map((f) => (
          <option key={f} value={f}>
            {f} mm
          </option>
        ))}
      </select>
      <select aria-label="燈光" value={s.light} onChange={(e) => setUI({ light: e.target.value as LightPreset })}>
        {(Object.keys(LIGHTS) as LightPreset[]).map((l) => (
          <option key={l} value={l}>
            {LIGHTS[l]}
          </option>
        ))}
      </select>
      <select aria-label="材質" value={s.material} onChange={(e) => setUI({ material: e.target.value as MaterialPreset })}>
        {(Object.keys(MATERIALS) as MaterialPreset[]).map((m) => (
          <option key={m} value={m}>
            {MATERIALS[m]}
          </option>
        ))}
      </select>
      <button className={s.turntable ? 'on' : ''} aria-pressed={s.turntable} title="轉台自動旋轉 (T)" onClick={() => setUI({ turntable: !s.turntable })}>
        ⟳ 轉台
      </button>
      <button className={s.ao ? 'on' : ''} aria-pressed={s.ao} title="環境光遮蔽（凹處自然變暗）" onClick={() => setUI({ ao: !s.ao })}>
        AO
      </button>
      <button className={s.wireframe ? 'on' : ''} aria-pressed={s.wireframe} title="線框" onClick={() => setUI({ wireframe: !s.wireframe })}>
        線框
      </button>
      <button className={s.landmarks ? 'on' : ''} aria-pressed={s.landmarks} title="顯示臉部特徵點（量測用的點）" onClick={() => setUI({ landmarks: !s.landmarks })}>
        特徵點
      </button>
    </div>
  );
}
