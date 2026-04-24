export type DayOffRequestStatus = 'pending' | 'approved' | 'rejected';

/**
 * DayOffRequest — solicitud de un empleado para un día libre específico.
 * Máquina de estados: pending → approved | rejected (terminal).
 */
export class DayOffRequest {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly employeeId: string,
    public readonly date: string, // YYYY-MM-DD
    public readonly reason: string,
    private _status: DayOffRequestStatus,
    public readonly createdAt: Date,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`date must be YYYY-MM-DD, got: ${date}`);
    }
  }

  static create(props: {
    id: string;
    companyId: string;
    employeeId: string;
    date: string;
    reason: string;
  }): DayOffRequest {
    return new DayOffRequest(
      props.id,
      props.companyId,
      props.employeeId,
      props.date,
      props.reason,
      'pending',
      new Date(),
    );
  }

  static fromPersistence(row: {
    id: string;
    company_id: string;
    employee_id: string;
    date: string;
    reason: string;
    status: DayOffRequestStatus;
    created_at: string | Date;
  }): DayOffRequest {
    return new DayOffRequest(
      row.id,
      row.company_id,
      row.employee_id,
      row.date,
      row.reason,
      row.status,
      new Date(row.created_at),
    );
  }

  get status(): DayOffRequestStatus {
    return this._status;
  }

  approve(): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot approve a day-off request in status '${this._status}'`,
      );
    }
    this._status = 'approved';
  }

  reject(): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot reject a day-off request in status '${this._status}'`,
      );
    }
    this._status = 'rejected';
  }
}
