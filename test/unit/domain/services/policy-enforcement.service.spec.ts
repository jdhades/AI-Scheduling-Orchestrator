import { PolicyEnforcementService } from '../../../../src/domain/services/policy-enforcement.service';
import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import { MinRestHoursBetweenShiftsInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-hours-between-shifts.interpreter';
import { CompanyPolicy } from '../../../../src/domain/aggregates/company-policy.aggregate';
import { PolicySeverity } from '../../../../src/domain/value-objects/policy-severity.vo';
import type { ICompanyPolicyRepository } from '../../../../src/domain/repositories/company-policy.repository';

const makeRepo = (
  policies: CompanyPolicy[],
): jest.Mocked<ICompanyPolicyRepository> => ({
  save: jest.fn(),
  delete: jest.fn(),
  findById: jest.fn(),
  findAllByCompany: jest.fn().mockResolvedValue(policies),
  findAllActiveByCompany: jest.fn().mockResolvedValue(policies),
});

describe('PolicyEnforcementService', () => {
  let registry: PolicyInterpreterRegistry;

  beforeEach(() => {
    registry = new PolicyInterpreterRegistry([
      new MinRestDaysPerWeekInterpreter(),
      new MinRestHoursBetweenShiftsInterpreter(),
    ]);
  });

  const policyWithInterpreter = (
    interpreterId: string,
    params: Record<string, unknown>,
    severity: 'hard' | 'soft' = 'hard',
  ) => {
    const p = CompanyPolicy.create({
      companyId: 'co-1',
      text: 'placeholder text long enough',
      severity: PolicySeverity.create(severity),
    });
    p.attachInterpreter(interpreterId, params);
    return p;
  };

  const policyLlmOnly = (text: string, severity: 'hard' | 'soft' = 'soft') =>
    CompanyPolicy.create({
      companyId: 'co-1',
      text,
      severity: PolicySeverity.create(severity),
    });

  describe('evaluate()', () => {
    it('clasifica violaciones hard / soft según la severidad de la policy', async () => {
      const policies = [
        policyWithInterpreter(
          'min_rest_hours_between_shifts',
          { hours: 11 },
          'hard',
        ),
        policyWithInterpreter(
          'min_rest_days_per_week',
          { days: 2, holidayCounts: true },
          'soft',
        ),
      ];
      const repo = makeRepo(policies);
      const service = new PolicyEnforcementService(repo, registry);

      // Schedule con violación en ambas:
      // - rest hours: 8h entre turnos consecutivos.
      // - rest days: trabaja todos los días de la semana.
      const shifts = [
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-20T14:00:00Z'),
          endTime: new Date('2026-04-20T22:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-21T06:00:00Z'),
          endTime: new Date('2026-04-21T14:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-22T08:00:00Z'),
          endTime: new Date('2026-04-22T16:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-23T08:00:00Z'),
          endTime: new Date('2026-04-23T16:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-24T08:00:00Z'),
          endTime: new Date('2026-04-24T16:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-25T08:00:00Z'),
          endTime: new Date('2026-04-25T16:00:00Z'),
        },
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-26T08:00:00Z'),
          endTime: new Date('2026-04-26T16:00:00Z'),
        },
      ];

      const result = await service.evaluate('co-1', { shifts });

      expect(result.hardViolations.length).toBeGreaterThan(0);
      expect(result.hardViolations[0].message).toMatch(
        /below the minimum of 11/,
      );
      expect(result.hardViolations[0].policyId).toBeDefined();
      expect(result.softViolations.length).toBeGreaterThan(0);
      expect(result.softViolations[0].message).toMatch(
        /below the minimum of 2/,
      );
      expect(result.llmOnlyPolicies).toEqual([]);
    });

    it('separa LLM-only policies en su array dedicado', async () => {
      const llmOnly = policyLlmOnly(
        'los empleados senior no trabajan feriados',
        'soft',
      );
      const policies = [
        policyWithInterpreter('min_rest_hours_between_shifts', { hours: 11 }),
        llmOnly,
      ];
      const repo = makeRepo(policies);
      const service = new PolicyEnforcementService(repo, registry);

      const result = await service.evaluate('co-1', { shifts: [] });

      expect(result.llmOnlyPolicies).toHaveLength(1);
      expect(result.llmOnlyPolicies[0].getText()).toMatch(/senior no trabajan/);
    });

    it('si el interpreterId persistido no existe en el registry, fallback a LLM-only', async () => {
      const orphan = policyWithInterpreter('this_interpreter_was_removed', {
        foo: 'bar',
      });
      const repo = makeRepo([orphan]);
      const service = new PolicyEnforcementService(repo, registry);

      const result = await service.evaluate('co-1', { shifts: [] });

      expect(result.hardViolations).toEqual([]);
      expect(result.llmOnlyPolicies).toHaveLength(1);
    });

    it('schedule sin violaciones devuelve listas vacías', async () => {
      const policies = [
        policyWithInterpreter('min_rest_hours_between_shifts', { hours: 11 }),
      ];
      const repo = makeRepo(policies);
      const service = new PolicyEnforcementService(repo, registry);

      const shifts = [
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-20T08:00:00Z'),
          endTime: new Date('2026-04-20T16:00:00Z'),
        },
        // siguiente turno con 16h de descanso → cumple.
        {
          employeeId: 'e1',
          startTime: new Date('2026-04-21T08:00:00Z'),
          endTime: new Date('2026-04-21T16:00:00Z'),
        },
      ];

      const result = await service.evaluate('co-1', { shifts });

      expect(result.hardViolations).toEqual([]);
      expect(result.softViolations).toEqual([]);
    });
  });

  describe('formatForPrompt()', () => {
    it('agrupa hard / soft / LLM-only en secciones separadas', async () => {
      const policies = [
        policyWithInterpreter(
          'min_rest_hours_between_shifts',
          { hours: 11 },
          'hard',
        ),
        policyWithInterpreter(
          'min_rest_days_per_week',
          { days: 2, holidayCounts: false },
          'soft',
        ),
        policyLlmOnly('Senior employees should not work holidays', 'hard'),
      ];
      const repo = makeRepo(policies);
      const service = new PolicyEnforcementService(repo, registry);

      const prompt = await service.formatForPrompt('co-1');

      expect(prompt).toContain('== Hard Policies (must respect) ==');
      expect(prompt).toContain('Each employee must rest at least 11 hours');
      expect(prompt).toContain('== Soft Policies (preferences) ==');
      expect(prompt).toContain('Each employee must have at least 2 rest day');
      expect(prompt).toContain('holidays do not count');
      expect(prompt).toContain('== Policies expressed in natural language');
      expect(prompt).toContain('Senior employees should not work holidays');
    });

    it('omite secciones vacías', async () => {
      const policies = [
        policyWithInterpreter(
          'min_rest_hours_between_shifts',
          { hours: 11 },
          'hard',
        ),
      ];
      const repo = makeRepo(policies);
      const service = new PolicyEnforcementService(repo, registry);

      const prompt = await service.formatForPrompt('co-1');

      expect(prompt).toContain('Hard Policies');
      expect(prompt).not.toContain('Soft Policies');
      expect(prompt).not.toContain('natural language');
    });

    it('devuelve string vacío si no hay policies activas', async () => {
      const repo = makeRepo([]);
      const service = new PolicyEnforcementService(repo, registry);

      const prompt = await service.formatForPrompt('co-1');
      expect(prompt).toBe('');
    });
  });

  describe('evaluateLoaded() / formatLoaded()', () => {
    it('comparten resultado con la versión async pero sin tocar DB', async () => {
      const policies = [
        policyWithInterpreter('min_rest_hours_between_shifts', { hours: 11 }),
      ];
      const repo = makeRepo([]);
      const service = new PolicyEnforcementService(repo, registry);

      const result = await service.evaluateLoaded(policies, { shifts: [] });
      const prompt = service.formatLoaded(policies);

      expect(result.hardViolations).toEqual([]);
      expect(prompt).toContain('Hard Policies');
      expect(repo.findAllActiveByCompany).not.toHaveBeenCalled();
    });
  });
});
