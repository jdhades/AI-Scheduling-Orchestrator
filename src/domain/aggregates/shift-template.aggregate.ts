import { randomUUID } from 'crypto';
import { Shift, SkillLevel } from './shift.aggregate';
import { DemandWeight } from '../value-objects/demand-weight.vo';
import { UndesirableWeight } from '../value-objects/undesirable-weight.vo';

export interface CreateShiftTemplateProps {
  id: string;
  companyId: string;
  name: string;
  dayOfWeek: number; // 0=Sun, 1=Mon … 6=Sat
  startTime: string; // "HH:MM" UTC time-of-day
  endTime: string; // "HH:MM" UTC time-of-day
  requiredSkillId: string | null;
  requiredSkillLevel: SkillLevel;
  requiredExperienceMonths: number;
  demandScore: DemandWeight;
  undesirableWeight: UndesirableWeight;
  isActive: boolean;
}

/**
 * ShiftTemplate — Domain Aggregate
 *
 * Represents a *recurring* shift definition that is NOT tied to any specific date.
 * Templates are managed by the company and cover a particular day-of-week + time window.
 *
 * The key domain method is `instantiateForWeek(weekStart)`, which produces a concrete
 * `Shift` object for the ISO-week that starts on `weekStart` (must be a Monday).
 *
 * Architecture note: templates are separate from shifts so that:
 *   1. Managers define shift rules once and reuse them across weeks.
 *   2. The AI/heuristic engine always operates on concrete `Shift` instances.
 *   3. Future changes to a template don't retroactively mutate past schedules.
 */
export class ShiftTemplate {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    public readonly name: string,
    public readonly dayOfWeek: number,
    public readonly startTime: string,
    public readonly endTime: string,
    public readonly requiredSkillId: string | null,
    public readonly requiredSkillLevel: SkillLevel,
    public readonly requiredExperienceMonths: number,
    public readonly demandScore: DemandWeight,
    public readonly undesirableWeight: UndesirableWeight,
    public readonly isActive: boolean,
  ) {
    if (dayOfWeek < 0 || dayOfWeek > 6) {
      throw new Error(`Invalid dayOfWeek: ${dayOfWeek}. Must be 0–6.`);
    }
  }

  static create(props: CreateShiftTemplateProps): ShiftTemplate {
    return new ShiftTemplate(
      props.id,
      props.companyId,
      props.name,
      props.dayOfWeek,
      props.startTime,
      props.endTime,
      props.requiredSkillId,
      props.requiredSkillLevel,
      props.requiredExperienceMonths,
      props.demandScore,
      props.undesirableWeight,
      props.isActive,
    );
  }

  static fromPersistence(props: CreateShiftTemplateProps): ShiftTemplate {
    return ShiftTemplate.create(props);
  }

  /**
   * Instantiates a concrete `Shift` for the week that starts on `weekMondayUtc`.
   *
   * Algorithm:
   *   1. Determine the concrete calendar date of `this.dayOfWeek` within the given week.
   *      - weekMondayUtc corresponds to dayOfWeek=1 (Monday)
   *      - For dayOfWeek=0 (Sunday) we interpret it as the Sunday *ending* the week (+6 days)
   *   2. Combine that date with `startTime` / `endTime` strings to build UTC DateTimes.
   *   3. Return a new `Shift` with a fresh UUID and `templateId = this.id`.
   *
   * @param weekMondayUtc  A `Date` set exactly to the Monday (00:00:00 UTC) of the target week.
   */
  instantiateForWeek(weekMondayUtc: Date): Shift {
    // Step 1: offset from Monday to the correct day (Monday=1, Sun=0)
    // We treat Sunday as the end of the week (Monday + 6 days).
    const daysFromMonday = this.dayOfWeek === 0 ? 6 : this.dayOfWeek - 1;

    // Use UTC math directly via Date.UTC to ensure we never cross Node timezone borders
    const year = weekMondayUtc.getUTCFullYear();
    const month = weekMondayUtc.getUTCMonth();
    const date = weekMondayUtc.getUTCDate() + daysFromMonday;
    
    // Step 2: Extract hours and minutes
    const [startH, startM] = this.startTime.split(':').map(Number);
    const [endH, endM] = this.endTime.split(':').map(Number);

    // Build the specific UTC timestamp cleanly
    const startDateTime = new Date(Date.UTC(year, month, date, startH, startM, 0, 0));
    const endDateTime = new Date(Date.UTC(year, month, date, endH, endM, 0, 0));

    // Handle midnight overlap or edge cases
    if (endH === 0 || (endH === 23 && endM === 59)) {
      endDateTime.setUTCDate(endDateTime.getUTCDate() + 1);
      endDateTime.setUTCHours(0, 0, 0, 0);
    }

    if (endDateTime <= startDateTime) {
      endDateTime.setUTCDate(endDateTime.getUTCDate() + 1);
    }

    return Shift.create({
      id: randomUUID(),
      companyId: this.companyId,
      startTime: startDateTime,
      endTime: endDateTime,
      requiredSkillId: this.requiredSkillId,
      requiredSkillLevel: this.requiredSkillLevel,
      requiredExperienceMonths: this.requiredExperienceMonths,
      demandScore: this.demandScore,
      undesirableWeight: this.undesirableWeight,
      templateId: this.id,
    });
  }

  /** Returns a new template with `isActive = false` without mutating the original. */
  deactivate(): ShiftTemplate {
    return ShiftTemplate.create({ ...this.toProps(), isActive: false });
  }

  private toProps(): CreateShiftTemplateProps {
    return {
      id: this.id,
      companyId: this.companyId,
      name: this.name,
      dayOfWeek: this.dayOfWeek,
      startTime: this.startTime,
      endTime: this.endTime,
      requiredSkillId: this.requiredSkillId,
      requiredSkillLevel: this.requiredSkillLevel,
      requiredExperienceMonths: this.requiredExperienceMonths,
      demandScore: this.demandScore,
      undesirableWeight: this.undesirableWeight,
      isActive: this.isActive,
    };
  }
}
