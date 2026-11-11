import { z } from 'zod';
import type { Project, SceneObject } from '../schema.ts';

export class CommandError extends Error {
  code: string;
  hint?: string;
  path?: (string | number)[];
  constructor(code: string, message: string, hint?: string, path?: (string | number)[]) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.path = path;
  }
}

export interface CommandContext {
  /** Immer draft of the project; mutate it directly. */
  draft: Project;
  /** Current playhead time (seconds); commands use it when `t` is omitted. */
  time: number;
  setTime(t: number): void;
  selection: string[];
  setSelection(ids: string[]): void;
  warn(message: string): void;
  /** Draft object by id, or throws NOT_FOUND with a helpful hint. */
  obj(id: string): SceneObject;
  /** Plain (non-draft) snapshot of the current draft, for read-only evaluation. */
  snapshot(): Project;
}

export interface CommandDef<A = any> {
  name: string;
  /** One-line English summary (for agents). */
  summary: string;
  /** Traditional Chinese label (for the history list / command log). */
  label: string;
  args: z.ZodType<A>;
  examples: unknown[];
  /** false = does not modify the project (UI state only). */
  mutates?: boolean;
  apply(ctx: CommandContext, args: A): unknown;
}

export function defineCommand<S extends z.ZodType>(def: {
  name: string;
  summary: string;
  label: string;
  args: S;
  examples: unknown[];
  mutates?: boolean;
  apply(ctx: CommandContext, args: z.output<S>): unknown;
}): CommandDef<z.output<S>> {
  return def as CommandDef<z.output<S>>;
}

// Lenient input shapes (normalized inside commands) ---------------------------------

/** [x, y, z] | [x, z] (ground point) | {x, y, z} */
export const Vec3In = z
  .union([
    z.tuple([z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional() }),
  ])
  .describe('[x, y, z] in meters; [x, z] = point on the ground; {x, y, z} also accepted');

export const TimeIn = z.number().min(0).max(30).describe('time in seconds');
export const IdIn = z.string().min(1).describe('object id');
export const ColorIn = z.string().describe('"#rrggbb", "#rgb" or a color name like "red"');
export const EaseIn = z.enum(['linear', 'in', 'out', 'inOut', 'hold']).describe('easing from this key to the next');
