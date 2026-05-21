import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';

describe('MinRestDaysPerWeekInterpreter', () => {
  let interpreter: MinRestDaysPerWeekInterpreter;

  beforeEach(() => {
    interpreter = new MinRestDaysPerWeekInterpreter();
  });

  describe('matches()', () => {
    it.each([
      'Cada empleado descansa al menos 2 días por semana',
      'los empleados deben tener 2 días libres por semana',
      'each employee gets 2 rest days per week',
      'cada uno tiene dos días libres semanal',
    ])('matches "%s"', (text) => {
      expect(interpreter.matches(text)).toBe(true);
    });

    it.each([
      'Pablo no trabaja los lunes', // case-particular, no es policy de count
      'descanso entre turnos de 11 horas', // distinto interpreter
      'feriado no cuenta como día libre', // ambigua, no especifica count semanal
    ])('does NOT match "%s"', (text) => {
      expect(interpreter.matches(text)).toBe(false);
    });
  });

  describe('extractParams()', () => {
    it('extrae días desde dígitos', async () => {
      const params = await interpreter.extractParams(
        'cada empleado tiene 3 días libres por semana',
      );
      expect(params).toEqual({ days: 3, holidayCounts: true });
    });

    it('extrae días desde palabras', async () => {
      const params = await interpreter.extractParams(
        'cada empleado tiene dos días libres por semana',
      );
      expect(params).toEqual({ days: 2, holidayCounts: true });
    });

    it('detecta "aparte del feriado" → holidayCounts=false', async () => {
      const params = await interpreter.extractParams(
        '2 días de descanso para el empleado aparte del feriado por semana',
      );
      expect(params).toEqual({ days: 2, holidayCounts: false });
    });

    it('detecta "holidays do not count" → holidayCounts=false', async () => {
      const params = await interpreter.extractParams(
        '2 rest days per week, holidays do not count',
      );
      expect(params).toEqual({ days: 2, holidayCounts: false });
    });
  });

  describe('apply()', () => {
    const employeeId = 'emp-1';
    // Lunes 2026-04-20 a domingo 2026-04-26 = ISO week 2026-W17
    const shift = (dateStr: string, hour = 9) => ({
      employeeId,
      startTime: new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`),
      endTime: new Date(`${dateStr}T${String(hour + 8).padStart(2, '0')}:00:00Z`),
    });

    it('no hay violación si trabaja menos días que (7 - mínimo)', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20'),
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
            shift('2026-04-24'),
            // 2 días libres (sáb + dom)
          ],
        },
        { days: 2, holidayCounts: true },
      );
      expect(violations).toHaveLength(0);
    });

    it('detecta violación si trabaja todos los días', async () => {
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20'),
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
            shift('2026-04-24'),
            shift('2026-04-25'),
            shift('2026-04-26'),
          ],
        },
        { days: 2, holidayCounts: true },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].employeeId).toBe(employeeId);
      expect(violations[0].scope).toBe('2026-04-20');
      expect(violations[0].message).toMatch(/below the minimum of 2/);
    });

    it('cuando holidayCounts=false, los feriados no se cuentan como descanso', async () => {
      // Trabaja 5 días (lun-vie). Sábado feriado, domingo libre.
      // Si holidayCounts=true: 2 rest days (sáb+dom) → cumple.
      // Si holidayCounts=false: 1 rest day (solo dom) → viola.
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20'),
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
            shift('2026-04-24'),
          ],
          holidayDates: new Set(['2026-04-25']), // sábado feriado
        },
        { days: 2, holidayCounts: false },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].message).toMatch(/holidays excluded/);
    });

    it('agrupa por semana del tenant cuando weekStartsOn=sunday (domingo es el anchor)', async () => {
      // Tenant Sunday-start: la "semana 1" es dom 2026-04-19 → sáb 2026-04-25.
      // 7 turnos consecutivos del dom 19 al sáb 25 = 0 rest days → viola con min=2.
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-19'), // dom — anchor
            shift('2026-04-20'),
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
            shift('2026-04-24'),
            shift('2026-04-25'), // sáb — último día de la semana
          ],
          weekStartsOn: 'sunday',
        },
        { days: 2, holidayCounts: true },
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].scope).toBe('2026-04-19'); // anchor de la semana del tenant
    });

    it('cuando weekStartsOn=sunday, lun-dom NO es una sola semana (cruza boundary)', async () => {
      // Mismo set de fechas que el test "trabaja todos los días" (lun-dom)
      // pero con tenant Sunday-start: el domingo 2026-04-26 cae en la
      // SIGUIENTE semana del tenant, no en la misma que el lunes-sábado.
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20'), // lun → semana 04-19
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
            shift('2026-04-24'),
            shift('2026-04-25'), // sáb → semana 04-19
            shift('2026-04-26'), // dom → semana 04-26 (siguiente)
          ],
          weekStartsOn: 'sunday',
        },
        { days: 2, holidayCounts: true },
      );
      // Semana 04-19 (dom 19): 6 trabajados, 1 rest (dom 19) → viola con min=2.
      // Semana 04-26 (dom 26): 1 trabajado, 6 rest → no viola.
      expect(violations).toHaveLength(1);
      expect(violations[0].scope).toBe('2026-04-19');
    });

    it('múltiples shifts en el mismo día cuentan como un solo día trabajado', async () => {
      // Lun 2 turnos + mar-jue trabaja → 4 días distintos = 3 rest days. OK con mínimo 2.
      const violations = await interpreter.apply(
        {
          shifts: [
            shift('2026-04-20', 9),
            shift('2026-04-20', 14),
            shift('2026-04-21'),
            shift('2026-04-22'),
            shift('2026-04-23'),
          ],
        },
        { days: 2, holidayCounts: true },
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('format()', () => {
    it('renderiza con feriados que cuentan', () => {
      expect(interpreter.format({ days: 2, holidayCounts: true })).toBe(
        'Each employee must have at least 2 rest days per week.',
      );
    });

    it('renderiza con feriados excluidos', () => {
      expect(interpreter.format({ days: 1, holidayCounts: false })).toBe(
        'Each employee must have at least 1 rest day per week (holidays do not count as rest days).',
      );
    });
  });
});
