import { useMemo } from 'react';
import { studio } from '../app.ts';
import { MEASURE_LABELS, type Measures } from '../core/mh/measure.ts';
import { GROUPS, PARAMS, type ParamDef, type ParamGroup } from '../core/params/registry.ts';
import { setUI, useDoc, useUI } from './hooks.ts';

const unitText = (d: ParamDef, v: number) => {
  const r = Math.round(v * 100) / 100;
  if (d.unit === 'years') return `${Math.round(v)} 歲`;
  if (d.unit === 'cm') return `${r} cm`;
  if (d.unit === 'deg') return `${Math.round(v)}°`;
  return String(r);
};

function ParamRow({ d }: { d: ParamDef }) {
  const value = useDoc((s) => s.portrait.params[d.key]);
  const exaggerate = useUI((s) => s.exaggerate);
  const stats = useUI((s) => s.stats);
  const highlighted = useUI((s) => s.highlight === d.key);
  const isAuto = d.def === null && (value === undefined || value === null);
  const auto = d.special === 'heightCm' ? stats?.heightCm : d.special === 'headsTall' ? stats?.headsTall : undefined;
  const v = isAuto ? (auto ?? d.range[0]) : ((value ?? d.def) as number);
  const [lo, hi] = exaggerate ? d.limit : d.range;
  const changed = value !== undefined && value !== d.def;
  const outside = v < d.range[0] || v > d.range[1];
  const set = (x: number | null) => studio.setParam(d.key, x);
  return (
    <div
      className={`pt-param${changed ? ' changed' : ''}${outside ? ' exaggerated' : ''}${highlighted ? ' hl' : ''}`}
      onMouseEnter={() => studio.highlightParam(d.key)}
      onMouseLeave={() => studio.highlightParam(null)}
    >
      <div className="pt-param-head">
        <span className="pt-param-label" title={`${d.key}${d.neg ? `：${d.neg} ↔ ${d.pos}` : ''}`}>
          {d.label}
        </span>
        {isAuto ? (
          <span className="pt-num muted">自動 {auto !== undefined ? unitText(d, auto) : ''}</span>
        ) : (
          <input
            className="pt-numin"
            type="number"
            aria-label={`${d.label}數值`}
            step={d.step ?? 0.01}
            value={Math.round(v * 1000) / 1000}
            onChange={(e) => e.target.value !== '' && set(Number(e.target.value))}
          />
        )}
        {d.def === null ? (
          <button className={isAuto ? 'on' : ''} aria-pressed={isAuto} aria-label={`${d.label}：自動`} title="自動（由其他參數決定）" onClick={() => set(isAuto ? Math.round(v * 10) / 10 : null)}>
            自動
          </button>
        ) : (
          <button disabled={!changed} title="還原預設" aria-label={`還原 ${d.label}`} onClick={() => set(null)}>
            ↺
          </button>
        )}
      </div>
      <input type="range" min={Math.min(lo, v)} max={Math.max(hi, v)} step={d.step ?? 0.01} value={v} aria-label={d.label} onChange={(e) => set(Number(e.target.value))} />
      {d.neg ? (
        <div className="pt-param-ends">
          <span>{d.neg}</span>
          <span>{d.pos}</span>
        </div>
      ) : null}
    </div>
  );
}

function MeasureList({ m }: { m: Measures }) {
  return (
    <dl className="pt-measures">
      {(Object.keys(MEASURE_LABELS) as (keyof Measures)[]).map((k) => (
        <div key={k}>
          <dt>{MEASURE_LABELS[k]}</dt>
          <dd>{k === 'headsTall' ? m[k].toFixed(2) : k === 'canthalTilt' ? `${m[k].toFixed(1)}°` : `${m[k].toFixed(1)} mm`}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ParamPanel() {
  const params = useDoc((s) => s.portrait.params);
  const open = useUI((s) => s.openGroups);
  const search = useUI((s) => s.search);
  const exaggerate = useUI((s) => s.exaggerate);
  const measures = useUI((s) => s.measures);
  const q = search.trim().toLowerCase();
  const matches = useMemo(() => (q ? PARAMS.filter((d) => d.key.toLowerCase().includes(q) || d.label.includes(search.trim()) || d.neg?.includes(search.trim()) || d.pos?.includes(search.trim())) : null), [q, search]);
  const toggle = (g: ParamGroup) => setUI({ openGroups: open.includes(g) ? open.filter((x) => x !== g) : [...open, g] });
  const changedIn = (g: ParamGroup) => PARAMS.filter((d) => d.group === g && params[d.key] !== undefined && params[d.key] !== d.def).length;
  return (
    <aside className="pt-right" aria-label="參數">
      <div className="pt-search">
        <input type="search" placeholder="🔍 搜尋參數（例如：鼻、眼距、height）" aria-label="搜尋參數" value={search} onChange={(e) => setUI({ search: e.target.value })} />
        <button className={exaggerate ? 'on' : ''} aria-pressed={exaggerate} title="滑桿延伸到誇張範圍" onClick={() => setUI({ exaggerate: !exaggerate })}>
          誇張
        </button>
      </div>
      <div className="pt-params">
        {matches ? (
          matches.length ? matches.map((d) => <ParamRow key={d.key} d={d} />) : <p className="hint pad">找不到「{search}」</p>
        ) : (
          GROUPS.map((g) => {
            const n = changedIn(g.id);
            const isOpen = open.includes(g.id);
            return (
              <section key={g.id} className="pt-group">
                <header>
                  <button className="pt-group-title" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                    {isOpen ? '▾' : '▸'} {g.label}
                    {n ? <span className="pt-badge">{n}</span> : null}
                  </button>
                  {n ? (
                    <button className="mini" aria-label={`重設${g.label}`} title={`把「${g.label}」全部還原`} onClick={() => studio.run({ cmd: 'portrait.reset', args: { groups: [g.id] } })}>
                      重設
                    </button>
                  ) : null}
                </header>
                {isOpen ? PARAMS.filter((d) => d.group === g.id).map((d) => <ParamRow key={d.key} d={d} />) : null}
              </section>
            );
          })
        )}
      </div>
      {measures ? (
        <details className="pt-measure-box">
          <summary>量測</summary>
          <MeasureList m={measures} />
        </details>
      ) : null}
    </aside>
  );
}
