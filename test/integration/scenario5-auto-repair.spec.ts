import { Test, TestingModule } from '@nestjs/testing';
import { CqrsModule, CommandBus, EventBus } from '@nestjs/cqrs';
import { createClient } from '@supabase/supabase-js';
import { ProcessIncidentEvidenceHandler } from '../../src/application/handlers/process-incident-evidence.handler';
import { ProcessIncidentEvidenceCommand } from '../../src/application/commands/process-incident-evidence.command';
import { IncidentRepository } from '../../src/infrastructure/database/incident.repository';
import { EMPLOYEE_REPOSITORY } from '../../src/domain/repositories/employee.repository';
import type { IEmployeeRepository } from '../../src/domain/repositories/employee.repository';
import { OcrService } from '../../src/infrastructure/services/ocr.service';
import { LlmParsingService } from '../../src/infrastructure/services/llm-parsing.service';
import {
  Incident,
  IncidentType,
} from '../../src/domain/aggregates/incident.aggregate';

describe('Scenario 5 - Auto-Repair Intergration (ProcessIncidentEvidenceHandler)', () => {
  let moduleRef: TestingModule;
  let handler: ProcessIncidentEvidenceHandler;
  let incidentRepo: IncidentRepository;

  beforeAll(async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    moduleRef = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        ProcessIncidentEvidenceHandler,
        IncidentRepository,
        { provide: 'SUPABASE_CLIENT', useValue: supabase },
        {
          provide: EMPLOYEE_REPOSITORY,
          useValue: {
            findById: jest.fn().mockResolvedValue({
              id: 'emp-123',
              companyId: 'comp-abc',
              name: 'John Doe',
            }),
            findAllByCompany: jest
              .fn()
              .mockResolvedValue([
                { id: 'emp-123', companyId: 'comp-abc', name: 'John Doe' },
              ]),
          },
        },
        OcrService,
        {
          provide: LlmParsingService,
          useValue: {
            parseMedicalCertificate: jest.fn().mockResolvedValue({
              // Mocking Phase 9 exact response
              patient_name: 'John Doe',
              issue_date: '2026-03-08',
              rest_days: 3,
            }),
          },
        },
      ],
    }).compile();

    handler = moduleRef.get(ProcessIncidentEvidenceHandler);
    incidentRepo = moduleRef.get(IncidentRepository);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should be defined', () => {
    expect(handler).toBeDefined();
  });

  const TEST_COMPANY_ID = '99999999-0000-4000-8000-000000000099';
  const TEST_EMPLOYEE_ID = '99999999-0000-4000-8000-00000000aaaa';

  it('should process OCR, parse with LLM, and Validate the Incident', async () => {
    // 1. Arrange a mock incident in the DB
    const incident = Incident.reportIncident(
      TEST_COMPANY_ID,
      TEST_EMPLOYEE_ID,
      IncidentType.MEDICAL_LEAVE,
    );
    incident.attachEvidence('http://evidence.jpg');
    incident.commit(); // Clear events
    await incidentRepo.save(incident);

    // 2. Map Command
    const command = new ProcessIncidentEvidenceCommand(
      incident.id,
      TEST_EMPLOYEE_ID,
      'http://evidence.jpg',
    );

    // 3. Execute Handler
    await handler.execute(command);

    // 4. Assert Domain State
    const updatedIncident = await incidentRepo.findById(incident.id);
    expect(updatedIncident).toBeDefined();

    // The handler does state transitions: startOCRProcessing, completeOCR, validateIncident
    expect(updatedIncident?.status).toBe('validated');
    expect(updatedIncident?.validated).toBe(true);
    expect(updatedIncident?.ocrConfidence).toBe(0.95); // default mocked in OCR service
  });
});
