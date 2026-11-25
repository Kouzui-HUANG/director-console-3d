/**
 * Pool of meshing Web Workers. The main thread plans (cheap octree pass), the workers evaluate
 * blocks in parallel, the main thread welds the chunks. Falls back to the main thread when
 * workers are unavailable.
 */
import { assemble, meshBlocks, planMesh, type BlockJob, type MeshChunk, type MeshData, type MeshPlan, type MeshSettings } from '../core/mesher/surfaceNets.ts';
import type { Program } from '../core/sdf/program.ts';

export interface MeshTiming {
  plan: number;
  blocks: number;
  assemble: number;
  total: number;
}

export interface MeshResult extends MeshData {
  timing: MeshTiming;
  blocks: number;
  evals: number;
  workers: number;
  h: number;
}

interface Pending {
  resolve: (c: MeshChunk) => void;
  reject: (e: Error) => void;
}

export function defaultPoolSize(): number {
  const n = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(2, Math.min(8, n - 1));
}

export class MeshPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(size = defaultPoolSize()) {
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<{ id: number; chunk?: MeshChunk; error?: string }>) => {
          const p = this.pending.get(e.data.id);
          if (!p) return;
          this.pending.delete(e.data.id);
          if (e.data.chunk) p.resolve(e.data.chunk);
          else p.reject(new Error(e.data.error ?? 'mesh worker failed'));
        };
        w.onerror = (e) => {
          for (const [id, p] of this.pending) {
            p.reject(new Error(`mesh worker error: ${e.message}`));
            this.pending.delete(id);
          }
        };
        this.workers.push(w);
      }
    } catch {
      this.workers = [];
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private run(w: Worker, program: Program, plan: Omit<MeshPlan, 'blocks'>, blocks: BlockJob[]): Promise<MeshChunk> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, program, plan, blocks });
    });
  }

  async mesh(program: Program, settings: MeshSettings): Promise<MeshResult> {
    const t0 = performance.now();
    const plan = planMesh(program, settings);
    const t1 = performance.now();
    const { blocks, ...meta } = plan;
    let chunks: MeshChunk[];
    if (!this.workers.length) chunks = [meshBlocks(program, meta, blocks)];
    else {
      const groups: BlockJob[][] = this.workers.map(() => []);
      blocks.forEach((b, i) => groups[i % groups.length]!.push(b));
      chunks = await Promise.all(groups.filter((g) => g.length).map((g, i) => this.run(this.workers[i]!, program, meta, g)));
    }
    const t2 = performance.now();
    const mesh = assemble(chunks);
    const t3 = performance.now();
    return {
      ...mesh,
      timing: { plan: t1 - t0, blocks: t2 - t1, assemble: t3 - t2, total: t3 - t0 },
      blocks: blocks.length,
      evals: plan.evals + chunks.reduce((a, c) => a + c.evals, 0),
      workers: Math.max(1, this.workers.length),
      h: settings.h,
    };
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
