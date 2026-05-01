/**
 * AbsenceReport — período (1 ó N días) en que un empleado declara que no
 * trabajará. El `assignmentId` apunta al turno disparador cuando lo hay
 * (caso WhatsApp "no voy a este turno"); el caller del Creator se encarga
 * de borrar los assignments dentro del range. Acá solo guardamos el
 * registro persistente.
 *
 * Phase 17.1 — agregamos `startDate` y `endDate` para soportar reposos
 * multi-día. Ausencias parciales (por hora) no viven acá; van por
 * semantic rules.
 *
 * Sin máquina de estados: se crea y queda hasta soft-delete.
 */
export class AbsenceReport {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly assignmentId: string | null,
    public readonly reason: string,
    public readonly isUrgent: boolean,
    public readonly startDate: string, // 'YYYY-MM-DD'
    public readonly endDate: string, // 'YYYY-MM-DD'
    public readonly reportedAt: Date,
    public readonly deletedAt: Date | null = null,
  ) {}

  static create(props: {
    id: string;
    companyId: string;
    employeeId: string;
    assignmentId: string | null;
    reason: string;
    startDate: string;
    endDate: string;
    isUrgent?: boolean;
  }): AbsenceReport {
    if (props.endDate < props.startDate) {
      throw new Error(
        `endDate (${props.endDate}) cannot be before startDate (${props.startDate})`,
      );
    }
    return new AbsenceReport(
      props.id,
      props.companyId,
      props.employeeId,
      props.assignmentId,
      props.reason,
      props.isUrgent ?? false,
      props.startDate,
      props.endDate,
      new Date(),
      null,
    );
  }

  static fromPersistence(row: {
    id: string;
    company_id: string;
    employee_id: string;
    shift_assignment_id: string | null;
    reason: string;
    is_urgent: boolean | null;
    start_date: string;
    end_date: string;
    reported_at: string | Date;
    deleted_at?: string | Date | null;
  }): AbsenceReport {
    return new AbsenceReport(
      row.id,
      row.company_id,
      row.employee_id,
      row.shift_assignment_id,
      row.reason,
      Boolean(row.is_urgent ?? false),
      row.start_date,
      row.end_date,
      new Date(row.reported_at),
      row.deleted_at ? new Date(row.deleted_at) : null,
    );
  }
}
