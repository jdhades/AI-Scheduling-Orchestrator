import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LLMUsage {
  prompt: number;
  completion: number;
  total: number;
  calls: number;
}

interface Acc extends LLMUsage {}

/**
 * LLMUsageTracker — acumula tokens LLM dentro de un scope async.
 *
 * Uso:
 *   const { result, usage } = await tracker.run(async () => doWork());
 *
 * Cualquier `tracker.record({ prompt, completion, total })` disparado por
 * un servicio LLM mientras la promesa corre suma al scope activo.
 *
 * Fuera de un scope, `record()` es noop — evita que llamadas sueltas
 * contaminen cálculos de generaciones específicas.
 */
@Injectable()
export class LLMUsageTracker {
  private readonly als = new AsyncLocalStorage<Acc>();

  async run<T>(fn: () => Promise<T>): Promise<{ result: T; usage: LLMUsage }> {
    const acc: Acc = { prompt: 0, completion: 0, total: 0, calls: 0 };
    const result = await this.als.run(acc, fn);
    return { result, usage: { ...acc } };
  }

  record(usage: { prompt: number; completion: number; total: number }): void {
    const acc = this.als.getStore();
    if (!acc) return;
    acc.prompt += usage.prompt;
    acc.completion += usage.completion;
    acc.total += usage.total;
    acc.calls += 1;
  }
}
