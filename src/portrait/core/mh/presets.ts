/** Simple settings → MakeHuman modifier values (shared by the studio, scripts and tests). */
import { yearsToAge } from './modifiers.ts';

export type Ethnicity = 'asian' | 'caucasian' | 'african' | 'mixed';
export const ETHNICITY: Record<Ethnicity, { label: string; w: [number, number, number] }> = {
  asian: { label: '東亞', w: [0, 1, 0] },
  caucasian: { label: '歐美', w: [0, 0, 1] },
  african: { label: '非洲', w: [1, 0, 0] },
  mixed: { label: '混合', w: [1 / 3, 1 / 3, 1 / 3] },
};

export interface BasicSettings {
  /** 0 = female … 1 = male */
  sex: number;
  ethnicity: Ethnicity;
  /** years */
  age: number;
  /** 0…1, 0.5 = average */
  weight: number;
  muscle: number;
  /** extra raw modifier values (`nose/nose-trans-down|up`: −1…1, …) */
  mods: Record<string, number>;
}

export function valuesOf(s: BasicSettings): Record<string, number> {
  const [af, as, ca] = ETHNICITY[s.ethnicity].w;
  return {
    'macro/Gender': s.sex,
    'macro/Age': yearsToAge(s.age),
    'macro/Weight': s.weight,
    'macro/Muscle': s.muscle,
    'macro/African': af,
    'macro/Asian': as,
    'macro/Caucasian': ca,
    ...s.mods,
  };
}
