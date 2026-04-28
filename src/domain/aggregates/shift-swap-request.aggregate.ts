export type ShiftSwapRequestStatus = 'pending' | 'accepted' | 'rejected';

/**
 * ShiftSwapRequest — entidad persistida para solicitudes de intercambio
 * de turno. No extiende AggregateRoot (no publica eventos): es un simple
 * contenedor de estado con una máquina de estados manual.
 *
 * El flujo de negocio es:
 *   pending → accepted | rejected (terminal)
 *
 * La aceptación de un request NO aplica automáticamente el intercambio
 * de assignments — ese paso queda para un handler que consuma el
 * status=accepted y ejecute la mutación real sobre shift_assignments.
 */
export class ShiftSwapRequest {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly requesterId: string,
    public readonly targetId: string,
    public readonly assignmentId: string | null,
    private _status: ShiftSwapRequestStatus,
    public readonly createdAt: Date,
  ) {}

  static create(props: {
    id: string;
    companyId: string;
    requesterId: string;
    targetId: string;
    assignmentId: string | null;
  }): ShiftSwapRequest {
    return new ShiftSwapRequest(
      props.id,
      props.companyId,
      props.requesterId,
      props.targetId,
      props.assignmentId,
      'pending',
      new Date(),
    );
  }

  static fromPersistence(row: {
    id: string;
    company_id: string;
    requester_id: string;
    target_id: string;
    shift_assignment_id: string | null;
    status: ShiftSwapRequestStatus;
    created_at: string | Date;
  }): ShiftSwapRequest {
    return new ShiftSwapRequest(
      row.id,
      row.company_id,
      row.requester_id,
      row.target_id,
      row.shift_assignment_id,
      row.status,
      new Date(row.created_at),
    );
  }

  get status(): ShiftSwapRequestStatus {
    return this._status;
  }

  accept(): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot accept a swap request in status '${this._status}'`,
      );
    }
    this._status = 'accepted';
  }

  reject(): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot reject a swap request in status '${this._status}'`,
      );
    }
    this._status = 'rejected';
  }
}
