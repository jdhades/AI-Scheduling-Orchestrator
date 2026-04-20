import { LLMLineProposerService } from '../../../src/domain/services/llm-line-proposer.service';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';
import type { ILLMService } from '../../../src/domain/services/llm.service.interface';

const COMPANY = 'co-1';
const RANGES = { junior: 6, intermediate: 24, senior: 999 };

function makeEmployee(id: string, name: string): Employee {
  return Employee.fromPersistence({
    id,
    companyId: COMPANY,
    name,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, RANGES),
  });
}

function makeSlot(templateId: string, templateName: string, date: string): VirtualShiftSlot {
  return VirtualShiftSlot.create({
    templateId,
    companyId: COMPANY,
    date,
    startTime: new Date(`${date}T08:00:00Z`),
    endTime: new Date(`${date}T16:00:00Z`),
    templateName,
    requiredEmployees: 2,
  });
}

function fakeLLM(response: string): ILLMService {
  return {
    complete: jest.fn().mockResolvedValue(response),
  };
}

describe('LLMLineProposerService', () => {
  it('traduce nombres de empleado y template a UUIDs al parsear', async () => {
    const emps = [makeEmployee('u-sofia', 'Sofía'), makeEmployee('u-pablo', 'Pablo')];
    const slots = [
      makeSlot('tpl-diurno', 'Diurno', '2026-03-09'),
      makeSlot('tpl-noct', 'Nocturno', '2026-03-09'),
    ];

    const llmResponse = JSON.stringify({
      weekStart: '2026-03-09',
      lines: [
        { employee: 'Sofía', days: { '2026-03-09': 'Diurno' } },
        { employee: 'Pablo', days: { '2026-03-09': 'Nocturno' } },
      ],
    });
    const service = new LLMLineProposerService(fakeLLM(llmResponse));
    const result = await service.proposeLines({
      employees: emps,
      slots,
      semanticRules: [],
      weekStart: new Date('2026-03-09T00:00:00Z'),
    });
    expect(result.size).toBe(2);
    expect(result.get('u-sofia')?.['2026-03-09']).toBe('tpl-diurno');
    expect(result.get('u-pablo')?.['2026-03-09']).toBe('tpl-noct');
  });

  it('tolera chain-of-thought antes del JSON (extractJson)', async () => {
    const emps = [makeEmployee('u-1', 'Ana')];
    const slots = [makeSlot('tpl-d', 'Diurno', '2026-03-09')];
    const raw = `Primero razono el problema. Ana trabaja el lunes.
Al final devuelvo:

\`\`\`json
{
  "weekStart": "2026-03-09",
  "lines": [ { "employee": "Ana", "days": { "2026-03-09": "Diurno" } } ]
}
\`\`\`

Listo.`;
    const service = new LLMLineProposerService(fakeLLM(raw));
    const result = await service.proposeLines({
      employees: emps,
      slots,
      semanticRules: [],
      weekStart: new Date('2026-03-09T00:00:00Z'),
    });
    expect(result.get('u-1')?.['2026-03-09']).toBe('tpl-d');
  });

  it('JSON inválido → Map vacío (no throw)', async () => {
    const emps = [makeEmployee('u-1', 'Ana')];
    const slots = [makeSlot('tpl-d', 'Diurno', '2026-03-09')];
    const raw = '{ esto no es JSON válido';
    const service = new LLMLineProposerService(fakeLLM(raw));
    const result = await service.proposeLines({
      employees: emps,
      slots,
      semanticRules: [],
      weekStart: new Date('2026-03-09T00:00:00Z'),
    });
    expect(result.size).toBe(0);
  });

  it('nombres de empleado duplicados se desambiguan con sufijo del UUID', async () => {
    // Dos empleados con el mismo nombre "Ana"
    const emps = [
      makeEmployee('u-ana1-aaaaaaaa', 'Ana'),
      makeEmployee('u-ana2-bbbbbbbb', 'Ana'),
    ];
    const slots = [makeSlot('tpl-d', 'Diurno', '2026-03-09')];
    // El LLM (si recibe el prompt correctamente) ve "Ana (u-ana1)" y "Ana (u-ana2)"
    // Comprobamos que el parser mapea ambos correctamente.
    const raw = JSON.stringify({
      weekStart: '2026-03-09',
      lines: [
        { employee: 'Ana (u-ana1)', days: { '2026-03-09': 'Diurno' } },
        { employee: 'Ana (u-ana2)', days: { '2026-03-09': 'rest' } },
      ],
    });
    const service = new LLMLineProposerService(fakeLLM(raw));
    const result = await service.proposeLines({
      employees: emps,
      slots,
      semanticRules: [],
      weekStart: new Date('2026-03-09T00:00:00Z'),
    });
    expect(result.size).toBe(2);
    expect(result.get('u-ana1-aaaaaaaa')?.['2026-03-09']).toBe('tpl-d');
    expect(result.get('u-ana2-bbbbbbbb')?.['2026-03-09']).toBe('rest');
  });
});
