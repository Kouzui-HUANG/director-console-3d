import { studio } from '../app.ts';
import { PRESETS } from '../core/params/presets.ts';
import { TRAIT_GROUPS, TRAITS } from '../core/params/traits.ts';
import { setUI, useDoc, useUI } from './hooks.ts';
import { ReferencesSection } from './References.tsx';

export function LeftPanel() {
  const preset = useDoc((s) => s.portrait.preset);
  const amount = useUI((s) => s.traitAmount);
  const issues = useUI((s) => s.issues);
  const warnings = issues.filter((i) => i.level !== 'note');
  const notes = issues.filter((i) => i.level === 'note');
  return (
    <aside className="pt-left" aria-label="預設、參考照片與特徵詞">
      <section>
        <h4>基礎預設</h4>
        <div className="pt-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className={preset === p.id ? 'on' : ''} aria-label={`預設：${p.label}`} title="套用預設（可復原；只想換某些部位時用指令 portrait.applyPreset 的 groups）" onClick={() => studio.run({ cmd: 'portrait.applyPreset', args: { preset: p.id } })}>
              {p.label}
            </button>
          ))}
        </div>
      </section>
      <ReferencesSection />
      <section>
        <h4>
          特徵詞
          <label className="pt-amount" title="套用強度（1 = 配方原值）">
            強度
            <input type="range" min={0.25} max={1.5} step={0.05} value={amount} aria-label="特徵詞強度" onChange={(e) => setUI({ traitAmount: Number(e.target.value) })} />
            <span className="pt-num">{amount.toFixed(2)}</span>
          </label>
        </h4>
        {TRAIT_GROUPS.map((g) => (
          <div key={g.id} className="pt-traits">
            <span className="pt-trait-group">{g.label}</span>
            {TRAITS.filter((t) => t.group === g.id).map((t) => (
              <button key={t.name} className="chip" aria-label={`特徵詞：${t.name}`} title={Object.entries(t.params).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join('\n')} onClick={() => studio.run({ cmd: 'portrait.applyTraits', args: { traits: [t.name], amount } })}>
                {t.name}
              </button>
            ))}
          </div>
        ))}
      </section>
      <section className="pt-checks">
        <h4>
          檢查 {warnings.length ? <span className="warn">⚠ {warnings.length}</span> : <span className="ok">✓</span>}
        </h4>
        {issues.length === 0 ? <p className="hint">沒有發現問題。</p> : null}
        {[...warnings, ...notes].map((i, n) => (
          <div key={n} className={`pt-issue ${i.level}`}>
            <div>{i.message}</div>
            {i.hint ? <div className="hint">{i.hint}</div> : null}
          </div>
        ))}
      </section>
    </aside>
  );
}
