/**
 * AbsenceReport — entidad persistida cuando un empleado reporta una
 * ausencia (típicamente por WhatsApp). Guarda el motivo + flag de
 * urgencia + la assignment afectada. La assignment puede haber sido
 * borrada (ON DELETE SET NULL en la FK) por lo que `assignmentId` es
 * nullable.
 *
 * Sin máquina de estados: se crea y queda. El workflow posterior
 * (auto-repair, reemplazo) se dispara vía eventos.
 */
export class AbsenceReport {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly assignmentId: string | null,
    public readonly reason: string,
    public readonly isUrgent: boolean,
    public readonly reportedAt: Date,
  ) {}

  static create(props: {
    id: string;
    companyId: string;
    employeeId: string;
    assignmentId: string | null;
    reason: string;
    isUrgent?: boolean;
  }): AbsenceReport {
    return new AbsenceReport(
      props.id,
      props.companyId,
      props.employeeId,
      props.assignmentId,
      props.reason,
      props.isUrgent ?? false,
      new Date(),
    );
  }

  static fromPersistence(row: {
    id: string;
    company_id: string;
    employee_id: string;
    shift_assignment_id: string | null;
    reason: string;
    is_urgent: boolean | null;
    reported_at: string | Date;
  }): AbsenceReport {
    return new AbsenceReport(
      row.id,
      row.company_id,
      row.employee_id,
      row.shift_assignment_id,
      row.reason,
      Boolean(row.is_urgent ?? false),
      new Date(row.reported_at),
    );
  }
}
