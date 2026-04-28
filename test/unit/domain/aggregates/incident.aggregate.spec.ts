import {
  Incident,
  IncidentType,
  IncidentStatus,
} from '../../../../src/domain/aggregates/incident.aggregate';
import { DomainError } from '../../../../src/domain/errors/domain.error';
import { OCRConfidence } from '../../../../src/domain/value-objects/ocr-confidence.vo';
import { MedicalLeavePeriod } from '../../../../src/domain/value-objects/medical-leave-period.vo';
import { IncidentReportedEvent } from '../../../../src/domain/events/incident-reported.event';
import { EvidenceAttachedEvent } from '../../../../src/domain/events/evidence-attached.event';
import { IncidentOCRCompletedEvent } from '../../../../src/domain/events/incident-ocr-completed.event';
import { IncidentRejectedEvent } from '../../../../src/domain/events/incident-rejected.event';
import { IncidentValidatedEvent } from '../../../../src/domain/events/incident-validated.event';

describe('Incident Aggregate', () => {
  const companyId = 'company-123';
  const employeeId = 'emp-456';

  let incident: Incident;

  beforeEach(() => {
    incident = Incident.reportIncident(
      companyId,
      employeeId,
      IncidentType.MEDICAL_LEAVE,
    );
  });

  it('should create an Incident and emit IncidentReportedEvent', () => {
    expect(incident.id).toBeDefined();
    expect(incident.companyId).toBe(companyId);
    expect(incident.employeeId).toBe(employeeId);
    expect(incident.type).toBe(IncidentType.MEDICAL_LEAVE);
    expect(incident.status).toBe(IncidentStatus.REPORTED);

    const uncommittedEvents = incident.getUncommittedEvents();
    expect(uncommittedEvents.length).toBe(1);
    expect(uncommittedEvents[0]).toBeInstanceOf(IncidentReportedEvent);
  });

  it('should attach evidence and transition to PENDING_OCR', () => {
    incident.commit(); // Clear events

    const url = 'http://example.com/certificate.pdf';
    incident.attachEvidence(url);

    expect(incident.evidenceUrl).toBe(url);
    expect(incident.status).toBe(IncidentStatus.PENDING_OCR);

    const uncommittedEvents = incident.getUncommittedEvents();
    expect(uncommittedEvents.length).toBe(1);
    expect(uncommittedEvents[0]).toBeInstanceOf(EvidenceAttachedEvent);
  });

  it('should block OCR complete if not in processing state', () => {
    incident.attachEvidence('url');
    // status is PENDING_OCR, not PROCESSING_OCR
    const conf = OCRConfidence.fromNumber(0.9);
    expect(() => incident.completeOCR('text', conf)).toThrow(DomainError);
  });

  describe('OCR Processing', () => {
    beforeEach(() => {
      incident.attachEvidence('http://example.com/image.jpg');
      incident.startOCRProcessing();
    });

    it('should complete OCR successfully with valid confidence', () => {
      incident.commit();
      const conf = OCRConfidence.fromNumber(0.9);
      incident.completeOCR('Rest 3 days', conf);

      expect(incident.ocrText).toBe('Rest 3 days');
      expect(incident.status).toBe(IncidentStatus.PENDING_VALIDATION);

      const events = incident.getUncommittedEvents();
      expect(events[0]).toBeInstanceOf(IncidentOCRCompletedEvent);
    });

    it('should automatically reject OCR if confidence is suspicious', () => {
      incident.commit();
      const suspiciousConf = OCRConfidence.fromNumber(0.5); // < 0.65
      incident.completeOCR('Blurry text', suspiciousConf);

      expect(incident.status).toBe(IncidentStatus.REJECTED);
      const events = incident.getUncommittedEvents();
      expect(events[0]).toBeInstanceOf(IncidentRejectedEvent);
    });
  });

  describe('Validation and Repair', () => {
    beforeEach(() => {
      incident.attachEvidence('http://url');
      incident.startOCRProcessing();
      incident.completeOCR('Text', OCRConfidence.fromNumber(0.9));
    });

    it('should validate incident and transition to VALIDATED', () => {
      incident.commit();
      const period = MedicalLeavePeriod.create(new Date(), new Date());
      incident.validateIncident(period);

      expect(incident.validated).toBe(true);
      expect(incident.status).toBe(IncidentStatus.VALIDATED);

      const events = incident.getUncommittedEvents();
      expect(events[0]).toBeInstanceOf(IncidentValidatedEvent);
    });

    it('should reject incident with reason', () => {
      incident.commit();
      incident.rejectIncident('Doctor details unmatched');

      expect(incident.status).toBe(IncidentStatus.REJECTED);
      expect(incident.validated).toBe(false);

      const events = incident.getUncommittedEvents();
      expect(events[0]).toBeInstanceOf(IncidentRejectedEvent);
    });
  });
});
