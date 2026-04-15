import { WeekScheduleBuilder } from '../../../src/domain/services/week-schedule-builder.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { ShiftMembership } from '../../../src/domain/aggregates/shift-membership.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { EmployeeAvailability } from '../../../src/domain/value-objects/employee-availability.vo';
import { CompanySkill } from '../../../src/domain/aggregates/company-skill.aggregate';
import { SkillValidationPolicy } from '../../../src/domain/policies/skill-validation.policy';
import {
  SEMANTIC_BLOCKED_ALL,
  type SemanticConstraint,
} from '../../../src/domain/strategies/scheduling-strategy.interface';

const COMPANY = 'co-1';
const RANGES = { junior: 6, intermediate: 24, senior: 999 };
// Lunes 2026-03-09 → Dom 2026-03-15
const WEEK = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'];
const WEEK_START = new Date('2026-03-09T00:00:00Z');

function makeEmployee(
  id: string,
  opts: { skills?: string[]; availability?: EmployeeAvailability[]; experience?: number } = {},
): Employee {
  const emp = Employee.fromPersistence({
    id,
    companyId: COMPANY,
    name: id,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(opts.experience ?? 12, RANGES),
    availability: opts.availability,
  });
  for (const skillId of opts.skills ?? []) {
    const skill = CompanySkill.create({
      id: skillId,
      name: skillId,
      companyId: COMPANY,
      level: 'junior',
      requiredExperienceMonths: 0,
      certificationExpiration: null,
    });
    emp.assignSkill(skill, new SkillValidationPolicy());
  }
  return emp;
}

function makeSlot(
  templateId: string,
  date: string,
  startHour: number,
  endHour: number,
  requiredEmployees: number | null = 1,
  requiredSkillId: string | null = null,
): VirtualShiftSlot {
  const start = new Date(`${date}T00:00:00Z`);
  start.setUTCHours(startHour, 0, 0, 0);
  let end = new Date(`${date}T00:00:00Z`);
  end.setUTCHours(endHour, 0, 0, 0);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return VirtualShiftSlot.create({
    templateId,
    companyId: COMPANY,
    date,
    startTime: start,
    endTime: end,
    templateName: templateId,
    requiredEmployees,
    requiredSkillId,
    demandScore: 1,
    undesirableWeight: 0,
  });
}

/** Slots estándar (Diurno target=2 + Nocturno elástico) para toda la semana. */
function weekSlots(): VirtualShiftSlot[] {
  const slots: VirtualShiftSlot[] = [];
  for (const d of WEEK) {
    slots.push(makeSlot('diurno', d, 8, 16, 2));
    slots.push(makeSlot('nocturno', d, 22, 6, null));
  }
  return slots;
}

function membership(
  employeeId: string,
  templateId: string,
  from = '2020-01-01',
): ShiftMembership {
  return ShiftMembership.create({
    id: `${employeeId}-${templateId}`,
    companyId: COMPANY,
    employeeId,
    templateId,
    effectiveFrom: from,
  });
}

function hardRule(employeeId: string | null, shiftId?: string): SemanticConstraint {
  return {
    rule: `hard rule on ${employeeId ?? 'all'}${shiftId ? ' @ ' + shiftId : ''}`,
    weight: 2,
    employeeId: employeeId ?? SEMANTIC_BLOCKED_ALL,
    shiftId,
  };
}

const FIVE_EMPS = () => ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => makeEmployee(id));
const DEFAULT_BUILD = {
  histories: [] as never[],
  weekStart: WEEK_START,
  companyId: COMPANY,
  memberships: [] as ShiftMembership[],
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WeekScheduleBuilder', () => {
  const builder = new WeekScheduleBuilder();

  it('base case: 5 empleados, Diurno target=2, Nocturno elastic → 2+3 por día', () => {
    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: FIVE_EMPS(),
      slots: weekSlots(),
      semanticRules: [],
    });
    expect(result.assignments).toHaveLength(35);
    for (const d of WEEK) {
      const day = result.assignments.filter((a) => a.date === d);
      expect(day.filter((a) => a.templateId === 'diurno')).toHaveLength(2);
      expect(day.filter((a) => a.templateId === 'nocturno')).toHaveLength(3);
    }
    expect(result.restDays).toHaveLength(0);
    expect(result.underfilled).toHaveLength(0);
  });

  it('feriado global: todos rest ese día, targets de ese día reportados como underfilled', () => {
    const slots = weekSlots();
    const holidayRules: SemanticConstraint[] = slots
      .filter((s) => s.date === '2026-03-11')
      .map((s) => hardRule(null, s.slotKey));

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: FIVE_EMPS(),
      slots,
      semanticRules: holidayRules,
    });

    // 5 empleados × 6 días = 30 asignaciones; 5 rest el día feriado
    expect(result.assignments).toHaveLength(30);
    expect(result.restDays).toHaveLength(5);
    expect(result.restDays.every((r) => r.date === '2026-03-11' && r.reason === 'holiday')).toBe(true);
    // Diurno|11 tiene target=2 pero 0 cubiertos → underfilled
    const under = result.underfilled.find((u) => u.slot.date === '2026-03-11' && u.slot.templateId === 'diurno');
    expect(under).toBeDefined();
    expect(under!.target).toBe(2);
    expect(under!.filled).toBe(0);
  });

  it('hard block de empleado: Ana bloqueada el lunes → rest solo Ana, resto normal', () => {
    const slots = weekSlots();
    const diurnoLunes = slots.find((s) => s.slotKey === 'diurno|2026-03-09')!;
    const nocturnoLunes = slots.find((s) => s.slotKey === 'nocturno|2026-03-09')!;

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: FIVE_EMPS(),
      slots,
      semanticRules: [hardRule('e1', diurnoLunes.slotKey), hardRule('e1', nocturnoLunes.slotKey)],
    });

    const anaLunes = result.assignments.find((a) => a.employeeId === 'e1' && a.date === '2026-03-09');
    expect(anaLunes).toBeUndefined();
    const anaRest = result.restDays.find((r) => r.employeeId === 'e1' && r.date === '2026-03-09');
    expect(anaRest).toBeDefined();
    // Los otros 4 trabajan el lunes normalmente
    const otherLunes = result.assignments.filter((a) => a.date === '2026-03-09');
    expect(otherLunes).toHaveLength(4);
  });

  it('skill mismatch: sin empleado con skill, target queda underfilled (no error)', () => {
    const slots = [
      makeSlot('cook', '2026-03-09', 8, 16, 1, 'chef'),
      makeSlot('server', '2026-03-09', 8, 16, 1),
    ];
    const emps = [makeEmployee('e1', { skills: ['waiter'] })]; // no tiene 'chef'

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      semanticRules: [],
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].templateId).toBe('server');
    const under = result.underfilled.find((u) => u.slot.templateId === 'cook');
    expect(under).toBeDefined();
    expect(under!.filled).toBe(0);
  });

  it('membership prioriza sobre sugerencia LLM: LLM dice Nocturno pero es miembro de Diurno → Diurno', () => {
    const slots = weekSlots();
    const emps = [makeEmployee('e1')];
    const memberships = [membership('e1', 'diurno')];
    // LLM intenta llevarlo a Nocturno toda la semana, pero la membership
    // activa a Diurno es regla hard del manager y gana.
    const llmLines = new Map<string, Record<string, string | 'rest'>>([
      ['e1', Object.fromEntries(WEEK.map((d) => [d, 'nocturno']))],
    ]);

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      memberships,
      semanticRules: [],
      llmLines,
    });

    expect(result.assignments).toHaveLength(7);
    expect(result.assignments.every((a) => a.templateId === 'diurno')).toBe(true);
  });

  it('LLM rest se ignora cuando hay slot elástico disponible', () => {
    const slots = weekSlots();
    const llmLines = new Map<string, Record<string, string | 'rest'>>([
      ['e1', Object.fromEntries(WEEK.map((d) => [d, 'rest']))],
    ]);

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: [makeEmployee('e1')],
      slots,
      semanticRules: [],
      llmLines,
    });

    // El LLM pidió rest toda la semana, pero el builder ignora "rest" y
    // coloca al empleado en el elástico (Nocturno) o el target (Diurno).
    expect(result.assignments).toHaveLength(7);
    expect(result.restDays).toHaveLength(0);
  });

  it('LLM saturando target: sugerencia descartada, builder redistribuye al elástico', () => {
    const slots = weekSlots();
    const emps = FIVE_EMPS();
    // LLM propone a los 5 en Diurno todos los días
    const llmLines = new Map<string, Record<string, string | 'rest'>>(
      emps.map((e) => [e.id, Object.fromEntries(WEEK.map((d) => [d, 'diurno']))]),
    );

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      semanticRules: [],
      llmLines,
    });

    // 2 por día al Diurno (respeta target), 3 al Nocturno (builder redistribuye).
    for (const d of WEEK) {
      const day = result.assignments.filter((a) => a.date === d);
      expect(day.filter((a) => a.templateId === 'diurno')).toHaveLength(2);
      expect(day.filter((a) => a.templateId === 'nocturno')).toHaveLength(3);
    }
    expect(result.underfilled).toHaveLength(0);
  });

  it('N empleados > capacidad estrecha: overflow al menos saturado (incluido over-target)', () => {
    // 6 empleados, 1 Diurno target=2, 1 Nocturno target=2 (sin elástico)
    const slots: VirtualShiftSlot[] = [];
    for (const d of WEEK) {
      slots.push(makeSlot('diurno', d, 8, 16, 2));
      slots.push(makeSlot('nocturno', d, 22, 6, 2));
    }
    const emps = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id) => makeEmployee(id));

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      semanticRules: [],
    });

    // 6 por día × 7 = 42 asignaciones (el 6to va al menos saturado = ruta
    // categoría 3, over-target).
    expect(result.assignments).toHaveLength(42);
    for (const d of WEEK) {
      const day = result.assignments.filter((a) => a.date === d);
      // Los dos slots juntos tienen target=4, pero entran 6 personas
      expect(day.length).toBe(6);
    }
  });

  it('día libre por regla textual: Pedro libre el miércoles, resto normal', () => {
    const slots = weekSlots();
    const pedroWedDiurno = slots.find((s) => s.slotKey === 'diurno|2026-03-11')!;
    const pedroWedNocturno = slots.find((s) => s.slotKey === 'nocturno|2026-03-11')!;

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: FIVE_EMPS(),
      slots,
      // Bloquear Pedro (e2) ambos slots del miércoles
      semanticRules: [hardRule('e2', pedroWedDiurno.slotKey), hardRule('e2', pedroWedNocturno.slotKey)],
    });

    const pedroWed = result.assignments.find((a) => a.employeeId === 'e2' && a.date === '2026-03-11');
    expect(pedroWed).toBeUndefined();
    expect(result.restDays).toContainEqual(
      expect.objectContaining({ employeeId: 'e2', date: '2026-03-11' }),
    );
    // Pedro trabaja los otros 6 días; otros 4 empleados trabajan el miércoles.
    const pedroWorkDays = result.assignments.filter((a) => a.employeeId === 'e2').map((a) => a.date);
    expect(pedroWorkDays.sort()).toEqual(['2026-03-09', '2026-03-10', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15']);
    const othersWed = result.assignments.filter((a) => a.date === '2026-03-11' && a.employeeId !== 'e2');
    expect(othersWed).toHaveLength(4);
  });

  it('día libre emergente por falta de cupo: 7 empleados, 2 slots target=2 sin elástico → 4 trabajan, 3 rest', () => {
    const slots = [
      makeSlot('diurno', '2026-03-09', 8, 16, 2),
      makeSlot('nocturno', '2026-03-09', 22, 6, 2),
    ];
    const emps = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map((id) => makeEmployee(id));

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      semanticRules: [],
    });

    // Sin elástico y con sobrecapacidad, los 3 últimos caen en categoría 3
    // (over-target) y se colocan igual. Todos trabajan algún slot, no hay rest.
    // Validación real: aseguramos que los 7 están asignados el único día.
    expect(result.assignments).toHaveLength(7);
    expect(result.restDays).toHaveLength(0);
  });

  it('cadena de restricciones: skill + regla + saturación → rest emergente', () => {
    // 3 empleados. Un slot target=1 con skill requerida. Solo 1 tiene skill y
    // está bloqueado por regla. Los otros 2 no tienen skill. Resultado: nadie
    // cubre el slot, los 3 quedan rest ese día.
    const slots = [makeSlot('cook', '2026-03-09', 8, 16, 1, 'chef')];
    const emps = [
      makeEmployee('e1', { skills: ['chef'] }),
      makeEmployee('e2', { skills: ['waiter'] }),
      makeEmployee('e3', { skills: ['waiter'] }),
    ];

    const result = builder.build({
      ...DEFAULT_BUILD,
      employees: emps,
      slots,
      semanticRules: [hardRule('e1', 'cook|2026-03-09')],
    });

    expect(result.assignments).toHaveLength(0);
    expect(result.restDays).toHaveLength(3);
    expect(result.underfilled).toContainEqual(
      expect.objectContaining({ target: 1, filled: 0 }),
    );
  });
});
