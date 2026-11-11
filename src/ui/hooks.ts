import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { app, type AppUI, type Prefs } from '../app/app.ts';
import type { DirectorState } from '../core/store.ts';

export function useDirector<T>(sel: (s: DirectorState) => T): T {
  return useStore(app.store, sel);
}
export function useDirectorShallow<T>(sel: (s: DirectorState) => T): T {
  return useStore(app.store, useShallow(sel));
}
export function useUI<T>(sel: (s: AppUI) => T): T {
  return useStore(app.ui, sel);
}
export function usePrefs<T>(sel: (s: Prefs) => T): T {
  return useStore(app.prefs, sel);
}

/** Playhead time, updated at most every `ms` while playing (keeps forms cheap). */
export function useThrottledTime(ms = 120): number {
  const [t, setT] = useState(() => app.store.getState().ui.time);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return app.store.subscribe((s, prev) => {
      if (s.ui.time === prev.ui.time) return;
      const now = performance.now();
      if (!s.ui.playing || now - last > ms) {
        last = now;
        setT(s.ui.time);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = performance.now();
          setT(app.store.getState().ui.time);
        }, ms);
      }
    });
  }, [ms]);
  return t;
}
