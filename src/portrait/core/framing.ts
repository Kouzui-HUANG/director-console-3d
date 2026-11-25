/** Framing types → cut planes (fractions of body height below the eye line; see BustCut). */
import type { BustCut } from './mh/human.ts';
import type { FramingType } from './schema.ts';

export const FRAMING_CUTS: Record<FramingType, BustCut | null> = {
  /** Head and neck: cut at the base of the neck, the shoulders trimmed off steeply. */
  head: { below: 0.105, half: 0.05, sideAngle: 72 },
  /** Mid-chest, arms cut obliquely below the deltoids (classical bust). */
  bust: { below: 0.19, half: 0.085, sideAngle: 60 },
  /** Waist up, cut just below the navel (through the hanging forearms). */
  half: { below: 0.37, half: 0.4, sideAngle: 90 },
  full: null,
};
