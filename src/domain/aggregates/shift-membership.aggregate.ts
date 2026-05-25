/**
 * ShiftMembership — Domain Aggregate
 *
 * Expresa que un empleado pertenece a un shift_template durante un rango de
 * fechas. Es el source of truth para "quién trabaja qué turno" en el modelo
 * de membresías.
 *
 * Reglas invariantes:
 * - effectiveUntil (si existe) debe ser >= effectiveFrom
 * - fechas en formato ISO "YYYY-MM-DD"
 */
export class ShiftMembership {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly templateId: string,
    public readonly effectiveFrom: string, // "YYYY-MM-DD"
    public readonly effectiveUntil: string | null, // "YYYY-MM-DD" | null = abierto
    public readonly createdAt: Date,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw new Error(
        `effectiveFrom must be YYYY-MM-DD, got: ${effectiveFrom}`,
      );
    }
    if (effectiveUntil !== null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveUntil)) {
        throw new Error(
          `effectiveUntil must be YYYY-MM-DD or null, got: ${effectiveUntil}`,
        );
      }
      if (effectiveUntil < effectiveFrom) {
        throw new Error(
          `effectiveUntil (${effectiveUntil}) must be >= effectiveFrom (${effectiveFrom})`,
        );
      }
    }
  }

  static create(props: {
    id: string;
    companyId: string;
    employeeId: string;
    templateId: string;
    effectiveFrom: string;
    effectiveUntil?: string | null;
  }): ShiftMembership {
    return new ShiftMembership(
      props.id,
      props.companyId,
      props.employeeId,
      props.templateId,
      props.effectiveFrom,
      props.effectiveUntil ?? null,
      new Date(),
    );
  }

  static fromPersistence(row: {
    id: string;
    company_id: string;
    employee_id: string;
    template_id: string;
    effective_from: string;
    effective_until: string | null;
    created_at: string | Date;
  }): ShiftMembership {
    return new ShiftMembership(
      row.id,
      row.company_id,
      row.employee_id,
      row.template_id,
      row.effective_from,
      row.effective_until,
      new Date(row.created_at),
    );
  }

  /** ¿Esta membresía está activa en la fecha dada? */
  isActiveOn(dateISO: string): boolean {
    if (dateISO < this.effectiveFrom) return false;
    if (this.effectiveUntil !== null && dateISO > this.effectiveUntil)
      return false;
    return true;
  }
}
