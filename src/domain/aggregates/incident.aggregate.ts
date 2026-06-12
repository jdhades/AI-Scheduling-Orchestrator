import { AggregateRoot } from '@nestjs/cqrs';
import { DomainError } from '../errors/domain.error';
import { IncidentId } from '../value-objects/incident-id.vo';
import { OCRConfidence } from '../value-objects/ocr-confidence.vo';
import { MedicalLeavePeriod } from '../value-objects/medical-leave-period.vo';

import { IncidentReportedEvent } from '../events/incident-reported.event';
import { EvidenceAttachedEvent } from '../events/evidence-attached.event';
import { IncidentOCRCompletedEvent } from '../events/incident-ocr-completed.event';
import { IncidentValidatedEvent } from '../events/incident-validated.event';
import { IncidentRejectedEvent } from '../events/incident-rejected.event';
import { IncidentRepairStartedEvent } from '../events/incident-repair-started.event';
import { ReplacementAssignedEvent } from '../events/replacement-assigned.event';
import { IncidentResolvedEvent } from '../events/incident-resolved.event';

export enum IncidentType {
  /** Reporte libre del empleado (sin tipo), el texto va en `message`. */
  GENERAL = 'GENERAL',
  MEDICAL_LEAVE = 'MEDICAL_LEAVE',
  EMERGENCY_LEAVE = 'EMERGENCY_LEAVE',
  SHIFT_SWAP_REQUEST = 'SHIFT_SWAP_REQUEST',
  LATE = 'LATE',
  NO_SHOW = 'NO_SHOW',
  BIOMETRIC_MISS = 'BIOMETRIC_MISS',
}

export enum IncidentStatus {
  REPORTED = 'reported',
  DOCUMENT_RECEIVED = 'document_received',
  PENDING_OCR = 'pending_ocr',
  PROCESSING_OCR = 'processing_ocr',
  PENDING_VALIDATION = 'pending_validation',
  VALIDATED = 'validated',
  REJECTED = 'rejected',
  REPAIR_IN_PROGRESS = 'repair_in_progress',
  REPLACEMENT_PENDING = 'replacement_pending',
  REPLACEMENT_ASSIGNED = 'replacement_assigned',
  RESOLVED = 'resolved',
}

export class Incident extends AggregateRoot {
  private _evidenceUrl: string | null = null;
  private _message: string | null = null;
  private _ocrText: string | null = null;
  private _ocrConfidence: number | null = null;
  private _validated: boolean = false;
  private _startDate: Date | null = null;
  private _endDate: Date | null = null;
  private _updatedAt: Date;

  private constructor(
    private readonly _id: IncidentId,
    private readonly _companyId: string,
    private readonly _employeeId: string,
    private readonly _type: IncidentType,
    private _status: IncidentStatus,
    private readonly _createdAt: Date,
  ) {
    super();
    this._updatedAt = new Date();
  }

  // Getters
  get id(): string {
    return this._id.value;
  }
  get companyId(): string {
    return this._companyId;
  }
  get employeeId(): string {
    return this._employeeId;
  }
  get type(): IncidentType {
    return this._type;
  }
  get status(): IncidentStatus {
    return this._status;
  }
  get evidenceUrl(): string | null {
    return this._evidenceUrl;
  }
  /** Texto libre del empleado (reporte sin OCR). */
  get message(): string | null {
    return this._message;
  }
  get ocrText(): string | null {
    return this._ocrText;
  }
  get ocrConfidence(): number | null {
    return this._ocrConfidence;
  }
  get validated(): boolean {
    return this._validated;
  }
  get startDate(): Date | null {
    return this._startDate;
  }
  get endDate(): Date | null {
    return this._endDate;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Reconstituye un Incident desde una fila de persistencia SIN disparar
   * eventos. Usado por el adapter Supabase para hidratar lecturas.
   */
  static fromPersistence(row: {
    id: string;
    companyId: string;
    employeeId: string;
    type: IncidentType;
    status: IncidentStatus;
    evidenceUrl: string | null;
    message: string | null;
    ocrText: string | null;
    ocrConfidence: number | null;
    validated: boolean;
    startDate: Date | null;
    endDate: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Incident {
    const incident = new Incident(
      IncidentId.fromString(row.id),
      row.companyId,
      row.employeeId,
      row.type,
      row.status,
      row.createdAt,
    );
    incident._evidenceUrl = row.evidenceUrl;
    incident._message = row.message;
    incident._ocrText = row.ocrText;
    incident._ocrConfidence = row.ocrConfidence;
    incident._validated = row.validated;
    incident._startDate = row.startDate;
    incident._endDate = row.endDate;
    incident._updatedAt = row.updatedAt;
    return incident;
  }

  // State Management
  private setStatus(newStatus: IncidentStatus) {
    this._status = newStatus;
    this._updatedAt = new Date();
  }

  // Domain Logic & Transitions

  static reportIncident(
    companyId: string,
    employeeId: string,
    type: IncidentType,
    message: string | null = null,
  ): Incident {
    const id = IncidentId.create();
    const incident = new Incident(
      id,
      companyId,
      employeeId,
      type,
      IncidentStatus.REPORTED,
      new Date(),
    );
    incident._message = message;

    incident.apply(
      new IncidentReportedEvent(id.value, companyId, employeeId, {
        type: type.toString(),
        status: incident.status.toString(),
      }),
    );

    return incident;
  }

  attachEvidence(url: string): void {
    if (
      this._status !== IncidentStatus.REPORTED &&
      this._status !== IncidentStatus.DOCUMENT_RECEIVED
    ) {
      throw new DomainError(
        'Invalid state transition: Cannot attach evidence unless reported.',
      );
    }
    this._evidenceUrl = url;
    this.setStatus(IncidentStatus.PENDING_OCR);

    this.apply(
      new EvidenceAttachedEvent(this.id, this.companyId, this.employeeId, {
        evidenceUrl: url,
      }),
    );
  }

  startOCRProcessing(): void {
    if (this._status !== IncidentStatus.PENDING_OCR) {
      throw new DomainError(
        'Invalid state transition: Cannot start OCR unless pending OCR.',
      );
    }
    this.setStatus(IncidentStatus.PROCESSING_OCR);
  }

  completeOCR(text: string, confidence: OCRConfidence): void {
    if (this._status !== IncidentStatus.PROCESSING_OCR) {
      throw new DomainError(
        'Invalid state transition: Cannot complete OCR unless processing OCR.',
      );
    }
    this._ocrText = text;
    this._ocrConfidence = confidence.value;

    if (confidence.isSuspicious) {
      this.setStatus(IncidentStatus.REJECTED);
      this.apply(
        new IncidentRejectedEvent(this.id, this.companyId, this.employeeId, {
          reason:
            'OCR Confidence too low (' + confidence.value.toString() + ')',
        }),
      );
    } else {
      this.setStatus(IncidentStatus.PENDING_VALIDATION);
      this.apply(
        new IncidentOCRCompletedEvent(
          this.id,
          this.companyId,
          this.employeeId,
          {
            ocrText: text,
            ocrConfidence: confidence.value,
          },
        ),
      );
    }
  }

  validateIncident(period: MedicalLeavePeriod): void {
    if (this._status !== IncidentStatus.PENDING_VALIDATION) {
      throw new DomainError(
        'Invalid state transition: Cannot validate unless pending validation.',
      );
    }
    this._validated = true;
    this._startDate = period.startDate;
    this._endDate = period.endDate;
    this.setStatus(IncidentStatus.VALIDATED);

    this.apply(
      new IncidentValidatedEvent(this.id, this.companyId, this.employeeId, {
        validated: true,
        startDate: this._startDate,
        endDate: this._endDate,
      }),
    );
  }

  rejectIncident(reason: string): void {
    if (
      this._status === IncidentStatus.RESOLVED ||
      this._status === IncidentStatus.REJECTED
    ) {
      throw new DomainError('Incident is already closed.');
    }
    this._validated = false;
    this.setStatus(IncidentStatus.REJECTED);

    this.apply(
      new IncidentRejectedEvent(this.id, this.companyId, this.employeeId, {
        reason,
      }),
    );
  }

  startRepair(affectedShiftsIds: string[]): void {
    if (this._status !== IncidentStatus.VALIDATED) {
      throw new DomainError(
        'Invalid state transition: Cannot start repair unless validated.',
      );
    }

    if (affectedShiftsIds.length > 0) {
      this.setStatus(IncidentStatus.REPAIR_IN_PROGRESS);
    } else {
      this.setStatus(IncidentStatus.RESOLVED); // No repair needed
    }

    this.apply(
      new IncidentRepairStartedEvent(this.id, this.companyId, this.employeeId, {
        affectedShiftsIds,
      }),
    );
  }

  assignReplacement(
    replacementEmployeeId: string,
    shiftId: string,
    strategy: string,
  ): void {
    if (
      this._status !== IncidentStatus.REPAIR_IN_PROGRESS &&
      this._status !== IncidentStatus.REPLACEMENT_PENDING
    ) {
      throw new DomainError(
        'Invalid state transition: Cannot assign replacement unless repair is in progress.',
      );
    }

    // Ideally, we could transition to REPLACEMENT_ASSIGNED and wait for all shifts
    // but for simplicity we simulate the step of assigning one replacement.
    this.setStatus(IncidentStatus.REPLACEMENT_ASSIGNED);

    this.apply(
      new ReplacementAssignedEvent(this.id, this.companyId, this.employeeId, {
        replacementEmployeeId,
        shiftId,
        strategy,
      }),
    );
  }

  resolveIncident(details: string): void {
    if (
      this._status !== IncidentStatus.REPLACEMENT_ASSIGNED &&
      this._status !== IncidentStatus.VALIDATED &&
      this._status !== IncidentStatus.REPAIR_IN_PROGRESS &&
      // Reporte libre del empleado (sin OCR): el manager lo resuelve directo.
      this._status !== IncidentStatus.REPORTED
    ) {
      throw new DomainError(
        'Invalid state transition: Cannot resolve from current status.',
      );
    }

    this.setStatus(IncidentStatus.RESOLVED);

    this.apply(
      new IncidentResolvedEvent(this.id, this.companyId, this.employeeId, {
        resolutionDetails: details,
      }),
    );
  }
}
