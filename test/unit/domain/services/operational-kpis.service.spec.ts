import { OperationalKpisService } from '../../../../src/domain/services/operational-kpis.service';
import type { CoverageService } from '../../../../src/domain/services/coverage.service';
import type { IFairnessHistoryRepository } from '../../../../src/domain/repositories/fairness-history.repository';
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

describe('OperationalKpisService', () => {
  let service: OperationalKpisService;
  let coverageService: jest.Mocked<CoverageService>;
  let fairnessRepo: jest.Mocked<IFairnessHistoryRepository>;

  beforeEach(() => {
    coverageService = { getWeekCoverage: jest.fn() } as any;
    fairnessRepo = { findByWeek: jest.fn().mockResolvedValue([]) } as any;
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
    service = new OperationalKpisService(coverageService, fairnessRepo, makeSupabaseStub({}));

    const kpis = await service.getKpis(COMPANY, ['2026-04-20'], 'monday');

    expect(kpis.coverage.totalRequiredCells).toBe(3);
    // (100 + 50 + 0) / 3 = 50
    expect(kpis.coverage.avgPercent).toBe(50);
    // unfilledShifts = asientos faltantes (required - assigned), no
    // "celdas con 0". Acá: 0 + 2 + 1 = 3 asientos faltan en total.
    expect(kpis.coverage.unfilledShifts).toBe(3);
  });

  it('coverage: agrega sobre múltiples weekStarts', async () => {
    coverageService.getWeekCoverage.mockResolvedValueOnce(
      makeCoverageReport({
        weekStart: '2026-04-20',
        cells: [{ required: 2, assigned: 2 }], // 100%
      }),
    );
    coverageService.getWeekCoverage.mockResolvedValueOnce(
      makeCoverageReport({
        weekStart: '2026-04-27',
        cells: [{ required: 2, assigned: 0 }], // 0% + 2 asientos faltantes
      }),
    );
    service = new OperationalKpisService(coverageService, fairnessRepo, makeSupabaseStub({}));

    const kpis = await service.getKpis(COMPANY, ['2026-04-20', '2026-04-27'], 'monday');

    expect(kpis.coverage.totalRequiredCells).toBe(2);
    expect(kpis.coverage.avgPercent).toBe(50);
    expect(kpis.coverage.unfilledShifts).toBe(2);
  });

  it('coverage: avgPercent=null cuando no hay celdas con required', async () => {
    coverageService.getWeekCoverage.mockResolvedValue(
      makeCoverageReport({
        weekStart: '2026-04-20',
        cells: [{ required: 0, assigned: 0 }],
      }),
    );
    service = new OperationalKpisService(coverageService, fairnessRepo, makeSupabaseStub({}));

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
    service = new OperationalKpisService(coverageService, fairnessRepo, makeSupabaseStub({}));

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
