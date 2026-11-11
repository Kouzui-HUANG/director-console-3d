import { app } from '../app/app.ts';
import { CommandConsole, Toasts } from './CommandConsole.tsx';
import { Dialogs } from './Dialogs.tsx';
import { usePrefs } from './hooks.ts';
import { Inspector } from './Inspector.tsx';
import { LeftPanel } from './LeftPanel.tsx';
import { useShortcuts } from './shortcuts.ts';
import { Timeline } from './Timeline.tsx';
import { Toolbar } from './Toolbar.tsx';
import { ViewportPanel } from './ViewportPanel.tsx';

export function App() {
  useShortcuts();
  const tlh = usePrefs((s) => s.timelineHeight);
  return (
    <div
      className="app"
      style={{ gridTemplateRows: `44px minmax(200px, 1fr) 6px ${tlh}px` }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={async (e) => {
        const f = e.dataTransfer.files?.[0];
        if (f && (f.name.endsWith('.json') || f.type === 'application/json')) {
          e.preventDefault();
          await app.importJson(await f.text());
        }
      }}
    >
      <Toolbar />
      <div className="main">
        <aside className="left">
          <LeftPanel />
        </aside>
        <section className="center">
          <ViewportPanel />
        </section>
        <aside className="right">
          <Inspector />
        </aside>
      </div>
      <div
        className="splitter"
        role="separator"
        aria-label="調整時間軸高度"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const y0 = e.clientY;
          const h0 = app.prefs.getState().timelineHeight;
          const move = (ev: PointerEvent) => app.prefs.setState({ timelineHeight: Math.max(120, Math.min(window.innerHeight * 0.6, h0 + (y0 - ev.clientY))) });
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      <Timeline />
      <Dialogs />
      <CommandConsole />
      <Toasts />
    </div>
  );
}
