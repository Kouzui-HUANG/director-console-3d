import { useEffect } from 'react';
import { app } from '../app/app.ts';
import type { CommandCall } from '../core/commands/execute.ts';
import { redo, undo } from '../core/store.ts';
import type { ViewMode } from '../render/viewport.ts';

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const VIEW_KEYS: Record<string, ViewMode> = { '1': 'editor', '2': 'top', '3': 'camera', '4': 'program', '5': 'multiview' };

export function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') app.viewport?.setSnap(true);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void app.saveNow({ thumbnail: true }).then(() => app.toast('已儲存', 'success'));
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        app.ui.setState({ consoleOpen: !app.ui.getState().consoleOpen });
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        app.openDialog('export');
        return;
      }
      if (typing(e) || app.ui.getState().dialog) {
        if (e.key === 'Escape' && app.ui.getState().dialog) app.ui.setState({ dialog: null });
        return;
      }
      const s = app.store.getState();
      const sel = s.ui.selection;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(app.store);
        else undo(app.store);
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo(app.store);
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (sel.length) {
          const r = app.run(sel.map((id) => ({ cmd: 'object.duplicate', args: { id } })));
          if (r.ok) app.select(r.results.map((x) => (x as { id: string }).id));
        }
        return;
      }
      if (mod) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          app.togglePlay();
          return;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          if (e.shiftKey) {
            const objs = sel.length ? s.project.objects.filter((o) => sel.includes(o.id)) : s.project.objects;
            const times = [...new Set([...objs.flatMap((o) => Object.values(o.tracks).flatMap((tr) => tr.keys.map((k) => k.t))), ...s.project.cuts.map((c) => c.t)])].sort((a, b) => a - b);
            const t = s.ui.time;
            const next = dir > 0 ? times.find((x) => x > t + 1e-4) : [...times].reverse().find((x) => x < t - 1e-4);
            app.seek(next ?? (dir > 0 ? s.project.settings.duration : 0));
          } else app.stepFrames(dir);
          return;
        }
        case 'Home':
          app.seek(0);
          return;
        case 'End':
          app.seek(s.project.settings.duration);
          return;
        case 'Delete':
        case 'Backspace':
          if (sel.length) app.run({ cmd: 'object.remove', args: { ids: sel } });
          return;
        case 'Escape':
          app.select([]);
          return;
        case 'f':
        case 'F':
          app.viewport?.frameSelection();
          return;
        case 'w':
        case 'W':
          app.ui.setState({ gizmoMode: 'translate' });
          return;
        case 'e':
        case 'E':
          app.ui.setState({ gizmoMode: 'rotate' });
          return;
        case 'r':
        case 'R':
          app.ui.setState({ gizmoMode: 'scale' });
          return;
        case 'c':
        case 'C': {
          const cam = sel.find((id) => s.project.objects.find((o) => o.id === id)?.type === 'camera');
          if (app.ui.getState().viewMode === 'camera' && !cam) app.setView('editor');
          else app.setView('camera', cam ?? undefined);
          return;
        }
        case 'k':
        case 'K': {
          const calls: CommandCall[] = [];
          for (const id of sel) {
            const o = s.project.objects.find((x) => x.id === id);
            if (!o) continue;
            calls.push({ cmd: 'key.set', args: { id, prop: 'position' } }, { cmd: 'key.set', args: { id, prop: 'rotation' } });
            if (o.type === 'camera') calls.push({ cmd: 'key.set', args: { id, prop: 'camera.focalLength' } });
          }
          if (calls.length) app.run(calls, { label: '加入關鍵影格' });
          return;
        }
        case '?':
          app.openDialog('help');
          return;
        default:
          if (VIEW_KEYS[e.key]) app.setView(VIEW_KEYS[e.key]!);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') app.viewport?.setSnap(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}
