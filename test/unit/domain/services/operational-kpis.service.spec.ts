import { OperationalKpisService } from '../../../../src/domain/services/operational-kpis.service';
import type { CoverageService } from '../../../../src/domain/services/coverage.service';
import type { IFairnessHistoryRepository } from '../../../../src/domain/repositories/fairness-history.repository';
import type { IShiftAssignmentRepository } from '../../../../src/domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../../../src/domain/repositories/shift-template.repository';
import { FairnessHistoryVO } from '../../../../src/domain/value-objects/fairness-history.vo';

const COMPANY = 'co-1';

function makeCoverageReport(opts: {
  weekStart: string;
  cells: Array<{ required: number; assigned: number }>;
}) {
  // 1 día, N celdas — suficiente para los cálculos. El service itera
  // days[].cells[] sin importar el tamaño.
  return {
    weekStart: opts.weekStart,
    hours: opts.cells.map((_, i) => 8 + i),
    days: [
      {
        date: opts.weekStart,
        dayOfWeek: 1,
        cells: opts.cells.map((c, i) => ({
          hour: 8 + i,
          assigned: c.assigned,
          required: c.required,
        })),
      },
    ],
  };
}

function fairnessVo(employeeId: string, hours: number): FairnessHistoryVO {
  return FairnessHistoryVO.create({
    employeeId,
    companyId: COMPANY,
    weekStart: new Date('2026-04-20T00:00:00Z'),
    hoursWorked: hours,
    undesirableCount: 0,
    nightShiftCount: 0,
    weekendCount: 0,
    voluntaryExtraShifts: 0,
  });
}

function makeSupabaseStub(behavior: {
  swapRows?: Array<{ status: string }>;
  dayOffRows?: Array<{ status: string }>;
  absenceCount?: number;
  runsRows?: Array<{ status: string }>;
}) {
  // Chainable mock — devuelve `this` excepto en el resolver final.
  const make = (resolver: () => Promise<any>) => {
    const chain: any = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.gte = () => chain;
    chain.lte = () => chain;
    chain.in = () => chain;
    chain.then = (onFulfilled: any) => resolver().then(onFulfilled);
    return chain;
  };

  return {
    from: jest.fn((table: string) => {
      if (table === 'shift_swap_requests') {
        return make(async () => ({ data: behavior.swapRows ?? [], error: null }));
      }
      if (table === 'day_off_requests') {
        return make(async () => ({ data: behavior.dayOffRows ?? [], error: null }));
      }
      if (table === 'absence_reports') {
        // count: 'exact', head: true → devuelve {count, error}
        return make(async () => ({ count: behavior.absenceCount ?? 0, error: null }));
      }
      if (table === 'schedule_generation_runs') {
        return make(async () => ({ data: behavior.runsRows ?? [], error: null }));
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  } as any;
}

function makeTpl(
  id: string,
  required: number,
  dayOfWeek: number | null = 1,
): any {
  return {
    id,
    name: id,
    dayOfWeek,
    startTime: '09:00',
    endTime: '17:00',
    requiredEmployees: required,
    isActive: true,
    requiredSkillId: null,
    demandScore: 1,
    undesirableWeight: { normalized: () => 0 } as any,
  };
}

describe('OperationalKpisService', () => {
  let service: OperationalKpisService;
  let coverageService: jest.Mocked<CoverageService>;
  let fairnessRepo: jest.Mocked<IFairnessHistoryRepository>;
  let templateRepo: jest.Mocked<IShiftTemplateRepository>;
  let assignmentRepo: jest.Mocked<IShiftAssignmentRepository>;

  beforeEach(() => {
    coverageService = { getWeekCoverage: jest.fn() } as any;
    fairnessRepo = { findByWeek: jest.fn().mockResolvedValue([]) } as any;
    templateRepo = { findAllByCompany: jest.fn().mockResolvedValue([]) } as any;
    assignmentRepo = {
      findByCompanyAndDateRange: jest.fn().mockResolvedValue([]),
    } as any;
  });

  it('coverage: promedio y unfilled — celdas sin demanda no cuentan', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({
        weekStart: '2026-04-20',
        cells: [
          { required: 0, assigned: 0 }, // no-demand → ignore
          { required: 2, assigned: 2 }, // 100%
          { required: 4, assigned: 2 }, // 50%
          { required: 1, assigned: 0 }, // 0% + unfilled
        ],
      }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({}),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');

    expect(kpis.coverage.totalRequiredCells).toBe(3);
    // (100 + 50 + 0) / 3 = 50
    expect(kpis.coverage.avgPercent).toBe(50);
    // unfilledShifts ahora se computa por turno-instancia (no celda-hora).
    // Sin templates mockeados → 0 instancias → 0 huecos. La avgPercent
    // sigue saliendo del cell-grid (que es lo que mide "% promedio de
    // cobertura horaria").
    expect(kpis.coverage.unfilledShifts).toBe(0);
  });

  it('coverage: agrega sobre múltiples weekStarts (avg)', async () => {
    coverageService.getWeekCoverage.mockResolvedValueOnce(
      makeCoverageReport({
        weekStart: '2026-04-20',
        cells: [{ required: 2, assigned: 2 }], // 100%
      }),
    );
    coverageService.getWeekCoverage.mockResolvedValueOnce(
      makeCoverageReport({
        weekStart: '2026-04-27',
        cells: [{ required: 2, assigned: 0 }], // 0%
      }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({}),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20', '2026-04-27'], 'monday');

    expect(kpis.coverage.totalRequiredCells).toBe(2);
    expect(kpis.coverage.avgPercent).toBe(50);
  });

  it('coverage: unfilledShifts cuenta por turno-instancia, no por hora', async () => {
    // El test crítico: un turno de 6h que necesita 2 personas y nadie
    // asignado debe contar 2 huecos, NO 12 (6 horas × 2). El cambio del
    // formula vino justo de este bug — el manager veía 95 cuando
    // realmente faltaban ~16 asignaciones.
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({ weekStart: '2026-04-20', cells: [] }),
    );
    // 2026-04-20 es lunes → dayOfWeek=1.
    templateRepo.findAllByCompany.mockResolvedValue([
      makeTpl('tpl-morning', 2, 1), // requires 2, dow=Mon
      makeTpl('tpl-evening', 3, 1), // requires 3, dow=Mon
    ]);
    // Solo 1 persona asignada al morning. evening sin nadie.
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([
      { templateId: 'tpl-morning', date: '2026-04-20', id: 'a1' } as any,
    ]);
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({}),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');

    // morning: required=2, assigned=1 → 1 hueco.
    // evening: required=3, assigned=0 → 3 huecos.
    // total = 4 (no inflado por horas).
    expect(kpis.coverage.unfilledShifts).toBe(4);
  });

  it('coverage: avgPercent=null cuando no hay celdas con required', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({
        weekStart: '2026-04-20',
        cells: [{ required: 0, assigned: 0 }],
      }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({}),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');
    expect(kpis.coverage.avgPercent).toBeNull();
  });

  it('approvals: cuenta swap+day_off por status; absence solo count', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({ weekStart: '2026-04-20', cells: [] }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({
        swapRows: [
          { status: 'accepted' },
          { status: 'accepted' },
          { status: 'rejected' },
          { status: 'pending' },
        ],
        dayOffRows: [
          { status: 'approved' },
          { status: 'rejected' },
          { status: 'pending' },
        ],
        absenceCount: 5,
      }),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');

    expect(kpis.approvals.swap).toEqual({ pending: 1, approved: 2, rejected: 1 });
    expect(kpis.approvals.dayOff).toEqual({ pending: 1, approved: 1, rejected: 1 });
    expect(kpis.approvals.absenceReportsCount).toBe(5);
    // approved=3, rejected=2 → 3/5 = 60%
    expect(kpis.approvals.approvalRate).toBe(60);
  });

  it('approvals: approvalRate=null cuando no hay approved+rejected', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({ weekStart: '2026-04-20', cells: [] }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({
        swapRows: [{ status: 'pending' }],
        dayOffRows: [{ status: 'pending' }],
      }),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');
    expect(kpis.approvals.approvalRate).toBeNull();
  });

  it('fairness: promedio del CV de las semanas con data', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({ weekStart: '2026-04-20', cells: [] }),
    );
    fairnessRepo.findByWeek.mockResolvedValueOnce([
      fairnessVo('e1', 20),
      fairnessVo('e2', 40),
      fairnessVo('e3', 60),
    ]);
    fairnessRepo.findByWeek.mockResolvedValueOnce([]);
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({}),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20', '2026-04-27'], 'monday');

    // hours=[20,40,60], mean=40, stdDev=√(400+0+400)/3=√(266.67)≈16.33, CV=40.82%
    expect(kpis.fairness.avgCv).toBeCloseTo(40.8, 0);
    expect(kpis.fairness.weeksWithData).toBe(1); // segunda semana vacía
  });

  it('generations: agrupa por status', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({ weekStart: '2026-04-20', cells: [] }),
    );
    service = new OperationalKpisService(
      coverageService,
      fairnessRepo,
      templateRepo,
      assignmentRepo,
      makeSupabaseStub({
        runsRows: [
          { status: 'completed' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'cancelled' },
        ],
      }),
    );

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');
    expect(kpis.generations).toEqual({
      total: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
    });
  });
});
