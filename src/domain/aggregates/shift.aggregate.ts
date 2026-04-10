import { DemandWeight } from '../value-objects/demand-weight.vo';
import { UndesirableWeight } from '../value-objects/undesirable-weight.vo';

export type SkillLevel = 'junior' | 'intermediate' | 'senior';

export interface CreateShiftProps {
  id: string;
  companyId: string;
  startTime: Date;
  endTime: Date;
  requiredSkillId: string | null;
  requiredSkillLevel: SkillLevel;
  requiredExperienceMonths: number;
  demandScore: DemandWeight;
  undesirableWeight: UndesirableWeight;
  templateId?: string | null; // Phase 2: traceability back to the originating template
  requiredEmployees?: number | null; // Phase 3: elastic capacity
}

/**
 * Shift — Domain Aggregate
 *
 * Representa un turno de trabajo con todas sus restricciones:
 * skill requerido, nivel mínimo, peso de demanda y de indeseabilidad.
 *
 * No extiende AggregateRoot porque los eventos los emite ScheduleAggregate.
 */
export class Shift {
  private constructor(
    public readonly id: string,
    public readonly companyId: string,
    private readonly _startTime: Date,
    private readonly _endTime: Date,
    public readonly requiredSkillId: string | null,
    public readonly requiredSkillLevel: SkillLevel,
    public readonly requiredExperienceMonths: number,
    public readonly demandScore: DemandWeight,
    public readonly undesirableWeight: UndesirableWeight,
    public readonly templateId: string | null = null,
    public readonly requiredEmployees: number | null = null,
  ) {
    if (_endTime <= _startTime) {
      throw new Error('Shift endTime must be after startTime');
    }
  }

  static create(props: CreateShiftProps): Shift {
    return new Shift(
      props.id,
      props.companyId,
      props.startTime,
      props.endTime,
      props.requiredSkillId,
      props.requiredSkillLevel,
      props.requiredExperienceMonths,
      props.demandScore,
      props.undesirableWeight,
      props.templateId ?? null,
      props.requiredEmployees ?? null,
    );
  }

  /**
   * Reconstituye el aggregate desde persistencia sin validar invariantes de negocio.
   */
  static fromPersistence(props: CreateShiftProps): Shift {
    return Shift.create(props);
  }

  get startTime(): Date {
    return new Date(this._startTime);
  }
  get endTime(): Date {
    return new Date(this._endTime);
  }

  /**
   * Duración en horas (puede ser decimal, e.g. 7.5h)
   */
  getDuration(): number {
    return (
      (this._endTime.getTime() - this._startTime.getTime()) / (1000 * 60 * 60)
    );
  }

  /**
   * Turno nocturno: comienza >= 22:00 o termina <= 06:00
   */
  isNightShift(): boolean {
    const startHour = this._startTime.getHours();
    const endHour = this._endTime.getHours();
    return startHour >= 22 || endHour <= 6;
  }

  /**
   * Turno de fin de semana: sábado (6) o domingo (0)
   */
  isWeekendShift(): boolean {
    const day = this._startTime.getDay();
    return day === 0 || day === 6;
  }

  requiresSkill(skillId: string): boolean {
    return this.requiredSkillId === skillId;
  }

  overlapsWith(other: Shift): boolean {
    return this._startTime < other._endTime && this._endTime > other._startTime;
  }
}
