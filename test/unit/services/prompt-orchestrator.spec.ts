import { PromptOrchestratorService } from '../../../src/domain/services/prompt-orchestrator.service';
import { ScheduleValidatorService } from '../../../src/domain/services/schedule-validator.service';
import { LLMScheduleProposalVO } from '../../../src/domain/value-objects/llm-schedule-proposal.vo';
import type { ILLMService } from '../../../src/domain/services/llm.service.interface';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { Shift } from '../../../src/domain/aggregates/shift.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmployee(id: string): Employee {
  return Employee.fromPersistence({
    id,
    companyId: 'company-1',
    name: 'John Doe',
    role: 'Waiter',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, {
      junior: 6,
      intermediate: 24,
      senior: 999,
    }),
  });
}

function makeShift(id: string, startHour = 8, endHour = 16): Shift {
  const start = new Date('2026-03-04T00:00:00Z');
  start.setUTCHours(startHour, 0, 0, 0);
  const end = new Date('2026-03-04T00:00:00Z');
  end.setUTCHours(endHour, 0, 0, 0);

  return Shift.create({
    id,
    companyId: 'company-1',
    startTime: start,
    endTime: end,
    requiredSkillId: null,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(5),
    undesirableWeight: UndesirableWeight.create(1),
  });
}

function makeLLMMock(response: string): jest.Mocked<ILLMService> {
  return { complete: jest.fn().mockResolvedValue(response) };
}

function makeValidLLMResponse(shiftId: string, employeeId: string): string {
  return JSON.stringify({
    assignments: [
      {
        shiftId,
        employeeId,
        reason: 'Disponible y tiene la skill',
        confidence: 0.9,
      },
    ],
  });
}

// ─── PromptOrchestratorService ────────────────────────────────────────────────

describe('PromptOrchestratorService', () => {
  let validator: ScheduleValidatorService;
  let employees: Employee[];
  let shifts: Shift[];

  beforeEach(() => {
    validator = new ScheduleValidatorService();
    employees = [makeEmployee('e1'), makeEmployee('e2')];
    shifts = [makeShift('s1', 8, 16), makeShift('s2', 12, 20)];
  });

  it('should accept LLM proposals that pass validation', async () => {
    const llmResponse = JSON.stringify({
      assignments: [
        {
          shiftId: 's1',
          employeeId: 'e1',
          reason: 'Disponible',
          confidence: 0.9,
        },
        {
          shiftId: 's2',
          employeeId: 'e2',
          reason: 'Disponible',
          confidence: 0.85,
        },
      ],
    });

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(llmResponse),
      validator,
    );
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(2);
    expect(result.algorithmCorrected).toBe(0);
    expect(result.assignments).toHaveLength(2);
    expect(result.unfilledShifts).toHaveLength(0);
  });

  it('should fall back to algorithm when LLM proposes non-existent employee', async () => {
    const invalidResponse = JSON.stringify({
      assignments: [
        {
          shiftId: 's1',
          employeeId: 'NON_EXISTENT',
          reason: 'OK',
          confidence: 0.95,
        },
      ],
    });

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(invalidResponse),
      validator,
    );
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    // LLM propusó a NON_EXISTENT → rechazado → algoritmo cubre s1
    expect(result.llmAccepted).toBe(0);
    expect(result.algorithmCorrected).toBeGreaterThanOrEqual(1);
    expect(result.explanation).toContain('algoritmo determinístico');
  });

  it('should fall back to full algorithm when LLM throws an error', async () => {
    const failingLLM: jest.Mocked<ILLMService> = {
      complete: jest.fn().mockRejectedValue(new Error('Gemini API timeout')),
    };

    const orchestrator = new PromptOrchestratorService(failingLLM, validator);
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    // LLM falló → 0 asignaciones aceptadas del LLM
    expect(result.llmAccepted).toBe(0);
    // El resultado no debe lanzar excepción — el orquestador es resiliente
    expect(result).toBeDefined();
    expect(result.explanation).toContain('LLM no pudo generar propuestas');
  });

  it('should fall back to algorithm when LLM returns empty response', async () => {
    const emptyLLM: jest.Mocked<ILLMService> = {
      complete: jest
        .fn()
        .mockResolvedValue('No tengo propuestas para este schedule.'),
    };

    const orchestrator = new PromptOrchestratorService(emptyLLM, validator);
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(0);
    expect(result.algorithmCorrected).toBeGreaterThan(0);
  });

  it('should filter out LLM proposals below confidence threshold (0.7)', async () => {
    const lowConfidenceResponse = JSON.stringify({
      assignments: [
        {
          shiftId: 's1',
          employeeId: 'e1',
          reason: 'No seguro',
          confidence: 0.5,
        }, // bajo threshold
        { shiftId: 's2', employeeId: 'e2', reason: 'Seguro', confidence: 0.9 }, // sobre threshold
      ],
    });

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(lowConfidenceResponse),
      validator,
    );
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    // Solo s2 fue aceptado del LLM; s1 → algoritmo
    expect(result.llmAccepted).toBe(1);
    expect(result.algorithmCorrected).toBe(1);
  });

  it('should reject LLM proposal when employee has time overlap with previous LLM assignment', async () => {
    // LLM intenta asignar al mismo empleado dos turnos solapados
    const overlapResponse = JSON.stringify({
      assignments: [
        { shiftId: 's1', employeeId: 'e1', reason: 'OK', confidence: 0.9 },
        { shiftId: 's2', employeeId: 'e1', reason: 'OK', confidence: 0.95 }, // s2 solapa con s1 (8-16, 12-20)
      ],
    });

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(overlapResponse),
      validator,
    );
    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    // El primer turno s1 se asigna. El segundo s2 solapa, por lo tanto s2 es rechazado.
    // llmAccepted = 1.
    expect(result.llmAccepted).toBe(1);
    expect(result.algorithmCorrected).toBe(1);
  });

  it('should produce explanation mentioning LLM and algorithm stats', async () => {
    const llmResponse = makeValidLLMResponse('s1', 'e1');
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(llmResponse),
      validator,
    );

    const result = await orchestrator.orchestrate({
      employees,
      shifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.explanation).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(20);
  });

  it('should include unfilledShifts when no candidates available for a shift', async () => {
    // Solo hay un empleado y LLM lo asigna al primer turno correctamente
    // El segundo turno no tiene candidato si el mismo empleado estaría solapado
    // Pero en este caso los turnos son consecutivos (no solapados por overlapsWith)
    const singleEmployee = [makeEmployee('e1')];
    const overlappingShifts = [makeShift('s1', 8, 16), makeShift('s2', 10, 18)]; // THESE overlap

    const llmResponse = JSON.stringify({
      assignments: [
        { shiftId: 's1', employeeId: 'e1', reason: 'OK', confidence: 0.9 },
      ],
    });

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(llmResponse),
      validator,
    );
    const result = await orchestrator.orchestrate({
      employees: singleEmployee,
      shifts: overlappingShifts,
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    // s1 aceptado del LLM; s2 no tiene candidato válido → unfilledShifts
    expect(result.llmAccepted).toBe(1);
    expect(result.unfilledShifts).toHaveLength(1);
    expect(result.unfilledShifts[0].id).toBe('s2');
  });
});
