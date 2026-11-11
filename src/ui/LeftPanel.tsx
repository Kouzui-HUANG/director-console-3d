import { useMemo, useState } from 'react';
import { app } from '../app/app.ts';
import { CATEGORY_LABELS, getAssetType, listAssetTypes, type AssetCategory } from '../core/assetTypes.ts';
import { useDirector, useUI } from './hooks.ts';

export const DRAG_MIME = 'application/x-director-type';

const ORDER: AssetCategory[] = ['character', 'architecture', 'terrain', 'prop', 'camera', 'helper'];

/** Add an object of `type` at a ground point (or the view center) and select it. */
export function addObjectAt(type: string, point?: [number, number, number]) {
  const vp = app.viewport;
  const args: Record<string, unknown> = { type };
  if (type === 'camera') {
    const pose = vp?.editorPose();
    if (pose) {
      args.position = pose.position;
      args.rotation = pose.rotation;
    }
  } else if (type === 'target') {
    const p = point ?? vp?.viewCenterOnGround() ?? [0, 0, 0];
    args.position = [p[0], 1.5, p[2]];
  } else {
    const p = point ?? vp?.viewCenterOnGround() ?? [0, 0, 0];
    const big = ['ground', 'hills', 'water', 'cityBlock'].includes(type);
    args.position = big ? [0, 0, 0] : p.map((v) => Math.round(v * 100) / 100);
  }
  const r = app.run({ cmd: 'object.add', args });
  if (r.ok) {
    const id = (r.results[0] as { id: string }).id;
    app.select([id]);
    if (type === 'camera') app.toast('已從目前編輯視角建立攝影機；可在右側「一鍵構圖」快速取景', 'success');
  }
}

export function LeftPanel() {
  const tab = useUI((s) => s.leftTab);
  return (
    <div className="left-panel">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'assets'} className={tab === 'assets' ? 'on' : ''} onClick={() => app.ui.setState({ leftTab: 'assets' })}>
          物件庫
        </button>
        <button role="tab" aria-selected={tab === 'outliner'} className={tab === 'outliner' ? 'on' : ''} onClick={() => app.ui.setState({ leftTab: 'outliner' })}>
          場景大綱
        </button>
      </div>
      {tab === 'assets' ? <AssetLibrary /> : <Outliner />}
    </div>
  );
}

function AssetLibrary() {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase();
    return ORDER.map((cat) => ({
      cat,
      items: listAssetTypes().filter((d) => d.category === cat && (!s || d.label.includes(q.trim()) || d.type.toLowerCase().includes(s) || d.en.toLowerCase().includes(s))),
    })).filter((g) => g.items.length);
  }, [q]);
  return (
    <div className="asset-library" aria-label="物件庫">
      <input className="search" placeholder="搜尋物件…" aria-label="搜尋物件" value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="hint">點一下放到畫面中央，或拖曳到 3D 視窗中的位置。</p>
      {groups.map((g) => (
        <div key={g.cat} className="asset-group">
          <h4>{CATEGORY_LABELS[g.cat]}</h4>
          <div className="asset-grid">
            {g.items.map((d) => (
              <button
                key={d.type}
                className="asset"
                draggable
                aria-label={`新增${d.label}`}
                title={`${d.label}（${d.type}）— ${d.description}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, d.type);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => addObjectAt(d.type)}
              >
                <span className="asset-icon">{d.icon}</span>
                <span className="asset-label">{d.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Outliner() {
  const objects = useDirector((s) => s.project.objects);
  const selection = useDirector((s) => s.ui.selection);
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const list = objects.filter((o) => !q || o.name.includes(q) || o.id.includes(q) || o.type.includes(q));
  const byCat = ORDER.map((cat) => ({ cat, items: list.filter((o) => (getAssetType(o.type)?.category ?? 'prop') === cat) })).filter((g) => g.items.length);
  return (
    <div className="outliner" aria-label="場景大綱">
      <input className="search" placeholder="篩選…" aria-label="篩選物件" value={q} onChange={(e) => setQ(e.target.value)} />
      {byCat.map((g) => (
        <div key={g.cat} className="outliner-group">
          <h4>
            {CATEGORY_LABELS[g.cat]} <span className="muted">{g.items.length}</span>
          </h4>
          {g.items.map((o) => {
            const sel = selection.includes(o.id);
            return (
              <div
                key={o.id}
                className={`outliner-row ${sel ? 'selected' : ''} ${o.visible ? '' : 'hidden-obj'}`}
                role="button"
                aria-label={`選取 ${o.name || o.id}`}
                aria-pressed={sel}
                onClick={(e) => {
                  if (e.shiftKey || e.metaKey) app.select(sel ? selection.filter((s) => s !== o.id) : [...selection, o.id]);
                  else app.select([o.id]);
                }}
                onDoubleClick={() => setRenaming(o.id)}
              >
                <span className="swatch" style={{ background: o.color }} />
                <span className="o-icon">{getAssetType(o.type)?.icon}</span>
                {renaming === o.id ? (
                  <input
                    autoFocus
                    aria-label="重新命名"
                    defaultValue={o.name}
                    onBlur={(e) => {
                      app.run({ cmd: 'object.update', args: { id: o.id, name: e.target.value } });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="o-name">{o.name || o.id}</span>
                )}
                <code className="o-id">{o.id}</code>
                <button
                  className="icon-btn"
                  aria-label={o.visible ? '隱藏' : '顯示'}
                  title={o.visible ? '隱藏' : '顯示'}
                  onClick={(e) => {
                    e.stopPropagation();
                    app.run({ cmd: 'object.update', args: { id: o.id, visible: !o.visible } });
                  }}
                >
                  {o.visible ? '👁' : '—'}
                </button>
                <button
                  className="icon-btn"
                  aria-label={o.locked ? '解鎖' : '鎖定'}
                  title={o.locked ? '解鎖' : '鎖定（防止誤拖）'}
                  onClick={(e) => {
                    e.stopPropagation();
                    app.run({ cmd: 'object.update', args: { id: o.id, locked: !o.locked } });
                  }}
                >
                  {o.locked ? '🔒' : '·'}
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {objects.length === 0 && <p className="hint pad">場景是空的。到「物件庫」新增物件。</p>}
    </div>
  );
}
