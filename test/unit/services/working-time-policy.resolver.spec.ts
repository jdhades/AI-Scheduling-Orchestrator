import { WorkingTimePolicyResolver } from '../../../src/domain/services/working-time-policy.resolver';

describe('WorkingTimePolicyResolver', () => {
  describe('resolve() — sin overrides', () => {
    it('retorna el fallback del sistema cuando todo es undefined', () => {
      const p = WorkingTimePolicyResolver.resolve({});
      expect(p.maxHoursPerDay).toBe(8);
      expect(p.maxHoursPerWeek).toBe(40);
    });

    it('trata null como undefined (heredar)', () => {
      const p = WorkingTimePolicyResolver.resolve({
        employee: { maxHoursPerDay: null, maxHoursPerWeek: null },
      });
      expect(p.maxHoursPerDay).toBe(8);
      expect(p.maxHoursPerWeek).toBe(40);
    });
  });

  describe('resolve() — jerarquía', () => {
    it('employee overrides tienen prioridad sobre department', () => {
      const p = WorkingTimePolicyResolver.resolve({
        employee: { maxHoursPerDay: 6 },
        department: { maxHoursPerDay: 12 },
      });
      expect(p.maxHoursPerDay).toBe(6);
    });

    it('department overrides tienen prioridad sobre company', () => {
      const p = WorkingTimePolicyResolver.resolve({
        department: { maxHoursPerDay: 10 },
        company: { maxHoursPerDay: 8 },
      });
      expect(p.maxHoursPerDay).toBe(10);
    });

    it('company overrides tienen prioridad sobre fallback', () => {
      const p = WorkingTimePolicyResolver.resolve({
        company: { maxHoursPerDay: 7 },
      });
      expect(p.maxHoursPerDay).toBe(7);
    });

    it('cada campo se resuelve independientemente', () => {
      const p = WorkingTimePolicyResolver.resolve({
        employee: { maxHoursPerDay: 6 },
        company: { maxHoursPerWeek: 30 },
      });
      expect(p.maxHoursPerDay).toBe(6); // employee
      expect(p.maxHoursPerWeek).toBe(30); // company
    });

    it('caso real: Ana jornada reducida 6h/día en empresa con defaults', () => {
      const p = WorkingTimePolicyResolver.resolve({
        employee: { maxHoursPerDay: 6 },
        company: { maxHoursPerDay: 8, maxHoursPerWeek: 40 },
      });
      expect(p.maxHoursPerDay).toBe(6); // employee gana
      expect(p.maxHoursPerWeek).toBe(40); // tenant
    });
  });
});
