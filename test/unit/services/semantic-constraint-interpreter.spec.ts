import { SemanticConstraintInterpreter } from '../../../src/domain/services/semantic-constraint-interpreter';
import { SEMANTIC_BLOCKED_ALL } from '../../../src/domain/strategies/scheduling-strategy.interface';
import type { SemanticConstraint } from '../../../src/domain/strategies/scheduling-strategy.interface';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEmployee(id: string, name: string) {
  return { id, name, companyId: 'company-1' } as any;
}

function makeShift(id: string, isoDate: string) {
  return { id, startTime: new Date(`${isoDate}T08:00:00.000Z`) } as any;
}

function constraint(rule: string, weight = 3): SemanticConstraint {
  return { rule, weight };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SemanticConstraintInterpreter', () => {
  const employees = [
    makeEmployee('emp-1', 'Ana García'),
    makeEmployee('emp-2', 'Mario López'),
    makeEmployee('emp-3', 'Laura Martínez'),
  ];

  // Shifts: lunes=14 abril, martes=15 abril, miércoles=16 abril (feriado)
  const shifts = [
    makeShift('shift-mon', '2024-04-15'), // lunes
    makeShift('shift-tue', '2024-04-16'), // martes
    makeShift('shift-wed', '2024-04-17'), // miércoles
    makeShift('shift-sat', '2024-04-20'), // sábado
    makeShift('shift-sun', '2024-04-21'), // domingo
  ];

  describe('sin constraints', () => {
    it('devuelve array vacío si no hay constraints', () => {
      expect(SemanticConstraintInterpreter.interpret([], employees, shifts)).toEqual([]);
    });

    it('devuelve constraints originales si no hay shifts', () => {
      const cs = [constraint('nadie trabaja el 16 de abril')];
      expect(SemanticConstraintInterpreter.interpret(cs, employees, [])).toEqual(cs);
    });
  });

  describe('bloqueo total de turno (feriado / nadie trabaja)', () => {
    it('detecta "feriado" y bloquea todos los empleados en los turnos del día', () => {
      const cs = [constraint('el 16 de abril es feriado', 3)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      // Debe generar una constraint por cada turno del 16 de abril
      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.length).toBeGreaterThan(0);
      blocked.forEach((c) => {
        expect(c.shiftId).toBe('shift-tue'); // 2024-04-16 es martes (shift-tue)
        expect(c.weight).toBe(3);
      });
    });

    it('detecta "nadie trabaja" y bloquea todos en el turno del día', () => {
      const cs = [constraint('el 15 de abril nadie trabaja', 3)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0].shiftId).toBe('shift-mon');
    });

    it('detecta "cerrado" con fecha ISO', () => {
      const cs = [constraint('2024-04-17 cerrado por mantenimiento', 2)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.length).toBe(1);
      expect(blocked[0].shiftId).toBe('shift-wed');
    });

    it('bloquea fin de semana completo', () => {
      const cs = [constraint('fin de semana nadie trabaja', 3)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blockedShiftIds = result
        .filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL)
        .map((c) => c.shiftId);

      expect(blockedShiftIds).toContain('shift-sat');
      expect(blockedShiftIds).toContain('shift-sun');
    });
  });

  describe('bloqueo por día de semana', () => {
    it('detecta "los lunes" y bloquea todos los turnos del lunes', () => {
      const cs = [constraint('los lunes el local está cerrado', 3)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL);
      expect(blocked.some((c) => c.shiftId === 'shift-mon')).toBe(true);
    });
  });

  describe('bloqueo de empleado específico', () => {
    it('detecta el nombre del empleado y bloquea en turno específico', () => {
      const cs = [constraint('Ana García no puede trabajar el 15 de abril', 2)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === 'emp-1');
      expect(blocked.length).toBeGreaterThan(0);
      expect(blocked[0].shiftId).toBe('shift-mon'); // 15 abril = lunes
    });

    it('detecta primer nombre (sin apellido) del empleado', () => {
      const cs = [constraint('Mario no trabaja los lunes', 2)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === 'emp-2');
      expect(blocked.length).toBeGreaterThan(0);
    });

    it('bloquea empleado en todos los turnos si no hay fecha específica', () => {
      const cs = [constraint('Laura Martínez está de baja indefinida', 3)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      const blocked = result.filter((c) => c.employeeId === 'emp-3');
      expect(blocked.length).toBe(1);
      expect(blocked[0].shiftId).toBeUndefined(); // sin shiftId = todos los turnos
    });
  });

  describe('constraint sin match', () => {
    it('devuelve la constraint original si no hay entidades reconocibles', () => {
      const cs = [constraint('se requiere actitud positiva en el trabajo', 1)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(cs[0]); // sin modificar
    });
  });

  describe('preserva weight en constraints expandidas', () => {
    it('mantiene el weight de la constraint original al expandir', () => {
      const cs = [constraint('feriado el 16 de abril', 2)];
      const result = SemanticConstraintInterpreter.interpret(cs, employees, shifts);

      result
        .filter((c) => c.employeeId === SEMANTIC_BLOCKED_ALL)
        .forEach((c) => expect(c.weight).toBe(2));
    });
  });
});
