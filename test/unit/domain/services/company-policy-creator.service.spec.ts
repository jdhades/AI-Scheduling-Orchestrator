import { CompanyPolicyCreator } from '../../../../src/domain/services/company-policy-creator.service';
import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import type { ICompanyPolicyRepository } from '../../../../src/domain/repositories/company-policy.repository';
import type { IRuleRephraseService } from '../../../../src/domain/services/rule-rephrase.service.interface';

const makeRepo = (): jest.Mocked<ICompanyPolicyRepository> => ({
  save: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn(),
  findById: jest.fn(),
  findAllByCompany: jest.fn(),
  findAllActiveByCompany: jest.fn(),
});

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
    const creator = new CompanyPolicyCreator(repo, registry, rephrase);

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
    const creator = new CompanyPolicyCreator(repo, registry, rephrase);

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
    const creator = new CompanyPolicyCreator(repo, registry, rephrase);

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

  it('pasa los hints del registry al rephrase service para que el LLM apunte a interpreters reales', async () => {
    const repo = makeRepo();
    const rephrase: IRuleRephraseService = {
      suggest: jest.fn().mockResolvedValue([]),
    };
    const creator = new CompanyPolicyCreator(repo, registry, rephrase);

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
