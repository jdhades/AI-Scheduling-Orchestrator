import { CompanyPolicyCreator } from '../../../../src/domain/services/company-policy-creator.service';
import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import { LLMRuntimeInterpreter } from '../../../../src/domain/services/policy-interpreters/llm-runtime.interpreter';
import type { ICompanyPolicyRepository } from '../../../../src/domain/repositories/company-policy.repository';
import type { IRuleRephraseService } from '../../../../src/domain/services/rule-rephrase.service.interface';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';

const makeRepo = (): jest.Mocked<ICompanyPolicyRepository> => ({
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn(),
  findById: jest.fn(),
  findAllByCompany: jest.fn(),
  findAllActiveByCompany: jest.fn(),
});

/**
 * Helper para mockear ILLMService. Por default `complete()` devuelve
 * `{"fullyCovered": true}` para que los tests que NO testean el
 * fallback a llm_runtime sigan tomando la rama matched. Tests
 * específicos pueden sobreescribir el mock con jest.fn().
 */
const makeLlm = (
  completeImpl: (prompt: string) => Promise<string> = async () =>
    JSON.stringify({ fullyCovered: true, reason: 'mock default' }),
): jest.Mocked<ILLMService> =>
  ({
    complete: jest.fn(completeImpl),
    completeMultimodal: jest.fn(),
  }) as never;

describe('CompanyPolicyCreator', () => {
  const baseInput = {
    companyId: 'co-1',
    text: 'cada empleado descansa al menos 2 días por semana',
    severity: 'hard' as const,
  };

  let registry: PolicyInterpreterRegistry;

  beforeEach(() => {
    registry = new PolicyInterpreterRegistry([
      new MinRestDaysPerWeekInterpreter(),
    ]);
  });

  it('cuando un interpreter matchea: persiste y devuelve {created, mode: matched}', async () => {
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = {
      suggest: jest.fn().mockResolvedValue([]),
    };
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      rephrase,
      makeLlm(),
    );

    const result = await creator.create(baseInput);

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('matched');
      expect(result.policy.getInterpreterId()).toBe('min_rest_days_per_week');
      expect(result.policy.getParams()).toEqual({
        days: 2,
        holidayCounts: true,
      });
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(rephrase.suggest).not.toHaveBeenCalled();
  });

  it('cuando ningún interpreter matchea pero el LLM propone sugerencias: devuelve needs_clarification SIN persistir', async () => {
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = {
      suggest: jest.fn().mockResolvedValue([
        {
          id: 's1',
          suggestedText: 'Cada empleado descansa al menos 2 días por semana',
          matchedInterpreterId: 'min_rest_days_per_week',
          matchedParams: { days: 2, holidayCounts: true },
          explanation: 'reformulada',
        },
      ]),
    };
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      rephrase,
      makeLlm(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'que descansen aparte del feriado',
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'needs_clarification') {
      expect(result.suggestions).toHaveLength(1);
      expect(result.reason).toBe('no_interpreter_matched');
    }
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('cuando el LLM no propone nada: persiste como LLM-only (mode: llm_only)', async () => {
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = {
      suggest: jest.fn().mockResolvedValue([]),
    };
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      rephrase,
      makeLlm(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'algo que no matchea ni hay sugerencia',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('llm_only');
      expect(result.policy.hasInterpreter()).toBe(false);
      expect(result.policy.getParams()).toEqual({});
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('matchea pero el LLM detecta matices perdidos (severity=hard) → fallback a llm_runtime', async () => {
    // Registry incluye llm_runtime para que el fallback funcione.
    const llm = makeLlm(async (prompt) => {
      // matchPreservesIntent: detecta matiz "no consecutivos" perdido.
      if (prompt.includes('preserve the manager')) {
        return JSON.stringify({
          fullyCovered: false,
          reason: 'el matcher cuenta cantidad pero pierde "no consecutivos"',
        });
      }
      // translateToEnglish: devolvemos el texto en inglés.
      return 'Each retail employee must have at least 2 non-consecutive rest days per week.';
    });
    const localRegistry = new PolicyInterpreterRegistry([
      new MinRestDaysPerWeekInterpreter(),
      new LLMRuntimeInterpreter(llm),
    ]);
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = { suggest: jest.fn() };
    const creator = new CompanyPolicyCreator(
      repo,
      localRegistry,
      rephrase,
      llm,
    );

    const result = await creator.create({
      ...baseInput,
      text: 'los empleados tienen 2 días libres por semana no consecutivos',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      // Cae a llm_runtime — preserva matices.
      expect(result.mode).toBe('llm_only');
      expect(result.policy.getInterpreterId()).toBe('llm_runtime');
      const params = result.policy.getParams();
      expect(params.originalText).toContain('no consecutivos');
      expect(params.englishText).toContain('non-consecutive');
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('matchea y el LLM confirma que la estructura preserva la intención → sigue como matched', async () => {
    // matchPreservesIntent devuelve fullyCovered=true → camino actual.
    const llm = makeLlm(async () =>
      JSON.stringify({
        fullyCovered: true,
        reason: 'el texto se reduce a N días por semana',
      }),
    );
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = { suggest: jest.fn() };
    const creator = new CompanyPolicyCreator(repo, registry, rephrase, llm);

    const result = await creator.create({
      ...baseInput,
      text: 'cada empleado descansa al menos 2 días por semana',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('matched');
      expect(result.policy.getInterpreterId()).toBe('min_rest_days_per_week');
    }
    // Solo 1 LLM call: matchPreservesIntent. translateToEnglish NO se invoca.
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('pasa los hints del registry al rephrase service para que el LLM apunte a interpreters reales', async () => {
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = {
      suggest: jest.fn().mockResolvedValue([]),
    };
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      rephrase,
      makeLlm(),
    );

    await creator.create({
      ...baseInput,
      text: 'texto que el registry no matchea',
    });

    expect(rephrase.suggest).toHaveBeenCalledWith(
      expect.objectContaining({
        originalText: 'texto que el registry no matchea',
        reason: 'no_interpreter_matched',
        interpreters: expect.arrayContaining([
          expect.objectContaining({ id: 'min_rest_days_per_week' }),
        ]),
      }),
    );
  });
});
