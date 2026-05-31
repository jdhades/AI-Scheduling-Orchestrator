import { CoverageService } from '../../../../src/domain/services/coverage.service';
import { ShiftTemplate } from '../../../../src/domain/aggregates/shift-template.aggregate';
import { ShiftAssignment } from '../../../../src/domain/aggregates/shift-assignment.aggregate';
import { DemandWeight } from '../../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../../src/domain/value-objects/undesirable-weight.vo';
import type { IShiftAssignmentRepository } from '../../../../src/domain/repositories/shift-assignment.repository';
import type { IShiftTemplateRepository } from '../../../../src/domain/repositories/shift-template.repository';

const COMPANY = 'co-1';

function tpl(opts: {
  id: string;
  dayOfWeek: number | null;
  start: string;
  end: string;
  required: number | null;
  active?: boolean;
}): ShiftTemplate {
  return ShiftTemplate.create({
    id: opts.id,
    name: opts.id,
    companyId: COMPANY,
    dayOfWeek: opts.dayOfWeek as number,
    startTime: opts.start,
    endTime: opts.end,
    requiredSkillId: null,
    requiredSkillLevel: 'medium' as any,
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.medium(),
    undesirableWeight: UndesirableWeight.create(0),
    requiredEmployees: opts.required ?? undefined,
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

describe('CoverageService', () => {
  let service: CoverageService;
  let templateRepo: jest.Mocked<IShiftTemplateRepository>;
  let assignmentRepo: jest.Mocked<IShiftAssignmentRepository>;

  beforeEach(() => {
    templateRepo = { findAllByCompany: jest.fn() } as any;
    assignmentRepo = { findByCompanyAndDateRange: jest.fn() } as any;
    service = new CoverageService(assignmentRepo, templateRepo);
  });

  it('devuelve 7 días con celdas para cada hora del rango (08–21)', async () => {
    templateRepo.findAllByCompany.mockResolvedValue([]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([]);

    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-20',
      'monday',
    );

    expect(report.weekStart).toBe('2026-04-20');
    expect(report.days).toHaveLength(7);
    expect(report.hours).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(report.days[0].cells).toHaveLength(14);
  });

  it('suma required de templates que cubren cada hora', async () => {
    // Template lunes 09–13 (4h) con required=3
    templateRepo.findAllByCompany.mockResolvedValue([
      tpl({
        id: 't1',
        dayOfWeek: 1,
        start: '09:00',
        end: '13:00',
        required: 3,
      }),
    ]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([]);

    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-20',
      'monday',
    );
    const monday = report.days.find((d) => d.dayOfWeek === 1)!;

    // El rango se deriva del template (9-13) — horas fuera no aparecen.
    expect(monday.cells.find((c) => c.hour === 8)).toBeUndefined();
    expect(monday.cells.find((c) => c.hour === 9)!.required).toBe(3);
    expect(monday.cells.find((c) => c.hour === 12)!.required).toBe(3);
    expect(monday.cells.find((c) => c.hour === 13)).toBeUndefined(); // exclusive end → no celda
  });

  it('cuenta assignments del template como asignados en sus horas', async () => {
    templateRepo.findAllByCompany.mockResolvedValue([
      tpl({
        id: 't1',
        dayOfWeek: 1,
        start: '09:00',
        end: '13:00',
        required: 3,
      }),
    ]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([
      assignment('t1', '2026-04-20', 'emp-1'),
      assignment('t1', '2026-04-20', 'emp-2'),
    ]);

    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-20',
      'monday',
    );
    const monday = report.days.find((d) => d.dayOfWeek === 1)!;

    expect(monday.cells.find((c) => c.hour === 10)!.assigned).toBe(2);
    expect(monday.cells.find((c) => c.hour === 10)!.required).toBe(3);
    expect(monday.cells.find((c) => c.hour === 13)).toBeUndefined(); // fuera del rango template
  });

  it('templates inactivos se ignoran', async () => {
    templateRepo.findAllByCompany.mockResolvedValue([
      tpl({
        id: 't1',
        dayOfWeek: 1,
        start: '09:00',
        end: '13:00',
        required: 3,
        active: false,
      }),
    ]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([]);

    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-20',
      'monday',
    );
    const monday = report.days.find((d) => d.dayOfWeek === 1)!;
    expect(monday.cells.every((c) => c.required === 0)).toBe(true);
  });

  it('weekStartsOn=sunday: el primer día es domingo', async () => {
    templateRepo.findAllByCompany.mockResolvedValue([]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([]);

    // Pasamos un viernes; el helper resuelve al domingo anterior.
    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-24',
      'sunday',
    );
    expect(report.weekStart).toBe('2026-04-19'); // domingo
    expect(report.days[0].dayOfWeek).toBe(0);
  });

  it('turnos overnight no se reportan (v1)', async () => {
    templateRepo.findAllByCompany.mockResolvedValue([
      tpl({
        id: 't-night',
        dayOfWeek: 1,
        start: '22:00',
        end: '06:00',
        required: 2,
      }),
    ]);
    assignmentRepo.findByCompanyAndDateRange.mockResolvedValue([]);

    const report = await service.getWeekCoverage(
      COMPANY,
      '2026-04-20',
      'monday',
    );
    const monday = report.days.find((d) => d.dayOfWeek === 1)!;
    // Endpoint solo cubre 08-21; ninguna celda debería tener required > 0.
    expect(monday.cells.every((c) => c.required === 0)).toBe(true);
  });
});
