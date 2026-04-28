import {
  WorkingTimePolicyVO,
  type WorkingTimePolicyOverrides,
} from '../value-objects/working-time-policy.vo';

/**
 * WorkingTimePolicyResolver — domain service.
 *
 * Resuelve la política de tiempo de trabajo efectiva para un empleado mediante
 * merge jerárquico: empleado → departamento → tenant → fallback del sistema.
 *
 * Cualquier campo null/undefined en un nivel se hereda del siguiente.
 */
export class WorkingTimePolicyResolver {
  /** Fallback del sistema cuando ningún nivel define el valor. */
  static readonly SYSTEM_FALLBACK = {
    maxHoursPerDay: 8,
    maxHoursPerWeek: 40,
  } as const;

  static resolve(params: {
    employee?: WorkingTimePolicyOverrides | null;
    department?: WorkingTimePolicyOverrides | null;
    company?: WorkingTimePolicyOverrides | null;
  }): WorkingTimePolicyVO {
    const pick = <K extends keyof typeof WorkingTimePolicyResolver.SYSTEM_FALLBACK>(
      key: K,
    ): number => {
      const e = params.employee?.[key];
      if (e != null) return e;
      const d = params.department?.[key];
      if (d != null) return d;
      const c = params.company?.[key];
      if (c != null) return c;
      return WorkingTimePolicyResolver.SYSTEM_FALLBACK[key];
    };

    return WorkingTimePolicyVO.create({
      maxHoursPerDay: pick('maxHoursPerDay'),
      maxHoursPerWeek: pick('maxHoursPerWeek'),
    });
  }
}
