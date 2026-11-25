/// Web Worker: meshes a subset of blocks of a planned distance field (see core/mesher/surfaceNets.ts).
import { meshBlocks, type BlockJob, type MeshPlan } from '../core/mesher/surfaceNets.ts';
import type { Program } from '../core/sdf/program.ts';

interface MeshRequest {
  id: number;
  program: Program;
  plan: Omit<MeshPlan, 'blocks'>;
  blocks: BlockJob[];
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<MeshRequest>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { id, program, plan, blocks } = e.data;
  try {
    const chunk = meshBlocks(program, plan, blocks);
    ctx.postMessage({ id, chunk }, [chunk.positions.buffer, chunk.normals.buffer, chunk.keys.buffer, chunk.quads.buffer]);
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
