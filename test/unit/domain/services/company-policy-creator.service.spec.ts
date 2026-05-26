import { CompanyPolicyCreator } from '../../../../src/domain/services/company-policy-creator.service';
import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import { LLMRuntimeInterpreter } from '../../../../src/domain/services/policy-interpreters/llm-runtime.interpreter';
import type { ICompanyPolicyRepository } from '../../../../src/domain/repositories/company-policy.repository';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';
import type { PromptHistoryService } from '../../../../src/infrastructure/observability/prompt-history.service';

const makeRepo = (): jest.Mocked<ICompanyPolicyRepository> => ({
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn(),
  findById: jest.fn(),
  findAllByCompany: jest.fn(),
  findAllActiveByCompany: jest.fn(),
});

const makeLlm = (
  completeImpl: (prompt: string) => Promise<string> = async () =>
    JSON.stringify({ fullyCovered: true, reason: 'mock default' }),
): jest.Mocked<ILLMService> =>
  ({
    complete: jest.fn(completeImpl),
    completeMultimodal: jest.fn(),
  }) as never;

const makePromptHistory = (): jest.Mocked<PromptHistoryService> =>
  ({ record: jest.fn() }) as unknown as jest.Mocked<PromptHistoryService>;

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
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      makeLlm(),
      makePromptHistory(),
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
  });

  it('cuando ningún interpreter matchea: persiste directamente como llm_only (sprint async-policies: sin suggestion loop)', async () => {
    const repo = makeRepo();
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      makeLlm(),
      makePromptHistory(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'algo que no matchea ningún interpreter',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('llm_only');
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('matchea pero el LLM detecta matices perdidos (severity=hard) → fallback a llm_runtime', async () => {
    const llm = makeLlm(async (prompt) => {
      if (prompt.includes('preserve the manager')) {
        return JSON.stringify({
          fullyCovered: false,
          reason: 'el matcher cuenta cantidad pero pierde "no consecutivos"',
        });
      }
      return 'Each retail employee must have at least 2 non-consecutive rest days per week.';
    });
    const localRegistry = new PolicyInterpreterRegistry([
      new MinRestDaysPerWeekInterpreter(),
      new LLMRuntimeInterpreter(llm),
    ]);
    const repo = makeRepo();
    const creator = new CompanyPolicyCreator(
      repo,
      localRegistry,
      llm,
      makePromptHistory(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'los empleados tienen 2 días libres por semana no consecutivos',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('llm_only');
      expect(result.policy.getInterpreterId()).toBe('llm_runtime');
      const params = result.policy.getParams();
      expect(params.originalText).toContain('no consecutivos');
      expect(params.englishText).toContain('non-consecutive');
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('matchea y el LLM confirma que la estructura preserva la intención → sigue como matched', async () => {
    const llm = makeLlm(async () =>
      JSON.stringify({
        fullyCovered: true,
        reason: 'el texto se reduce a N días por semana',
      }),
    );
    const repo = makeRepo();
    const creator = new CompanyPolicyCreator(repo, registry, llm, makePromptHistory());

    const result = await creator.create({
      ...baseInput,
      text: 'cada empleado descansa al menos 2 días por semana',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('matched');
      expect(result.policy.getInterpreterId()).toBe('min_rest_days_per_week');
    }
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('texto que el matcher no entiende + severity=hard: cae a llm_runtime con el texto original', async () => {
    const llm = makeLlm(async () => 'Custom shift pattern: 24h on / 48h off rotation.');
    const localRegistry = new PolicyInterpreterRegistry([
      new MinRestDaysPerWeekInterpreter(),
      new LLMRuntimeInterpreter(llm),
    ]);
    const repo = makeRepo();
    const creator = new CompanyPolicyCreator(
      repo,
      localRegistry,
      llm,
      makePromptHistory(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'este turno trabaja 24x48',
    });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.mode).toBe('llm_only');
      expect(result.policy.getInterpreterId()).toBe('llm_runtime');
      const params = result.policy.getParams();
      expect(params.originalText).toBe('este turno trabaja 24x48');
    }
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('persiste sin tocar el rephrase service (eliminado): no hay suggestion loop', async () => {
    // El test "pasa los hints del registry al rephrase service" del
    // sprint anterior queda obsoleto — el rephrase service ya no se
    // inyecta. Validamos en su lugar que el flujo no requiere mockear
    // ningún rephrase para terminar exitosamente.
    const repo = makeRepo();
    const creator = new CompanyPolicyCreator(
      repo,
      registry,
      makeLlm(),
      makePromptHistory(),
    );

    const result = await creator.create({
      ...baseInput,
      text: 'texto raro que ningún interpreter conoce',
    });

    expect(result.status).toBe('created');
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});
