import { OperationalBreakdownService } from '../../../../src/domain/services/operational-breakdown.service';
import { Employee } from '../../../../src/domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../../src/domain/value-objects/experience-level.vo';
import { ShiftTemplate } from '../../../../src/domain/aggregates/shift-template.aggregate';
import { ShiftAssignment } from '../../../../src/domain/aggregates/shift-assignment.aggregate';
import { DemandWeight } from '../../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../../src/domain/value-objects/undesirable-weight.vo';
import { FairnessHistoryVO } from '../../../../src/domain/value-objects/fairness-history.vo';

const COMPANY = 'co-1';

function emp(id: string, name: string, departmentId?: string): Employee {
  return Employee.fromPersistence({
    id,
    companyId: COMPANY,
    name,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+5491100000000'),
    experience: new ExperienceLevel(12, {
      junior: 6,
      intermediate: 18,
      senior: 36,
    }),
    departmentId,
  });
}

function tpl(opts: {
  id: string;
  name: string;
  dayOfWeek: number;
  start: string;
  end: string;
  required: number | null;
  departmentId?: string;
  active?: boolean;
}): ShiftTemplate {
  return ShiftTemplate.create({
    id: opts.id,
    name: opts.name,
    companyId: COMPANY,
    dayOfWeek: opts.dayOfWeek,
    startTime: opts.start,
    endTime: opts.end,
    requiredSkillId: null,
    requiredSkillLevel: 'medium' as any,
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.medium(),
    undesirableWeight: UndesirableWeight.create(0),
    requiredEmployees: opts.required ?? undefined,
    departmentId: opts.departmentId,
    isActive: opts.active ?? true,
  });
}

function assignment(
  templateId: string,
  date: string,
  employeeId: string,
): ShiftAssignment {
  return ShiftAssignment.create({
    id: `${templateId}-${date}-${employeeId}`,
    templateId,
    date,
    employeeId,
    companyId: COMPANY,
    origin: 'membership',
    strategyType: 'hybrid',
    fairnessSnapshot: {},
    actualStartTime: new Date(`${date}T08:00:00Z`),
    actualEndTime: new Date(`${date}T16:00:00Z`),
  });
}

function fairnessVo(
  employeeId: string,
  hours: number,
  weekStart = '2026-04-20',
): FairnessHistoryVO {
  return FairnessHistoryVO.create({
    employeeId,
    companyId: COMPANY,
    weekStart: new Date(`${weekStart}T00:00:00Z`),
    hoursWorked: hours,
    undesirableCount: 0,
    nightShiftCount: 0,
    weekendCount: 0,
    voluntaryExtraShifts: 0,
  });
}

function supabaseStub(behavior: {
  depts?: Array<{ id: string; name: string }>;
  swapRows?: Array<{ requester_id: string }>;
  dayOffRows?: Array<{ employee_id: string }>;
  absenceRows?: Array<{ employee_id: string }>;
  llmRows?: Array<{ operation: string; total_tokens: number }>;
  runRows?: Array<{ source: string }>;
  auditRows?: Array<{ entity_id: string }>;
  auditCount?: number;
}) {
  const make = (resolver: () => Promise<any>) => {
    const chain: any = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.is = () => chain;
    chain.gte = () => chain;
    chain.lte = () => chain;
    chain.in = () => chain;
    chain.order = () => chain;
    chain.then = (onFulfilled: any) => resolver().then(onFulfilled);
    return chain;
  };
  return {
    from: jest.fn((table: string) => {
      if (table === 'departments')
        return make(async () => ({ data: behavior.depts ?? [], error: null }));
      if (table === 'shift_swap_requests')
        return make(async () => ({
          data: behavior.swapRows ?? [],
          error: null,
        }));
      if (table === 'day_off_requests')
        return make(async () => ({
          data: behavior.dayOffRows ?? [],
          error: null,
        }));
      if (table === 'absence_reports')
        return make(async () => ({
          data: behavior.absenceRows ?? [],
          error: null,
          count: behavior.absenceRows?.length ?? 0,
        }));
      if (table === 'llm_usage_log')
        return make(async () => ({
          data: behavior.llmRows ?? [],
          error: null,
        }));
      if (table === 'schedule_generation_runs')
        return make(async () => ({
          data: behavior.runRows ?? [],
          error: null,
        }));
      if (table === 'entity_audit_log') {
        return make(async () => ({
          data: behavior.auditRows ?? [],
          error: null,
          count: behavior.auditCount ?? behavior.auditRows?.length ?? 0,
        }));
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  } as any;
}

describe('OperationalBreakdownService', () => {
  describe('byDepartment', () => {
    it('agrupa coverage + fairness + horas por dept', async () => {
      const employees = [
        emp('e1', 'Ana', 'd-retail'),
        emp('e2', 'Bob', 'd-retail'),
        emp('e3', 'Carla', 'd-caja'),
      ];
      const templates = [
        tpl({
          id: 't-retail-mon',
          name: 'Retail Mon',
          dayOfWeek: 1,
          start: '09:00',
          end: '13:00',
          required: 2,
          departmentId: 'd-retail',
        }),
        tpl({
          id: 't-caja-mon',
          name: 'Caja Mon',
          dayOfWeek: 1,
          start: '09:00',
          end: '13:00',
          required: 1,
          departmentId: 'd-caja',
        }),
      ];
      const assignments = [
        assignment('t-retail-mon', '2026-04-20', 'e1'), // 1/2 retail
        assignment('t-caja-mon', '2026-04-20', 'e3'), // 1/1 caja
      ];

      const service = new OperationalBreakdownService(
        { findAllByCompany: jest.fn().mockResolvedValue(employees) } as any,
        { findAllByCompany: jest.fn().mockResolvedValue(templates) } as any,
        {
          findByCompanyAndDateRange: jest.fn().mockResolvedValue(assignments),
        } as any,
        {
          findByWeek: jest
            .fn()
            .mockResolvedValue([
              fairnessVo('e1', 8),
              fairnessVo('e2', 8),
              fairnessVo('e3', 8),
            ]),
        } as any,
        supabaseStub({
          depts: [
            { id: 'd-retail', name: 'Retail' },
            { id: 'd-caja', name: 'Caja' },
          ],
        }),
      );

      const rows = await service.byDepartment(
        COMPANY,
        ['2026-04-20'],
        'monday',
      );

      const retail = rows.find((r) => r.id === 'd-retail')!;
      expect(retail.employeeCount).toBe(2);
      expect(retail.coverageAvgPercent).toBe(50); // 1/2 = 50%
      expect(retail.avgHoursPerEmployee).toBe(8); // (8+8)/2

      const caja = rows.find((r) => r.id === 'd-caja')!;
      expect(caja.employeeCount).toBe(1);
      expect(caja.coverageAvgPercent).toBe(100);
    });

    it('coverageAvgPercent=null cuando el dept no tiene templates con required', async () => {
      const service = new OperationalBreakdownService(
        { findAllByCompany: jest.fn().mockResolvedValue([]) } as any,
        { findAllByCompany: jest.fn().mockResolvedValue([]) } as any,
        { findByCompanyAndDateRange: jest.fn().mockResolvedValue([]) } as any,
        { findByWeek: jest.fn().mockResolvedValue([]) } as any,
        supabaseStub({ depts: [{ id: 'd', name: 'X' }] }),
      );
      const rows = await service.byDepartment(
        COMPANY,
        ['2026-04-20'],
        'monday',
      );
      expect(rows[0].coverageAvgPercent).toBeNull();
    });
  });

  describe('byEmployee', () => {
    it('ranking de horas + reliabilityScore composite', async () => {
      const employees = [emp('e1', 'Ana'), emp('e2', 'Bob')];
      const service = new OperationalBreakdownService(
        { findAllByCompany: jest.fn().mockResolvedValue(employees) } as any,
        { findAllByCompany: jest.fn() } as any,
        { findByCompanyAndDateRange: jest.fn() } as any,
        {
          findByWeek: jest
            .fn()
            .mockResolvedValue([fairnessVo('e1', 40), fairnessVo('e2', 20)]),
        } as any,
        supabaseStub({
          swapRows: [{ requester_id: 'e1' }], // e1: 1 swap
          dayOffRows: [{ employee_id: 'e2' }, { employee_id: 'e2' }], // e2: 2 dayoffs
          absenceRows: [{ employee_id: 'e2' }], // e2: 1 absence
        }),
      );

      const rows = await service.byEmployee(COMPANY, ['2026-04-20'], 'monday');

      const ana = rows.find((r) => r.id === 'e1')!;
      expect(ana.hoursWorked).toBe(40);
      expect(ana.hoursVsMean).toBe(10); // mean=30
      expect(ana.absenceCount).toBe(0);
      expect(ana.swapCount).toBe(1);
      // 100 - 1*3 = 97
      expect(ana.reliabilityScore).toBe(97);

      const bob = rows.find((r) => r.id === 'e2')!;
      expect(bob.hoursWorked).toBe(20);
      expect(bob.hoursVsMean).toBe(-10);
      expect(bob.absenceCount).toBe(1);
      expect(bob.dayOffCount).toBe(2);
      // 100 - 1*10 - 2*2 = 86
      expect(bob.reliabilityScore).toBe(86);
    });
  });

  describe('byTemplate', () => {
    it('fillRate + avgAssigned + manualModifications', async () => {
      const templates = [
        tpl({
          id: 't1',
          name: 'Morning',
          dayOfWeek: 1,
          start: '09:00',
          end: '13:00',
          required: 2,
        }),
      ];
      const assignments = [
        assignment('t1', '2026-04-20', 'e1'), // 1/2 → no fill
        assignment('t1', '2026-04-27', 'e1'),
        assignment('t1', '2026-04-27', 'e2'), // 2/2 → fill
      ];
      const service = new OperationalBreakdownService(
        { findAllByCompany: jest.fn() } as any,
        { findAllByCompany: jest.fn().mockResolvedValue(templates) } as any,
        {
          findByCompanyAndDateRange: jest.fn().mockResolvedValue(assignments),
        } as any,
        { findByWeek: jest.fn() } as any,
        supabaseStub({
          auditRows: [
            { entity_id: 't1-2026-04-20-e1' }, // 1 modificación a una assignment de t1
          ],
        }),
      );

      const rows = await service.byTemplate(
        COMPANY,
        ['2026-04-20', '2026-04-27'],
        'monday',
      );

      const t1 = rows[0];
      expect(t1.instancesCount).toBe(2); // 2 lunes en el período
      // assignedByDate: {2026-04-20: 1, 2026-04-27: 2}; fill 1/2 = 50%
      expect(t1.fillRate).toBe(50);
      expect(t1.avgAssigned).toBe(1.5);
      expect(t1.manualModifications).toBe(1);
    });
  });

  describe('crossCutting', () => {
    it('channel split + WhatsApp LLM activity + schedule churn', async () => {
      const assignments = [
        assignment('t1', '2026-04-20', 'e1'),
        assignment('t1', '2026-04-21', 'e1'),
      ];
      const service = new OperationalBreakdownService(
        { findAllByCompany: jest.fn() } as any,
        { findAllByCompany: jest.fn() } as any,
        {
          findByCompanyAndDateRange: jest.fn().mockResolvedValue(assignments),
        } as any,
        { findByWeek: jest.fn() } as any,
        supabaseStub({
          runRows: [
            { source: 'whatsapp' },
            { source: 'whatsapp' },
            { source: 'http' },
          ],
          llmRows: [
            { operation: 'whatsapp_classify', total_tokens: 100 },
            { operation: 'whatsapp_classify', total_tokens: 150 },
            { operation: 'whatsapp_classify_audio', total_tokens: 300 },
            { operation: 'schedule_generation', total_tokens: 9999 }, // no cuenta
          ],
          auditCount: 1,
        }),
      );

      const m = await service.crossCutting(COMPANY, ['2026-04-20'], 'monday');

      expect(m.generations.fromWhatsapp).toBe(2);
      expect(m.generations.fromPanel).toBe(1);
      expect(m.generations.whatsappShare).toBe(66.7);
      expect(m.whatsappLlm.classifyTextCalls).toBe(2);
      expect(m.whatsappLlm.classifyAudioCalls).toBe(1);
      expect(m.whatsappLlm.totalTokens).toBe(550);
      // 1 modificación / 2 assignments = 50%
      expect(m.scheduleChurnPercent).toBe(50);
    });
  });
});
