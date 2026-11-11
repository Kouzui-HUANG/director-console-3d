import { z } from 'zod';
import { editDistance } from '../assetTypes.ts';
import { keyCommands } from './keys.ts';
import { motionCommands } from './motion.ts';
import { objectCommands } from './objects.ts';
import { placeCommands } from './place.ts';
import { projectCommands } from './project.ts';
import type { CommandDef } from './types.ts';

const ALL: CommandDef[] = [...objectCommands, ...placeCommands, ...keyCommands, ...motionCommands, ...projectCommands];
const BY_NAME = new Map(ALL.map((c) => [c.name, c]));

/** Commands handled by the store (history), listed for discoverability. */
export const HISTORY_COMMANDS = [
  { name: 'history.undo', summary: 'Undo the last change (or the last N with {steps}).', label: '復原' },
  { name: 'history.redo', summary: 'Redo (or N steps with {steps}).', label: '重做' },
] as const;

export function getCommand(name: string): CommandDef | undefined {
  return BY_NAME.get(name);
}

export function listCommandDefs(): readonly CommandDef[] {
  return ALL;
}

export function suggestCommand(name: string): string {
  let best = '';
  let score = Infinity;
  for (const c of [...ALL.map((x) => x.name), ...HISTORY_COMMANDS.map((h) => h.name)]) {
    const s = editDistance(name.toLowerCase(), c.toLowerCase());
    if (s < score) {
      score = s;
      best = c;
    }
  }
  return score <= 4 ? `Did you mean "${best}"? Call listCommands() for all commands.` : 'Call listCommands() for all commands.';
}

export interface CommandInfo {
  name: string;
  summary: string;
  label: string;
  mutates: boolean;
  args: unknown;
  examples: unknown[];
}

let cache: CommandInfo[] | null = null;

/** JSON-Schema descriptions of every command (for agents / MCP). */
export function describeCommands(): CommandInfo[] {
  if (cache) return cache;
  cache = [
    ...ALL.map((c) => ({
      name: c.name,
      summary: c.summary,
      label: c.label,
      mutates: c.mutates !== false,
      args: toJsonSchema(c.args),
      examples: c.examples,
    })),
    ...HISTORY_COMMANDS.map((h) => ({
      name: h.name,
      summary: h.summary,
      label: h.label,
      mutates: true,
      args: { type: 'object', properties: { steps: { type: 'integer', minimum: 1 } } },
      examples: [{}],
    })),
  ];
  return cache;
}

export function toJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', target: 'draft-07', unrepresentable: 'any' });
  } catch {
    return { type: 'object' };
  }
}
