import { useStore } from 'zustand';
import { studio, type StudioUI } from '../app.ts';
import type { PortraitDocState } from '../core/store.ts';
import type { RefsState } from '../photo/references.ts';

export const useDoc = <T,>(sel: (s: PortraitDocState) => T): T => useStore(studio.doc, sel);
export const useUI = <T,>(sel: (s: StudioUI) => T): T => useStore(studio.ui, sel);
export const setUI = (patch: Partial<StudioUI>) => studio.ui.setState(patch);
export const useRefs = <T,>(sel: (s: RefsState) => T): T => useStore(studio.refs.store, sel);
