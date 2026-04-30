import { LLMRuntimeInterpreter } from '../../../../src/domain/services/policy-interpreters/llm-runtime.interpreter';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';

const makeLlm = (response: string): jest.Mocked<ILLMService> =>
  ({
    complete: jest.fn().mockResolvedValue(response),
    completeMultimodal: jest.fn(),
  }) as never;

const shift = (
  employeeId: string,
  startISO: string,
  endISO: string,
) => ({
  employeeId,
  startTime: new Date(startISO),
  endTime: new Date(endISO),
});

describe('LLMRuntimeInterpreter', () => {
  it('declara el flag catchAll y matches() siempre devuelve false', () => {
    const itp = new LLMRuntimeInterpreter(makeLlm('{"violations":[]}'));
    expect(itp.id).toBe('llm_runtime');
    expect(itp.catchAll).toBe(true);
    expect(itp.matches('cualquier texto')).toBe(false);
  });

  it('apply() devuelve [] cuando no hay shifts (skip LLM call)', async () => {
    const llm = makeLlm('SHOULD_NOT_BE_CALLED');
    const itp = new LLMRuntimeInterpreter(llm);
    const out = await itp.apply({ shifts: [] }, { originalText: 'foo' });
    expect(out).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('apply() parsea violaciones JSON correctas', async () => {
    const llm = makeLlm(`{
      "violations": [
        {"employeeId": "emp-1", "scope": "2026-05-04", "message": "Trabajó >24h consecutivas."}
      ]
    }`);
    const itp = new LLMRuntimeInterpreter(llm);
    const out = await itp.apply(
      {
        shifts: [shift('emp-1', '2026-05-04T08:00:00Z', '2026-05-05T08:00:00Z')],
      },
      { originalText: 'Nadie trabaja más de 24h consecutivas.' },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      employeeId: 'emp-1',
      scope: '2026-05-04',
      message: 'Trabajó >24h consecutivas.',
    });
  });

  it('apply() filtra employeeIds desconocidos pero conserva el message', async () => {
    const llm = makeLlm(`{
      "violations": [
        {"employeeId": "emp-ghost", "message": "X"},
        {"employeeId": null, "message": "Y"}
      ]
    }`);
    const itp = new LLMRuntimeInterpreter(llm);
    const out = await itp.apply(
      { shifts: [shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')] },
      { originalText: 'foo' },
    );
    expect(out).toHaveLength(2);
    expect(out[0].employeeId).toBeUndefined(); // emp-ghost no está en shifts
    expect(out[1].employeeId).toBeUndefined(); // null
  });

  it('apply() fail-open: si el LLM lanza error, devuelve [] (no bloquea schedules)', async () => {
    const llm: jest.Mocked<ILLMService> = {
      complete: jest.fn().mockRejectedValue(new Error('LLM down')),
      completeMultimodal: jest.fn(),
    } as never;
    const itp = new LLMRuntimeInterpreter(llm);
    const out = await itp.apply(
      { shifts: [shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')] },
      { originalText: 'foo' },
    );
    expect(out).toEqual([]);
  });

  it('apply() devuelve [] si el LLM devuelve JSON inválido', async () => {
    const itp = new LLMRuntimeInterpreter(makeLlm('not a json at all'));
    const out = await itp.apply(
      { shifts: [shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')] },
      { originalText: 'foo' },
    );
    expect(out).toEqual([]);
  });

  it('apply() acepta JSON dentro de code fences', async () => {
    const llm = makeLlm(
      '```json\n{"violations":[{"message":"hola"}]}\n```',
    );
    const itp = new LLMRuntimeInterpreter(llm);
    const out = await itp.apply(
      { shifts: [shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')] },
      { originalText: 'foo' },
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('hola');
  });

  it('format() devuelve el texto original (lo que ve el LLM-proposer en el prompt)', () => {
    const itp = new LLMRuntimeInterpreter(makeLlm('{}'));
    expect(itp.format({ originalText: 'mi regla rara' })).toBe('mi regla rara');
  });
});
