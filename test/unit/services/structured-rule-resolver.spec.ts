import { StructuredRuleResolver } from '../../../src/domain/services/structured-rule-resolver.service';
import { SemanticRuleAggregate } from '../../../src/domain/aggregates/semantic-rule.aggregate';
import { RulePriority } from '../../../src/domain/value-objects/rule-priority.vo';
import { RuleType } from '../../../src/domain/value-objects/rule-type.vo';
import { VirtualShiftSlot } from '../../../src/domain/value-objects/virtual-shift-slot.vo';
import { Employee } from '../../../src/domain/aggregates/employee.aggregate';
import { PhoneNumber } from '../../../src/domain/value-objects/phone-number.vo';
import { ExperienceLevel } from '../../../src/domain/value-objects/experience-level.vo';

const COMPANY = 'co-1';

function makeRule(text: string, structure: any): SemanticRuleAggregate {
  const rule = SemanticRuleAggregate.create({
    id: `r-${text.slice(0, 10)}`,
    ruleText: text,
    priority: RulePriority.create(2),
    ruleType: RuleType.create('restriction'),
    companyId: COMPANY,
  });
  rule.setStructure(structure);
  return rule;
}

function makeEmployee(id: string, name: string): Employee {
  return Employee.fromPersistence({
    id,
    companyId: COMPANY,
    name,
    role: 'employee',
    phoneNumber: PhoneNumber.create('+34612345678'),
    experience: new ExperienceLevel(12, { junior: 6, intermediate: 24, senior: 999 }),
  });
}

function makeSlot(props: {
  templateId: string;
  date: string;
  startHour: number;
  endHour: number;
  name?: string;
}): VirtualShiftSlot {
  const start = new Date(`${props.date}T${String(props.startHour).padStart(2, '0')}:00:00Z`);
  let end = new Date(`${props.date}T${String(props.endHour).padStart(2, '0')}:00:00Z`);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return VirtualShiftSlot.create({
    templateId: props.templateId,
    companyId: COMPANY,
    date: props.date,
    startTime: start,
    endTime: end,
    templateName: props.name ?? 'Generic',
  });
}

describe('StructuredRuleResolver (virtual slots)', () => {
  const svc = new StructuredRuleResolver();

  it('resolves iso-date block to slots of that day', () => {
    const slot13 = makeSlot({ templateId: 't1', date: '2026-04-13', startHour: 10, endHour: 16 });
    const slot14 = makeSlot({ templateId: 't1', date: '2026-04-14', startHour: 10, endHour: 16 });
    const rule = makeRule('feriado 13/4', {
      intent: 'block',
      employeeMatchers: [{ type: 'all' }],
      dateMatchers: [{ type: 'iso-date', value: '2026-04-13' }],
    });
    const out = svc.resolve([rule], [], [slot13, slot14]);
    expect(out.constraints).toHaveLength(1);
    expect(out.constraints[0].shiftId).toBe(slot13.slotKey);
    expect(out.constraints[0].employeeId).toBe('*');
  });

  it('resolves shiftNameMatchers via case-insensitive substring on template name', () => {
    const morning = makeSlot({ templateId: 'ta', date: '2026-04-13', startHour: 6, endHour: 14, name: 'Apertura Cocina' });
    const evening = makeSlot({ templateId: 'tb', date: '2026-04-13', startHour: 14, endHour: 22, name: 'Cierre Cocina' });
    const rule = makeRule('Juan no hace apertura', {
      intent: 'block',
      employeeMatchers: [{ type: 'name', value: 'Juan' }],
      dateMatchers: [],
      shiftNameMatchers: ['apertura'],
    });
    const out = svc.resolve(
      [rule],
      [makeEmployee('e1', 'Juan Pérez')],
      [morning, evening],
    );
    expect(out.constraints).toHaveLength(1);
    expect(out.constraints[0].shiftId).toBe(morning.slotKey);
    expect(out.constraints[0].employeeId).toBe('e1');
  });

  it('resolves hourRangeMatchers with midnight-crossing range', () => {
    const evening = makeSlot({ templateId: 'day', date: '2026-04-13', startHour: 10, endHour: 16 });
    const night = makeSlot({ templateId: 'night', date: '2026-04-13', startHour: 22, endHour: 6 });
    const earlyMorning = makeSlot({ templateId: 'dawn', date: '2026-04-13', startHour: 4, endHour: 10 });
    const rule = makeRule('Pedro not overnight', {
      intent: 'block',
      employeeMatchers: [{ type: 'name', value: 'Pedro' }],
      dateMatchers: [],
      hourRangeMatchers: [{ start: '22:00', end: '06:00' }],
    });
    const out = svc.resolve(
      [rule],
      [makeEmployee('e1', 'Pedro')],
      [evening, night, earlyMorning],
    );
    // Debería matchear night (22:00) y earlyMorning (04:00), NO evening (10:00)
    expect(out.constraints.map((c) => c.shiftId).sort()).toEqual(
      [night.slotKey, earlyMorning.slotKey].sort(),
    );
  });

  it('marks rotating day-off rules as complex via safety net (>50% coverage)', () => {
    const slots = Array.from({ length: 14 }, (_, i) =>
      makeSlot({ templateId: `t${i}`, date: `2026-04-${13 + (i % 7)}`, startHour: 10, endHour: 16 }),
    );
    const rule = makeRule('Cada empleado un día libre', {
      intent: 'block',
      employeeMatchers: [{ type: 'all' }],
      dateMatchers: [
        { type: 'day-of-week', value: 'monday' },
        { type: 'day-of-week', value: 'tuesday' },
        { type: 'day-of-week', value: 'wednesday' },
        { type: 'day-of-week', value: 'thursday' },
        { type: 'day-of-week', value: 'friday' },
        { type: 'day-of-week', value: 'saturday' },
        { type: 'day-of-week', value: 'sunday' },
      ],
    });
    const out = svc.resolve([rule], [], slots);
    expect(out.constraints).toHaveLength(0);
    expect(out.complexRules).toHaveLength(1);
    expect(out.complexRules[0].reason).toMatch(/probablemente es una regla de distribución/);
  });

  it('generates permit-multi-shift for specific day', () => {
    const slot = makeSlot({ templateId: 't1', date: '2026-04-15', startHour: 10, endHour: 14 });
    const rule = makeRule('Maria doble turno 15/4', {
      intent: 'permit-multi-shift',
      employeeMatchers: [{ type: 'name', value: 'Maria' }],
      dateMatchers: [{ type: 'iso-date', value: '2026-04-15' }],
    });
    const out = svc.resolve([rule], [makeEmployee('e1', 'Maria')], [slot]);
    expect(out.multiShiftPermits.has('e1|2026-04-15')).toBe(true);
  });

  it('reports unstructured rules (no LLM analysis)', () => {
    const rule = SemanticRuleAggregate.create({
      id: 'r-unstructured',
      ruleText: 'something the LLM could not analyze yet',
      priority: RulePriority.create(2),
      ruleType: RuleType.create('restriction'),
      companyId: COMPANY,
    });
    // No setStructure → no structure
    const out = svc.resolve([rule], [], []);
    expect(out.unstructuredRules).toHaveLength(1);
    expect(out.constraints).toHaveLength(0);
  });

  it('passes through preference intent without generating constraints', () => {
    const slot = makeSlot({ templateId: 't1', date: '2026-04-13', startHour: 10, endHour: 16 });
    const rule = makeRule('Pedro prefiere mañanas', {
      intent: 'preference',
      employeeMatchers: [{ type: 'name', value: 'Pedro' }],
      dateMatchers: [],
    });
    const out = svc.resolve([rule], [makeEmployee('e1', 'Pedro')], [slot]);
    expect(out.constraints).toHaveLength(0);
    expect(out.complexRules).toHaveLength(0);
  });
});
