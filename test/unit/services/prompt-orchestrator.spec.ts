import { PromptOrchestratorService } from '../../../src/domain/services/prompt-orchestrator.service';
import { ScheduleValidatorService } from '../../../src/domain/services/schedule-validator.service';
import type { ILLMService } from '../../../src/domain/services/llm.service.interface';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';

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

function makeSlot(
  templateId: string,
  startHour = 8,
  endHour = 16,
): VirtualShiftSlot {
  const start = new Date('2026-03-04T00:00:00Z');
  start.setUTCHours(startHour, 0, 0, 0);
  const end = new Date('2026-03-04T00:00:00Z');
  end.setUTCHours(endHour, 0, 0, 0);
  return VirtualShiftSlot.create({
    templateId,
    companyId: 'company-1',
    date: '2026-03-04',
    startTime: start,
    endTime: end,
    templateName: templateId,
    requiredEmployees: 1,
    demandScore: 5,
    undesirableWeight: 0.2,
  });
}

function makeLLMMock(response: string): jest.Mocked<ILLMService> {
  return { complete: jest.fn().mockResolvedValue(response) };
}

function llmResponseFor(
  assignments: { slotKey: string; employeeId: string; confidence?: number; reason?: string }[],
): string {
  return JSON.stringify({
    assignments: assignments.map((a) => ({
      shiftId: a.slotKey,
      employeeId: a.employeeId,
      reason: a.reason ?? 'ok',
      confidence: a.confidence ?? 0.9,
    })),
  });
}

const i18n = { t: (key: string) => key } as any;

describe('PromptOrchestratorService', () => {
  let validator: ScheduleValidatorService;
  let employees: Employee[];
  let slotA: VirtualShiftSlot;
  let slotB: VirtualShiftSlot;

  beforeEach(() => {
    validator = new ScheduleValidatorService();
    employees = [makeEmployee('e1'), makeEmployee('e2')];
    slotA = makeSlot('s1', 8, 16);
    slotB = makeSlot('s2', 12, 20);
  });

  it('accepts LLM proposals that pass validation', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(
        llmResponseFor([
          { slotKey: slotA.slotKey, employeeId: 'e1' },
          { slotKey: slotB.slotKey, employeeId: 'e2', confidence: 0.85 },
        ]),
      ),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(2);
    expect(result.algorithmCorrected).toBe(0);
    expect(result.assignments).toHaveLength(2);
    expect(result.unfilledSlots).toHaveLength(0);
  });

  it('falls back to algorithm when LLM proposes a non-existent employee', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(
        llmResponseFor([
          { slotKey: slotA.slotKey, employeeId: 'NON_EXISTENT', confidence: 0.95 },
        ]),
      ),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(0);
    expect(result.algorithmCorrected).toBeGreaterThanOrEqual(1);
    expect(result.explanation).toContain('bot.schedule.explanation_algorithm');
  });

  it('falls back to algorithm when LLM throws', async () => {
    const orchestrator = new PromptOrchestratorService(
      { complete: jest.fn().mockRejectedValue(new Error('timeout')) },
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(0);
    expect(result).toBeDefined();
    expect(result.explanation).toContain('bot.schedule.explanation_llm_failed');
  });

  it('falls back to algorithm when LLM returns non-JSON', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock('No tengo propuestas.'),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(0);
    expect(result.algorithmCorrected).toBeGreaterThan(0);
  });

  it('filters out LLM proposals below confidence threshold', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(
        llmResponseFor([
          { slotKey: slotA.slotKey, employeeId: 'e1', confidence: 0.5 },
          { slotKey: slotB.slotKey, employeeId: 'e2', confidence: 0.9 },
        ]),
      ),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(1);
    expect(result.algorithmCorrected).toBe(1);
  });

  it('rejects LLM proposal that overlaps with a previous LLM assignment', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(
        llmResponseFor([
          { slotKey: slotA.slotKey, employeeId: 'e1' },
          { slotKey: slotB.slotKey, employeeId: 'e1', confidence: 0.95 }, // solapa
        ]),
      ),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(1);
    expect(result.algorithmCorrected).toBe(1);
  });

  it('produces a non-empty explanation with stats', async () => {
    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(llmResponseFor([{ slotKey: slotA.slotKey, employeeId: 'e1' }])),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees,
      slots: [slotA, slotB],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });
    expect(result.explanation).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(20);
  });

  it('includes unfilledSlots when no candidates remain for a slot', async () => {
    const singleEmployee = [makeEmployee('e1')];
    const slotX = makeSlot('x1', 8, 16);
    const slotY = makeSlot('y1', 10, 18); // overlaps with x1

    const orchestrator = new PromptOrchestratorService(
      makeLLMMock(llmResponseFor([{ slotKey: slotX.slotKey, employeeId: 'e1' }])),
      validator,
      i18n,
    );
    const result = await orchestrator.orchestrate({
      employees: singleEmployee,
      slots: [slotX, slotY],
      histories: [],
      companyId: 'company-1',
      weekStart: new Date('2026-03-04'),
      semanticRules: [],
    });

    expect(result.llmAccepted).toBe(1);
    expect(result.unfilledSlots).toHaveLength(1);
    expect(result.unfilledSlots[0].slotKey).toBe(slotY.slotKey);
  });
});
