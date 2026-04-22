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

  it('nombres duplicados se desambiguan con sufijo `Name-xxxxxx` del UUID', async () => {
    // Dos empleados con el mismo nombre "Ana", IDs hex (como los UUIDs reales).
    const emps = [
      makeEmployee('a1b2c3d4-1111-2222-3333-444455556666', 'Ana'),
      makeEmployee('d4e5f607-aaaa-bbbb-cccc-ddddeeeeffff', 'Ana'),
    ];
    const slots = [
      makeSlot('a0b0c0d0-1111-1111-1111-111111111111', 'Diurno', '2026-03-09'),
    ];
    // El LLM, viendo "Ana-556666" y "Ana-eeffff" en el prompt, debe devolverlos
    // así. El parser hace match por sufijo de 6 chars hex (últimos 6 del UUID).
    const raw = JSON.stringify({
      weekStart: '2026-03-09',
      lines: [
        { employee: 'Ana-556666', days: { '2026-03-09': 'Diurno-111111' } },
        { employee: 'Ana-eeffff', days: { '2026-03-09': 'rest' } },
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
    expect(result.get('a1b2c3d4-1111-2222-3333-444455556666')?.['2026-03-09']).toBe(
      'a0b0c0d0-1111-1111-1111-111111111111',
    );
    expect(result.get('d4e5f607-aaaa-bbbb-cccc-ddddeeeeffff')?.['2026-03-09']).toBe('rest');
  });

  it('si el LLM dropea el sufijo en un nombre ambiguo, la línea se descarta + warning', async () => {
    const emps = [
      makeEmployee('a1b2c3d4-1111-2222-3333-444455556666', 'Ana'),
      makeEmployee('d4e5f607-aaaa-bbbb-cccc-ddddeeeeffff', 'Ana'),
    ];
    const slots = [
      makeSlot('a0b0c0d0-1111-1111-1111-111111111111', 'Diurno', '2026-03-09'),
    ];
    const raw = JSON.stringify({
      weekStart: '2026-03-09',
      lines: [{ employee: 'Ana', days: { '2026-03-09': 'Diurno-111111' } }],
    });
    const service = new LLMLineProposerService(fakeLLM(raw));
    const result = await service.proposeLines({
      employees: emps,
      slots,
      semanticRules: [],
      weekStart: new Date('2026-03-09T00:00:00Z'),
    });
    expect(result.size).toBe(0);
  });
});
