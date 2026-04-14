import { ShiftSlotGeneratorService } from '../../../src/domain/services/shift-slot-generator.service';
import { ShiftTemplate } from '../../../src/domain/aggregates/shift-template.aggregate';
import { DemandWeight } from '../../../src/domain/value-objects/demand-weight.vo';
import { UndesirableWeight } from '../../../src/domain/value-objects/undesirable-weight.vo';

function makeTemplate(props: {
  id: string;
  name: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  required?: number | null;
}): ShiftTemplate {
  return ShiftTemplate.create({
    id: props.id,
    companyId: 'co-1',
    name: props.name,
    dayOfWeek: props.dayOfWeek,
    startTime: props.startTime,
    endTime: props.endTime,
    requiredSkillId: null,
    requiredSkillLevel: 'junior',
    requiredExperienceMonths: 0,
    demandScore: DemandWeight.create(1),
    undesirableWeight: UndesirableWeight.create(0),
    isActive: true,
    requiredEmployees: props.required ?? null,
  });
}

const MONDAY_2026_04_13 = new Date('2026-04-13T00:00:00.000Z');

describe('ShiftSlotGeneratorService', () => {
  const service = new ShiftSlotGeneratorService();

  it('emits a single slot for a template with a specific dayOfWeek', () => {
    const tpl = makeTemplate({
      id: 't1',
      name: 'Monday Morning',
      dayOfWeek: 1, // Monday
      startTime: '10:00',
      endTime: '16:00',
    });
    const slots = service.generateSlotsForWeek([tpl], MONDAY_2026_04_13);
    expect(slots).toHaveLength(1);
    expect(slots[0].date).toBe('2026-04-13');
    expect(slots[0].templateId).toBe('t1');
    expect(slots[0].templateName).toBe('Monday Morning');
    expect(slots[0].startTime.toISOString()).toBe('2026-04-13T10:00:00.000Z');
    expect(slots[0].endTime.toISOString()).toBe('2026-04-13T16:00:00.000Z');
  });

  it('emits slot for Sunday template at the END of the week (offset 6)', () => {
    const tpl = makeTemplate({
      id: 't-sun',
      name: 'Sunday Closing',
      dayOfWeek: 0, // Sunday
      startTime: '08:00',
      endTime: '14:00',
    });
    const slots = service.generateSlotsForWeek([tpl], MONDAY_2026_04_13);
    expect(slots).toHaveLength(1);
    expect(slots[0].date).toBe('2026-04-19'); // Sunday Apr 19
  });

  it('handles a night shift crossing midnight (end <= start)', () => {
    const tpl = makeTemplate({
      id: 't-night',
      name: 'Night',
      dayOfWeek: 1, // Monday
      startTime: '22:00',
      endTime: '06:00', // crosses midnight to Tuesday 06:00
    });
    const slots = service.generateSlotsForWeek([tpl], MONDAY_2026_04_13);
    expect(slots).toHaveLength(1);
    expect(slots[0].startTime.toISOString()).toBe('2026-04-13T22:00:00.000Z');
    expect(slots[0].endTime.toISOString()).toBe('2026-04-14T06:00:00.000Z');
    expect(slots[0].getDuration()).toBe(8);
  });

  it('emits slots in stable date+startTime order', () => {
    const morning = makeTemplate({
      id: 't-m',
      name: 'Morning',
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '16:00',
    });
    const night = makeTemplate({
      id: 't-n',
      name: 'Night',
      dayOfWeek: 2,
      startTime: '22:00',
      endTime: '06:00',
    });
    const tuesdayMorning = makeTemplate({
      id: 't-tm',
      name: 'Tue Morning',
      dayOfWeek: 2,
      startTime: '10:00',
      endTime: '16:00',
    });
    const slots = service.generateSlotsForWeek(
      [night, tuesdayMorning, morning], // unordered input
      MONDAY_2026_04_13,
    );
    expect(slots.map((s) => s.templateId)).toEqual(['t-m', 't-tm', 't-n']);
  });

  it('preserves requiredEmployees and demandScore from template', () => {
    const tpl = makeTemplate({
      id: 't-req',
      name: 'Mandatory',
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '16:00',
      required: 3,
    });
    const slots = service.generateSlotsForWeek([tpl], MONDAY_2026_04_13);
    expect(slots[0].requiredEmployees).toBe(3);
    expect(slots[0].isMandatory).toBe(true);
  });

  it('marks slot as optional when requiredEmployees is null', () => {
    const tpl = makeTemplate({
      id: 't-opt',
      name: 'Optional',
      dayOfWeek: 1,
      startTime: '10:00',
      endTime: '16:00',
      required: null,
    });
    const slots = service.generateSlotsForWeek([tpl], MONDAY_2026_04_13);
    expect(slots[0].requiredEmployees).toBeNull();
    expect(slots[0].isMandatory).toBe(false);
  });

  it('returns empty array when no templates given', () => {
    expect(service.generateSlotsForWeek([], MONDAY_2026_04_13)).toEqual([]);
  });
});
