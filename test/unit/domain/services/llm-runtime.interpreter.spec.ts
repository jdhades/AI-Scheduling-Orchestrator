import { LLMRuntimeInterpreter } from '../../../../src/domain/services/policy-interpreters/llm-runtime.interpreter';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';
import type { LlmResolverService } from '../../../../src/application/services/llm-resolver.service';

/**
 * Mock resolver — forCompany devuelve un ILLMService que delega al
 * mock pasado. Saca la dependencia del provider real, budget, etc.
 */
const makeResolver = (llm: ILLMService): LlmResolverService =>
  ({
    forCompany: jest.fn().mockResolvedValue(llm),
    default: jest.fn().mockReturnValue(llm),
  }) as unknown as LlmResolverService;

const makeLlm = (response: string): jest.Mocked<ILLMService> =>
  ({
    complete: jest.fn().mockResolvedValue(response),
    completeMultimodal: jest.fn(),
  }) as never;

const shift = (employeeId: string, startISO: string, endISO: string) => ({
  employeeId,
  startTime: new Date(startISO),
  endTime: new Date(endISO),
});

// Helper: todos los tests usan un context que incluye companyId para
// que el interpreter ejerza el path "real" (resolver). El path sin
// companyId (fail-open) está en su propio test al final.
const ctx = (shifts: Array<ReturnType<typeof shift>>) => ({
  shifts,
  companyId: 'co-1',
});

describe('LLMRuntimeInterpreter', () => {
  it('declara el flag catchAll y matches() siempre devuelve false', () => {
    const itp = new LLMRuntimeInterpreter(
      makeResolver(makeLlm('{"violations":[]}')),
    );
    expect(itp.id).toBe('llm_runtime');
    expect(itp.catchAll).toBe(true);
    expect(itp.matches('cualquier texto')).toBe(false);
  });

  it('apply() devuelve [] cuando no hay shifts (skip LLM call)', async () => {
    const llm = makeLlm('SHOULD_NOT_BE_CALLED');
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    const out = await itp.apply(ctx([]), { originalText: 'foo' });
    expect(out).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('apply() parsea violaciones JSON correctas', async () => {
    const llm = makeLlm(`{
      "violations": [
        {"employeeId": "emp-1", "scope": "2026-05-04", "message": "Trabajó >24h consecutivas."}
      ]
    }`);
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    const out = await itp.apply(
      ctx([shift('emp-1', '2026-05-04T08:00:00Z', '2026-05-05T08:00:00Z')]),
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
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    const out = await itp.apply(
      ctx([shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')]),
      { originalText: 'foo' },
    );
    expect(out).toHaveLength(2);
    expect(out[0].employeeId).toBeUndefined();
    expect(out[1].employeeId).toBeUndefined();
  });

  it('apply() fail-open: si el LLM lanza error, devuelve [] (no bloquea schedules)', async () => {
    const llm: jest.Mocked<ILLMService> = {
      complete: jest.fn().mockRejectedValue(new Error('LLM down')),
      completeMultimodal: jest.fn(),
    } as never;
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    const out = await itp.apply(
      ctx([shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')]),
      { originalText: 'foo' },
    );
    expect(out).toEqual([]);
  });

  it('apply() devuelve [] si el LLM devuelve JSON inválido', async () => {
    const itp = new LLMRuntimeInterpreter(
      makeResolver(makeLlm('not a json at all')),
    );
    const out = await itp.apply(
      ctx([shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')]),
      { originalText: 'foo' },
    );
    expect(out).toEqual([]);
  });

  it('apply() acepta JSON dentro de code fences', async () => {
    const llm = makeLlm('```json\n{"violations":[{"message":"hola"}]}\n```');
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    const out = await itp.apply(
      ctx([shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z')]),
      { originalText: 'foo' },
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('hola');
  });

  it('format() devuelve el texto original (lo que ve el LLM-proposer en el prompt)', () => {
    const itp = new LLMRuntimeInterpreter(makeResolver(makeLlm('{}')));
    expect(itp.format({ originalText: 'mi regla rara' })).toBe('mi regla rara');
  });

  it('fail-open cuando falta companyId en el context (defensive)', async () => {
    const llm = makeLlm('SHOULD_NOT_BE_CALLED');
    const itp = new LLMRuntimeInterpreter(makeResolver(llm));
    // Pasamos shifts pero NO companyId — defensive branch del interpreter.
    const out = await itp.apply(
      {
        shifts: [
          shift('emp-1', '2026-05-04T00:00:00Z', '2026-05-04T08:00:00Z'),
        ],
      },
      { originalText: 'foo' },
    );
    expect(out).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});
