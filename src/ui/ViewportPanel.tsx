import { useEffect, useRef } from 'react';
import { app } from '../app/app.ts';
import { evaluateCamera } from '../core/evaluate.ts';
import { equivalentFocal } from '../core/lens.ts';
import { timecode } from '../export/burnin.ts';
import type { ScreenRect } from '../render/viewport.ts';
import { useDirector, usePrefs, useThrottledTime, useUI } from './hooks.ts';
import { addObjectAt, DRAG_MIME } from './LeftPanel.tsx';

const MODE_LABELS = { editor: '編輯視角', top: '俯視圖', camera: '攝影機視角', program: '節目（剪輯結果）', multiview: '多機位監看牆' } as const;

export function ViewportPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useUI((s) => s.frame);
  const mode = useUI((s) => s.viewMode);
  const lost = useUI((s) => s.contextLost);
  const fatal = useUI((s) => s.fatal);
  const ready = useUI((s) => s.ready);

  useEffect(() => {
    if (!ref.current) return;
    return app.attachViewport(ref.current);
  }, []);

  return (
    <div
      className="viewport-panel"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        const type = e.dataTransfer.getData(DRAG_MIME);
        if (!type) return;
        e.preventDefault();
        const p = app.viewport?.groundPointAt(e.clientX, e.clientY) ?? undefined;
        addObjectAt(type, p ?? undefined);
      }}
    >
      <div className="viewport-host" ref={ref} />
      <div className="overlay">
        {mode !== 'multiview' && <div className="mode-badge">{MODE_LABELS[mode]}</div>}
        {frame?.labels.map((l) => (
          <div key={l.id} className={`vp-label ${l.live ? 'live' : ''}`} style={{ left: l.x, top: l.y }}>
            {l.live ? '● ' : ''}
            {l.text}
          </div>
        ))}
        {frame?.pip && <PipFrame rect={frame.pip.rect} cameraId={frame.pip.cameraId} />}
        {frame?.shot && <ShotOverlay rect={frame.shot.rect} cameraId={frame.shot.cameraId} />}
        {frame?.cells.map((c) => (
          <div key={c.cameraId} className={`cell ${c.live ? 'live' : ''}`} style={{ left: c.rect.x, top: c.rect.y - 18, width: c.rect.w, height: c.rect.h + 18 }}>
            <div className="cell-label">
              {c.live ? '● LIVE ' : ''}
              {c.name}
            </div>
          </div>
        ))}
        {mode === 'multiview' && <div className="multiview-hint">點一下：在時間指針處切到該機位 · 雙擊：看穿該機位</div>}
        {(mode === 'camera' || mode === 'program') && !frame?.shot && ready && <div className="empty-msg">場景中沒有攝影機。到物件庫新增「攝影機」。</div>}
        {lost && <div className="empty-msg">3D 繪圖暫時中斷（GPU 重置），正在恢復…</div>}
        {fatal && <div className="empty-msg error">{fatal}</div>}
      </div>
    </div>
  );
}

function PipFrame({ rect, cameraId }: { rect: ScreenRect; cameraId: string }) {
  const name = useDirector((s) => s.project.objects.find((o) => o.id === cameraId)?.name ?? cameraId);
  return (
    <div className="pip" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onDoubleClick={() => app.setView('program')} title="節目監看（雙擊放大）">
      <span className="pip-label">● 節目 {name}</span>
    </div>
  );
}

function ShotOverlay({ rect, cameraId }: { rect: ScreenRect; cameraId: string }) {
  const guides = usePrefs((s) => s.guides);
  const project = useDirector((s) => s.project);
  const t = useThrottledTime(100);
  const cam = project.objects.find((o) => o.id === cameraId);
  let hud = '';
  if (cam && guides.hud) {
    const ev = evaluateCamera(project, cam, t);
    const lens = ev.lens === 'standard' ? `${Math.round(ev.focalLength)}mm（≈${Math.round(equivalentFocal(ev.focalLength, ev.sensor))}mm）` : ev.lens === 'fisheye' ? `魚眼 ${Math.round(ev.fisheye.fov)}°` : '360°';
    hud = `${cam.name || cam.id} · ${lens}`;
  }
  return (
    <div className="shot-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      {guides.thirds && (
        <>
          <div className="g v" style={{ left: '33.333%' }} />
          <div className="g v" style={{ left: '66.666%' }} />
          <div className="g h" style={{ top: '33.333%' }} />
          <div className="g h" style={{ top: '66.666%' }} />
        </>
      )}
      {guides.center && <div className="g-center">＋</div>}
      {guides.safe && (
        <>
          <div className="safe" style={{ inset: '5%' }} />
          <div className="safe title" style={{ inset: '10%' }} />
        </>
      )}
      {guides.hud && (
        <>
          <div className="hud tl">{hud}</div>
          <div className="hud tr">{timecode(t, project.settings.fps)}</div>
          <div className="hud bl">
            {project.settings.resolution[0]}×{project.settings.resolution[1]} · {project.settings.aspect}
          </div>
        </>
      )}
    </div>
  );
}
