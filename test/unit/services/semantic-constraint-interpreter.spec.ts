import { SemanticConstraintInterpreter } from '../../../src/domain/services/semantic-constraint-interpreter';
import { SEMANTIC_BLOCKED_ALL } from '../../../src/domain/types/scheduling-types';
import type { SemanticConstraint } from '../../../src/domain/types/scheduling-types';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';

function makeEmployee(id: string, name: string) {
  return { id, name, companyId: 'company-1' } as any;
}

function makeSlot(templateId: string, isoDate: string): VirtualShiftSlot {
  const start = new Date(`${isoDate}T08:00:00.000Z`);
  const end = new Date(`${isoDate}T16:00:00.000Z`);
  return VirtualShiftSlot.create({
    templateId,
    companyId: 'company-1',
    date: isoDate,
    startTime: start,
    endTime: end,
    templateName: templateId,
  });
}

function constraint(rule: string, weight = 3): SemanticConstraint {
  return { rule, weight };
}

describe('SemanticConstraintInterpreter', () => {
  const employees = [
    makeEmployee('emp-1', 'Ana García'),
    makeEmployee('emp-2', 'Mario López'),
    makeEmployee('emp-3', 'Laura Martínez'),
  ];

  // 2024-04-15 lunes, 04-16 martes, 04-17 miércoles, 04-20 sábado, 04-21 domingo
  const slotMon = makeSlot('t-mon', '2024-04-15');
  const slotTue = makeSlot('t-tue', '2024-04-16');
  const slotWed = makeSlot('t-wed', '2024-04-17');
  const slotSat = makeSlot('t-sat', '2024-04-20');
  const slotSun = makeSlot('t-sun', '2024-04-21');
  const slots = [slotMon, slotTue, slotWed, slotSat, slotSun];

  describe('sin constraints', () => {
    it('returns empty when no constraints', () => {
      expect(SemanticConstraintInterpreter.interpret([], employees, slots)).toEqual([]);
    });

    it('returns originals when no slots', () => {
      const cs = [constraint('nadie trabaja el 16 de abril')];
      expect(SemanticConstraintInterpreter.interpret(cs, employees, [])).toEqual(cs);
    });
  });

  describe('bloqueo total de slot (feriado / nadie trabaja)', () => {
    it('"feriado" blocks all employees on matching date', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('el 16 de abril es feriado', 3)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.length).toBeGreaterThan(0);
      blocked.forEach((c) => {
        expect(c.shiftId).toBe(slotTue.slotKey);
        expect(c.weight).toBe(3);
      });
    });

    it('"nadie trabaja" + date-of-month', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('el 15 de abril nadie trabaja', 3)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked[0].shiftId).toBe(slotMon.slotKey);
    });

    it('"cerrado" with ISO date', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('2024-04-17 cerrado por mantenimiento', 2)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].shiftId).toBe(slotWed.slotKey);
    });

    it('weekend block covers Saturday + Sunday slots', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('fin de semana nadie trabaja', 3)],
        employees,
        slots,
      );
      const keys = result
        .filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL)
        .map((c) => c.shiftId);
      expect(keys).toContain(slotSat.slotKey);
      expect(keys).toContain(slotSun.slotKey);
    });
  });

  describe('bloqueo por día de semana', () => {
    it('"los lunes" matches Monday slots', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('los lunes el local está cerrado', 3)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.some((c) => c.shiftId === slotMon.slotKey)).toBe(true);
    });
  });

  describe('bloqueo de empleado específico', () => {
    it('employee name + date', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('Ana García no puede trabajar el 15 de abril', 2)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === 'emp-1');
      expect(blocked[0].shiftId).toBe(slotMon.slotKey);
    });

    it('first-name match on weekday rule', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('Mario no trabaja los lunes', 2)],
        employees,
        slots,
      );
      expect(result.filter((c) => c.employeeId === 'emp-2').length).toBeGreaterThan(0);
    });

    it('employee block without date applies across all slots (shiftId undefined)', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('Laura Martínez está de baja indefinida', 3)],
        employees,
        slots,
      );
      const blocked = result.filter((c) => c.employeeId === 'emp-3');
      expect(blocked).toHaveLength(1);
      expect(blocked[0].shiftId).toBeUndefined();
    });
  });

  describe('constraint sin match', () => {
    it('returns untouched when nothing matches', () => {
      const cs = [constraint('se requiere actitud positiva en el trabajo', 1)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, slots);
      expect(result).toEqual(cs);
    });
  });

  describe('preserves weight', () => {
    it('keeps original weight on expanded constraints', () => {
      const result = SemanticConstraintInterpreter.interpret(
        [constraint('feriado el 16 de abril', 2)],
        employees,
        slots,
      );
      result
        .filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL)
        .forEach((c) => expect(c.weight).toBe(2));
    });
  });
});
