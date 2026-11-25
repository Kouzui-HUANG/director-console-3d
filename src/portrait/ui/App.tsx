import { useEffect, useRef, useState } from 'react';
import { studio } from '../app.ts';
import { undo, redo } from '../core/store.ts';
import { CommandConsole, Toasts } from './CommandConsole.tsx';
import { Dialogs, importFile } from './Dialogs.tsx';
import { setUI, useUI } from './hooks.ts';
import { LeftPanel } from './LeftPanel.tsx';
import { ParamPanel } from './ParamPanel.tsx';
import { addReferenceFiles, CompareOverlay } from './References.tsx';
import { Toolbar } from './Toolbar.tsx';
import { VIEW_KEYS, ViewBar } from './ViewBar.tsx';

function StatusBar() {
  const s = useUI((x) => x);
  const warnings = s.issues.filter((i) => i.level !== 'note').length;
  return (
    <footer className="pt-status" aria-live="polite">
      {s.error ? (
        <span className="err">錯誤：{s.error}</span>
      ) : s.stats ? (
        <span>
          {s.busy ? '計算中…　' : ''}身高 {s.stats.heightCm} cm・頭身比 {s.stats.headsTall}・細分 {s.stats.level} 級・{(s.stats.triangles / 10000).toFixed(1)} 萬三角面・{(s.stats.ms / 1000).toFixed(2)} 秒{warnings ? <span className="warn">　⚠ {warnings} 則警告（見左側「檢查」）</span> : null}
        </span>
      ) : (
        <span>載入 MakeHuman 資料中…</span>
      )}
    </footer>
  );
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    void studio.init(host.current).then((c) => {
      if (cancelled) c();
      else cleanup = c;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo(studio.doc);
        else undo(studio.doc);
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void studio.saveNow({ thumbnail: true }).then(() => studio.toast('已儲存', 'success'));
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setUI({ consoleOpen: !studio.ui.getState().consoleOpen });
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        studio.openDialog('export');
        return;
      }
      if (typing || mod) return;
      if (e.key === 'Escape') setUI({ dialog: null });
      else if (e.key === 't' || e.key === 'T') setUI({ turntable: !studio.ui.getState().turntable });
      else if (e.key === 'f' || e.key === 'F') studio.frame();
      else if (e.key === '?') studio.openDialog('help');
      else {
        const i = Number(e.key) - 1;
        if (i >= 0 && i < 6) {
          setUI({ view: VIEW_KEYS[i]! });
          studio.viewer?.setView(VIEW_KEYS[i]!);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="pt-app"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = [...e.dataTransfer.files];
        const images = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|hei[cf])$/i.test(f.name));
        if (images.length) void addReferenceFiles(images);
        else if (files[0]) importFile(files[0]);
      }}
    >
      <Toolbar />
      <div className="pt-main">
        <LeftPanel />
        <main className="pt-center">
          <ViewBar />
          <div className="pt-view" ref={host} aria-label="3D 人像檢視" />
          <CompareOverlay />
          <CommandConsole />
        </main>
        <ParamPanel />
      </div>
      <StatusBar />
      <Dialogs />
      <Toasts />
      {drag ? <div className="pt-drop">放開：照片加入參考照片・.portrait.json 匯入人像</div> : null}
    </div>
  );
}
