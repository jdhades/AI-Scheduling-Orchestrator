import { MinRestHoursBetweenShiftsInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-hours-between-shifts.interpreter';

describe('MinRestHoursBetweenShiftsInterpreter', () => {
  let interpreter: MinRestHoursBetweenShiftsInterpreter;

  beforeEach(() => {
    interpreter = new MinRestHoursBetweenShiftsInterpreter();
  });

  describe('matches()', () => {
    it.each([
      'Cada empleado descansa al menos 11 horas entre turnos consecutivos',
      'descanso de 12 horas entre turnos',
      'each employee must rest 11 hours between shifts',
      'descanso de once horas entre cada turno',
    ])('matches "%s"', (text) => {
      expect(interpreter.matches(text)).toBe(true);
    });

    it.each([
      'Pablo no trabaja los lunes', // case-particular
      'Cada empleado tiene 2 días libres por semana', // otro interpreter
      'rest 11 hours per week', // weekly, no entre turnos
    ])('does NOT match "%s"', (text) => {
      expect(interpreter.matches(text)).toBe(false);
    });
  });

  describe('extractParams()', () => {
    it('extrae 11 desde dígitos', async () => {
      const params = await interpreter.extractParams(
        'cada empleado descansa al menos 11 horas entre turnos',
      );
      expect(params).toEqual({ hours: 11 });
    });

    it('extrae 12 desde palabras (doce)', async () => {
      const params = await interpreter.extractParams(
        'descanso de doce horas entre turnos consecutivos',
      );
      expect(params).toEqual({ hours: 12 });
    });

    it('cae al default 11 si no encuentra número', async () => {
      const params = await interpreter.extractParams(
        'descanso entre turnos',
      );
      expect(params).toEqual({ hours: 11 });
    });
  });

  describe('apply()', () => {
    const employeeId = 'emp-1';
    const shift = (date: string, startH: number, durationH = 8) => ({
      employeeId,
      startTime: new Date(`${date}T${String(startH).padStart(2, '0')}:00:00Z`),
      endTime: new Date(
        `${date}T${String(startH + durationH).padStart(2, '0')}:00:00Z`,
      ),
    });

    it('no viola cuando el gap entre turnos es ≥ minHours', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            // Lunes 8-16, martes 8-16 → gap = 16h (≥ 11h)
            shift('2026-04-20', 8),
            shift('2026-04-21', 8),
          ],
        },
        { hours: 11 },
      );
      expect(violations).toHaveLength(0);
    });

    it('detecta violación cuando gap < minHours', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20', 14, 8), // 14 → 22
            shift('2026-04-21', 6, 8), // 06 → 14, gap = 8h (< 11h)
          ],
        },
        { hours: 11 },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].employeeId).toBe(employeeId);
      expect(violations[0].message).toMatch(/below the minimum of 11/);
      // 22:00 → 06:00 = 8h
      expect(violations[0].message).toMatch(/8\.0 hours/);
    });

    it('agrupa por empleado: shifts de empleados distintos no se cruzan', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            {
              employeeId: 'a',
              startTime: new Date('2026-04-20T14:00:00Z'),
              endTime: new Date('2026-04-20T22:00:00Z'),
            },
            {
              employeeId: 'b',
              // gap de 1h con el shift de 'a' — irrelevante porque
              // pertenece a otro empleado
              startTime: new Date('2026-04-20T23:00:00Z'),
              endTime: new Date('2026-04-21T07:00:00Z'),
            },
          ],
        },
        { hours: 11 },
      );
      expect(violations).toHaveLength(0);
    });

    it('múltiples shifts ordenados por startTime aunque vengan desordenados', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-22', 6, 8),
            shift('2026-04-20', 14, 8), // termina 22:00 lunes
            shift('2026-04-21', 6, 8), // empieza 06:00 martes → gap 8h
          ],
        },
        { hours: 11 },
      );
      expect(violations).toHaveLength(1);
    });
  });

  describe('format()', () => {
    it('renderiza con plural', () => {
      expect(interpreter.format({ hours: 11 })).toBe(
        'Each employee must rest at least 11 hours between consecutive shifts.',
      );
    });

    it('renderiza con singular', () => {
      expect(interpreter.format({ hours: 1 })).toBe(
        'Each employee must rest at least 1 hour between consecutive shifts.',
      );
    });
  });
});
