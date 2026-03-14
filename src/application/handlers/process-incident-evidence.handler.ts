import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { ProcessIncidentEvidenceCommand } from '../commands/process-incident-evidence.command';
import { IncidentRepository } from '../../infrastructure/database/incident.repository';
import { OcrService } from '../../infrastructure/services/ocr.service';
import { LlmParsingService } from '../../infrastructure/services/llm-parsing.service';
import { OCRConfidence } from '../../domain/value-objects/ocr-confidence.vo';
import { MedicalLeavePeriod } from '../../domain/value-objects/medical-leave-period.vo';

import { IncidentValidationPolicy } from '../../domain/policies/incident-validation.policy';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import { Inject } from '@nestjs/common';

@CommandHandler(ProcessIncidentEvidenceCommand)
export class ProcessIncidentEvidenceHandler
    implements ICommandHandler<ProcessIncidentEvidenceCommand> {
    constructor(
        private readonly incidentRepository: IncidentRepository,
        private readonly ocrService: OcrService,
        private readonly llmParsingService: LlmParsingService,
        @Inject('IEmployeeRepository') private readonly employeeRepository: IEmployeeRepository,
        private readonly eventBus: EventBus,
    ) { }

    async execute(command: ProcessIncidentEvidenceCommand): Promise<void> {
        const { incidentId, mediaUrl } = command;

        const incident = await this.incidentRepository.findById(incidentId);
        if (!incident) {
            throw new Error(`Incident ${incidentId} not found`);
        }

        const employeeObj = await this.employeeRepository.findById(incident.employeeId, incident.companyId);
        if (!employeeObj) {
            throw new Error(`Employee ${incident.employeeId} not found`);
        }

        // 1. Start OCR Processing State
        incident.startOCRProcessing();
        await this.incidentRepository.save(incident);

        // 2. Execute OCR Strategy (Google Vision)
        const { rawText, confidence } = await this.ocrService.extractTextFromDocument(mediaUrl);

        // 3. Complete OCR in Domain
        incident.completeOCR(rawText, OCRConfidence.fromNumber(confidence));
        await this.incidentRepository.save(incident);

        // 4. Validate and Parse
        if (incident.status === 'pending_validation') {
            try {
                const parsedData = await this.llmParsingService.parseMedicalCertificate(rawText);

                // Phase 9 Validation Policy (Similarity check)
                const employeeMockName = (employeeObj as any).name || 'John Doe';
                IncidentValidationPolicy.validateCertificateParams(parsedData, employeeMockName);

                const startDate = new Date(parsedData.issue_date);
                const endDate = new Date(startDate);
                endDate.setDate(startDate.getDate() + parsedData.rest_days - 1);

                const period = MedicalLeavePeriod.create(startDate, endDate);
                incident.validateIncident(period);

            } catch (error: any) {
                incident.rejectIncident(error.message);
            }
            await this.incidentRepository.save(incident);
        }

        // Publish all accumulated domain events
        const events = incident.getUncommittedEvents();
        for (const event of events) {
            this.eventBus.publish(event);
        }
        incident.commit();
    }
}
