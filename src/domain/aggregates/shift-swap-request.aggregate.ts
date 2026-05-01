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
/**
 * `approvedBy` es opcional y describe quién/qué disparó la transición a
 * `accepted` o `rejected`. Phase 15.3:
 *   - 'system:auto-approve' cuando el depto tiene swap_auto_approve=true.
 *   - null cuando aprueba el manager desde el panel HTTP (todavía no
 *     hay auth → no podemos identificar qué manager). Cuando exista
 *     JWT, pasaremos `manager:<employeeId>`.
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
    private _approvedBy: string | null = null,
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
      null,
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
    approved_by?: string | null;
  }): ShiftSwapRequest {
    return new ShiftSwapRequest(
      row.id,
      row.company_id,
      row.requester_id,
      row.target_id,
      row.shift_assignment_id,
      row.status,
      new Date(row.created_at),
      row.approved_by ?? null,
    );
  }

  get status(): ShiftSwapRequestStatus {
    return this._status;
  }

  get approvedBy(): string | null {
    return this._approvedBy;
  }

  /** @param approvedBy opcional — ej. 'system:auto-approve'. */
  accept(approvedBy: string | null = null): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot accept a swap request in status '${this._status}'`,
      );
    }
    this._status = 'accepted';
    this._approvedBy = approvedBy;
  }

  reject(approvedBy: string | null = null): void {
    if (this._status !== 'pending') {
      throw new Error(
        `Cannot reject a swap request in status '${this._status}'`,
      );
    }
    this._status = 'rejected';
    this._approvedBy = approvedBy;
  }
}
