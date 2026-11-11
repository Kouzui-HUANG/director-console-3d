import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { app } from '../app/app.ts';
import { getAssetType } from '../core/assetTypes.ts';
import type { CommandCall } from '../core/commands/execute.ts';
import { programCameraAt } from '../core/evaluate.ts';
import { sameFrame, snapTime } from '../core/interpolate.ts';
import { propDefsFor } from '../core/properties.ts';
import type { Ease, Project, SceneObject } from '../core/schema.ts';
import { setUI } from '../core/store.ts';
import { timecode } from '../export/burnin.ts';
import { useDirector, useThrottledTime } from './hooks.ts';

const LABEL_W = 176;
const EASE_LABELS: [Ease, string][] = [
  ['linear', '線性'],
  ['inOut', '漸入漸出'],
  ['in', '漸入（慢起）'],
  ['out', '漸出（慢停）'],
  ['hold', '停格（跳到下一格）'],
];

interface MenuState {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean; checked?: boolean }[];
}

function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  useEffect(() => {
    if (!menu) return;
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()} role="menu">
      {menu.items.map((it, i) => (
        <button
          key={i}
          role="menuitem"
          className={it.danger ? 'danger' : ''}
          onClick={() => {
            it.action();
            onClose();
          }}
        >
          {it.checked ? '✓ ' : ''}
          {it.label}
        </button>
      ))}
    </div>
  );
}

function allKeyTimes(obj: SceneObject): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const [path, tr] of Object.entries(obj.tracks)) {
    for (const k of tr.keys) {
      const key = Math.round(k.t * 1000) / 1000;
      m.set(key, [...(m.get(key) ?? []), path]);
    }
  }
  return m;
}

function keyTimesForNav(p: Project, selection: string[]): number[] {
  const objs = selection.length ? p.objects.filter((o) => selection.includes(o.id)) : p.objects;
  const set = new Set<number>();
  for (const o of objs) for (const tr of Object.values(o.tracks)) for (const k of tr.keys) set.add(k.t);
  for (const c of p.cuts) set.add(c.t);
  return [...set].sort((a, b) => a - b);
}

export function Timeline() {
  const project = useDirector((s) => s.project);
  const selection = useDirector((s) => s.ui.selection);
  const playing = useDirector((s) => s.ui.playing);
  const loop = useDirector((s) => s.ui.loop);
  const autoKey = useDirector((s) => s.ui.autoKey);
  const [zoom, setZoom] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<{ kind: 'key' | 'cut' | 'marker'; id: string; paths: string[]; t0: number; dx: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const [areaW, setAreaW] = useState(800);
  const duration = project.settings.duration;
  const fps = project.settings.fps;
  const pps = Math.max(10, ((areaW - LABEL_W - 24) / duration) * zoom);
  const contentW = duration * pps;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    setAreaW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Playhead + time display follow the store without React re-renders.
  useEffect(() => {
    const apply = () => {
      const s = app.store.getState();
      const t = s.ui.time;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${LABEL_W + t * pps}px)`;
      if (timeRef.current) timeRef.current.textContent = `${timecode(t, s.project.settings.fps)}  ${t.toFixed(2)}s`;
      const el = scrollRef.current;
      if (el && s.ui.playing) {
        const x = LABEL_W + t * pps;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + LABEL_W) el.scrollLeft = Math.max(0, x - LABEL_W - 40);
      }
    };
    apply();
    return app.store.subscribe((s, prev) => {
      if (s.ui.time !== prev.ui.time || s.project !== prev.project) apply();
    });
  }, [pps]);

  const rows = useMemo(
    () =>
      project.objects.filter((o) => showAll || Object.keys(o.tracks).length > 0 || selection.includes(o.id) || o.type === 'camera'),
    [project.objects, showAll, selection],
  );

  const timeAt = (clientX: number): number => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left + el.scrollLeft - LABEL_W;
    return Math.max(0, Math.min(duration, snapTime(x / pps, fps)));
  };

  const scrubStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    app.pause();
    app.seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => app.seek(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startDrag = (e: React.PointerEvent, kind: 'key' | 'cut' | 'marker', id: string, paths: string[], t0: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    let moved = false;
    setDrag({ kind, id, paths, t0, dx: 0 });
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      setDrag({ kind, id, paths, t0, dx });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      const dx = ev.clientX - startX;
      if (!moved) {
        app.seek(t0);
        if (kind === 'key') app.select([id]);
        return;
      }
      const to = Math.max(0, Math.min(30, snapTime(t0 + dx / pps, fps)));
      if (sameFrame(to, t0, fps)) return;
      const p = app.store.getState().project;
      if (kind === 'key') app.run(paths.map((prop) => ({ cmd: 'key.move', args: { id, prop, t: t0, to } })));
      else if (kind === 'cut') {
        const cut = p.cuts.find((c) => sameFrame(c.t, t0, fps));
        if (cut) app.run([{ cmd: 'cut.remove', args: { t: t0 } }, { cmd: 'cut.set', args: { t: to, camera: cut.camera } }]);
      } else {
        const m = p.markers.find((x) => sameFrame(x.t, t0, fps));
        if (m) app.run([{ cmd: 'marker.remove', args: { t: t0 } }, { cmd: 'marker.set', args: { t: to, label: m.label, ...(m.color ? { color: m.color } : {}) } }]);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const keyMenu = (e: React.MouseEvent, obj: SceneObject, paths: string[], t: number) => {
    e.preventDefault();
    e.stopPropagation();
    const first = obj.tracks[paths[0]!]?.keys.find((k) => sameFrame(k.t, t, fps));
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...EASE_LABELS.map(([ease, label]) => ({
          label: `緩動：${label}`,
          checked: (first?.ease ?? 'inOut') === ease,
          action: () => app.run(paths.map((prop) => ({ cmd: 'key.set', args: { id: obj.id, prop, t, ease, v: obj.tracks[prop]!.keys.find((k) => sameFrame(k.t, t, fps))?.v } }))),
        })),
        { label: '跳到這一格', action: () => app.seek(t) },
        { label: `刪除關鍵影格（${paths.length}）`, danger: true, action: () => app.run(paths.map((prop) => ({ cmd: 'key.remove', args: { id: obj.id, prop, t } }))) },
      ],
    });
  };

  const cams = project.objects.filter((o) => o.type === 'camera');
  const cuts = [...project.cuts].sort((a, b) => a.t - b.t);
  const dragOffset = (kind: string, id: string, t: number) => (drag && drag.kind === kind && drag.id === id && sameFrame(drag.t0, t, fps) ? drag.dx : 0);

  const navTimes = keyTimesForNav(project, selection);
  const jump = (dir: 1 | -1) => {
    const t = app.store.getState().ui.time;
    const next = dir > 0 ? navTimes.find((x) => x > t + 1e-4) : [...navTimes].reverse().find((x) => x < t - 1e-4);
    app.seek(next ?? (dir > 0 ? duration : 0));
  };

  const addKeyForSelection = () => {
    const s = app.store.getState();
    const calls: CommandCall[] = [];
    for (const id of s.ui.selection) {
      const o = s.project.objects.find((x) => x.id === id);
      if (!o) continue;
      calls.push({ cmd: 'key.set', args: { id, prop: 'position' } }, { cmd: 'key.set', args: { id, prop: 'rotation' } });
      if (o.type === 'camera') calls.push({ cmd: 'key.set', args: { id, prop: 'camera.focalLength' } });
    }
    if (calls.length) app.run(calls, { label: '加入關鍵影格' });
    else app.toast('先選取要加入關鍵影格的物件', 'info');
  };

  const ticks = useMemo(() => {
    const step = pps > 260 ? 0.25 : pps > 120 ? 0.5 : pps > 40 ? 1 : pps > 18 ? 2 : 5;
    const out: { t: number; major: boolean }[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push({ t: Math.round(t * 1000) / 1000, major: Math.abs(t - Math.round(t)) < 1e-6 });
    return out;
  }, [pps, duration]);

  return (
    <div className="timeline" aria-label="時間軸">
      <div className="transport">
        <button aria-label="回到開頭" title="回到開頭 (Home)" onClick={() => app.seek(0)}>
          ⏮
        </button>
        <button aria-label="上一個關鍵影格" title="上一個關鍵影格/剪輯點 (Shift+←)" onClick={() => jump(-1)}>
          ◆◀
        </button>
        <button aria-label={playing ? '暫停' : '播放'} className="play" title="播放/暫停 (Space)" onClick={() => app.togglePlay()}>
          {playing ? '⏸' : '▶'}
        </button>
        <button aria-label="下一個關鍵影格" title="下一個關鍵影格/剪輯點 (Shift+→)" onClick={() => jump(1)}>
          ▶◆
        </button>
        <button aria-label="循環播放" className={loop ? 'on' : ''} title="循環播放" onClick={() => setUI(app.store, { loop: !loop })}>
          ⟲
        </button>
        <span className="timecode" ref={timeRef} />
        <span className="muted">/ {duration}s @ {fps}fps</span>
        <LiveCamera project={project} />
        <span className="spacer" />
        <button title="為選取物件在目前時間加入關鍵影格 (K)" onClick={addKeyForSelection}>
          ◆ 加關鍵影格
        </button>
        <button className={autoKey ? 'rec on' : 'rec'} aria-pressed={autoKey} title="自動關鍵影格：開啟後拖動物件會在目前時間記錄關鍵影格" onClick={() => setUI(app.store, { autoKey: !autoKey })}>
          ● 自動關鍵影格
        </button>
        <label className="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> 顯示全部物件
        </label>
        <label className="zoom" title="時間軸縮放">
          🔍
          <input type="range" aria-label="時間軸縮放" min={1} max={8} step={0.1} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: LABEL_W + contentW + 24 }}>
          <div className="tl-row ruler">
            <div className="tl-label">時間</div>
            <div className="tl-lane" style={{ width: contentW }} onPointerDown={scrubStart}>
              {ticks.map((tk) => (
                <div key={tk.t} className={`tick ${tk.major ? 'major' : ''}`} style={{ left: tk.t * pps }}>
                  {tk.major && <span>{tk.t}s</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="tl-row cuts">
            <div className="tl-label">
              🎬 剪輯
              <CutAdder cams={cams} />
            </div>
            <div className="tl-lane" style={{ width: contentW }} onPointerDown={scrubStart}>
              {cuts.map((c, i) => {
                const end = cuts[i + 1]?.t ?? duration;
                const cam = cams.find((x) => x.id === c.camera);
                const off = dragOffset('cut', 'cut', c.t);
                return (
                  <div
                    key={`${c.t}-${c.camera}`}
                    className="cut-block"
                    style={{ left: c.t * pps + off, width: Math.max(4, (end - c.t) * pps - off), background: cam?.color ?? '#666' }}
                    title={`${c.t}s → ${cam?.name ?? c.camera}（右鍵：選單；拖曳左緣：改時間）`}
                    onPointerDown={(e) => {
                      if ((e.nativeEvent.offsetX ?? 99) < 8) startDrag(e, 'cut', 'cut', [], c.t);
                      else {
                        e.stopPropagation();
                        app.select([c.camera]);
                        app.seek(Math.max(c.t, app.store.getState().ui.time >= c.t && app.store.getState().ui.time < end ? app.store.getState().ui.time : c.t));
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        items: [
                          ...cams.map((cm) => ({ label: `改用 ${cm.name || cm.id}`, checked: cm.id === c.camera, action: () => app.run({ cmd: 'cut.set', args: { t: c.t, camera: cm.id } }) })),
                          { label: '刪除這個剪輯點', danger: true, action: () => app.run({ cmd: 'cut.remove', args: { t: c.t } }) },
                        ],
                      });
                    }}
                  >
                    <span className="cut-handle" />
                    <span className="cut-name">{cam?.name ?? c.camera}</span>
                  </div>
                );
              })}
              {cuts.length === 0 && <span className="lane-hint">尚未剪輯：整段使用第一台攝影機。用「＋」或多機位監看牆切換機位。</span>}
            </div>
          </div>

          <div className="tl-row markers">
            <div className="tl-label">🚩 標記</div>
            <div
              className="tl-lane"
              style={{ width: contentW }}
              onPointerDown={scrubStart}
              onDoubleClick={(e) => {
                const t = timeAt(e.clientX);
                const label = window.prompt('標記名稱（例如：台詞 1、主角回頭）', '');
                if (label) app.run({ cmd: 'marker.set', args: { t, label } });
              }}
            >
              {project.markers.map((m) => (
                <div
                  key={m.t}
                  className="marker"
                  style={{ left: m.t * pps + dragOffset('marker', 'marker', m.t), borderColor: m.color ?? '#ffd23f' }}
                  title={`${m.t}s ${m.label}`}
                  onPointerDown={(e) => startDrag(e, 'marker', 'marker', [], m.t)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          label: '重新命名',
                          action: () => {
                            const label = window.prompt('標記名稱', m.label);
                            if (label) app.run({ cmd: 'marker.set', args: { t: m.t, label } });
                          },
                        },
                        { label: '刪除標記', danger: true, action: () => app.run({ cmd: 'marker.remove', args: { t: m.t } }) },
                      ],
                    });
                  }}
                >
                  <span>{m.label}</span>
                </div>
              ))}
              {project.markers.length === 0 && <span className="lane-hint">雙擊加入劇本標記</span>}
            </div>
          </div>

          {rows.map((o) => {
            const open = expanded.has(o.id);
            const times = allKeyTimes(o);
            const selected = selection.includes(o.id);
            const defs = propDefsFor(o).filter((d) => o.tracks[d.path]);
            return (
              <div key={o.id} className={`tl-group ${selected ? 'selected' : ''}`}>
                <div className="tl-row obj">
                  <div className="tl-label" onClick={(e) => (e.shiftKey ? app.select([...new Set([...selection, o.id])]) : app.select([o.id]))}>
                    <button
                      className="caret"
                      aria-label={open ? '收合' : '展開'}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = new Set(expanded);
                        if (open) next.delete(o.id);
                        else next.add(o.id);
                        setExpanded(next);
                      }}
                    >
                      {defs.length ? (open ? '▾' : '▸') : ' '}
                    </button>
                    <span className="swatch" style={{ background: o.color }} />
                    <span className="obj-name">
                      {getAssetType(o.type)?.icon} {o.name || o.id}
                    </span>
                  </div>
                  <div className="tl-lane" style={{ width: contentW }} onPointerDown={scrubStart}>
                    {[...times.entries()].map(([t, paths]) => (
                      <Diamond
                        key={t}
                        left={t * pps + dragOffset('key', o.id, t)}
                        title={`${t}s：${paths.join(', ')}`}
                        onPointerDown={(e) => startDrag(e, 'key', o.id, paths, t)}
                        onContextMenu={(e) => keyMenu(e, o, paths, t)}
                      />
                    ))}
                    <KeySpans obj={o} pps={pps} />
                  </div>
                </div>
                {open &&
                  defs.map((d) => (
                    <div className="tl-row prop" key={d.path}>
                      <div className="tl-label sub">{d.label}</div>
                      <div className="tl-lane" style={{ width: contentW }} onPointerDown={scrubStart}>
                        {o.tracks[d.path]!.keys.map((k) => (
                          <Diamond
                            key={k.t}
                            ease={k.ease}
                            left={k.t * pps + (drag && drag.kind === 'key' && drag.id === o.id && drag.paths.length === 1 && drag.paths[0] === d.path && sameFrame(drag.t0, k.t, fps) ? drag.dx : 0)}
                            title={`${k.t}s ${JSON.stringify(k.v)}${k.ease ? ` (${k.ease})` : ''}`}
                            onPointerDown={(e) => startDrag(e, 'key', o.id, [d.path], k.t)}
                            onContextMenu={(e) => keyMenu(e, o, [d.path], k.t)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            );
          })}
          {rows.length === 0 && <div className="lane-hint pad">場景裡還沒有動畫。選取物件後按「◆ 加關鍵影格」，移動時間再改變物件即可。</div>}
          <div className="playhead" ref={playheadRef} />
        </div>
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

function Diamond(props: { left: number; title: string; ease?: Ease; onPointerDown: (e: React.PointerEvent) => void; onContextMenu: (e: React.MouseEvent) => void }) {
  return (
    <div
      className={`diamond ${props.ease === 'hold' ? 'hold' : ''} ${props.ease === 'linear' ? 'linear' : ''}`}
      style={{ left: props.left }}
      title={props.title}
      onPointerDown={props.onPointerDown}
      onContextMenu={props.onContextMenu}
      role="button"
      aria-label={`關鍵影格 ${props.title}`}
    />
  );
}

/** Thin bars between the first and last key of each object (shows when it moves). */
function KeySpans({ obj, pps }: { obj: SceneObject; pps: number }) {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const tr of Object.values(obj.tracks)) {
    if (tr.keys.length < 2) continue;
    t0 = Math.min(t0, tr.keys[0]!.t);
    t1 = Math.max(t1, tr.keys[tr.keys.length - 1]!.t);
  }
  if (!Number.isFinite(t0)) return null;
  return <div className="key-span" style={{ left: t0 * pps, width: (t1 - t0) * pps, background: obj.color }} />;
}

function LiveCamera({ project }: { project: Project }) {
  const t = useThrottledTime(150);
  const live = programCameraAt(project, t);
  const cam = project.objects.find((o) => o.id === live);
  return <span className="live-cam">{cam ? `● 節目：${cam.name || cam.id}` : '（沒有攝影機）'}</span>;
}

function CutAdder({ cams }: { cams: SceneObject[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (!cams.length) return null;
  return (
    <span className="cut-adder">
      <button className="mini" aria-label="在時間指針處切換機位" title="在時間指針處切換機位" onClick={() => setOpen(!open)}>
        ＋
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          {cams.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                app.run({ cmd: 'cut.set', args: { t: app.store.getState().ui.time, camera: c.id } });
                setOpen(false);
              }}
            >
              <span className="swatch" style={{ background: c.color }} /> {c.name || c.id}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
