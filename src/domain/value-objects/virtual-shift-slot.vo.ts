/**
 * VirtualShiftSlot — Value Object (in-memory only)
 *
 * Representa una instancia de shift_template materializada para una fecha
 * concreta. NO se persiste en BD: se construye al generar el horario tomando
 * los templates activos del tenant + el rango de fechas de la semana.
 *
 * Reemplaza conceptualmente a la vieja aggregate `Shift` (que sí se persistía
 * en la tabla `shifts`, ya eliminada).
 */
export class VirtualShiftSlot {
  private constructor(
    public readonly templateId: string,
    public readonly companyId: string,
    public readonly date: string, // "YYYY-MM-DD"
    public readonly startTime: Date, // instante absoluto (template.start_time sobre date)
    public readonly endTime: Date,
    public readonly templateName: string,
    public readonly requiredSkillId: string | null,
    public readonly requiredEmployees: number | null, // null = elástico
    public readonly demandScore: number,
    public readonly undesirableWeight: number,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`VirtualShiftSlot.date must be YYYY-MM-DD, got: ${date}`);
    }
    if (endTime <= startTime) {
      throw new Error('VirtualShiftSlot: endTime must be after startTime');
    }
  }

  static create(props: {
    templateId: string;
    companyId: string;
    date: string;
    startTime: Date;
    endTime: Date;
    templateName: string;
    requiredSkillId?: string | null;
    requiredEmployees?: number | null;
    demandScore?: number;
    undesirableWeight?: number;
  }): VirtualShiftSlot {
    return new VirtualShiftSlot(
      props.templateId,
      props.companyId,
      props.date,
      props.startTime,
      props.endTime,
      props.templateName,
      props.requiredSkillId ?? null,
      props.requiredEmployees ?? null,
      props.demandScore ?? 1.0,
      props.undesirableWeight ?? 0.0,
    );
  }

  /** Identificador estable derivado: "{templateId}|{date}". No persistido. */
  get slotKey(): string {
    return `${this.templateId}|${this.date}`;
  }

  /** Duración del slot en horas. */
  getDuration(): number {
    return (this.endTime.getTime() - this.startTime.getTime()) / (1000 * 60 * 60);
  }

  /** ¿Este slot cae en fin de semana (sábado o domingo UTC)? */
  isWeekendShift(): boolean {
    const day = this.startTime.getUTCDay();
    return day === 0 || day === 6;
  }

  /** ¿Empieza de noche (22:00–06:00 UTC)? */
  isNightShift(): boolean {
    const hour = this.startTime.getUTCHours();
    return hour >= 22 || hour < 6;
  }

  overlapsWith(other: { startTime: Date; endTime: Date }): boolean {
    return this.startTime < other.endTime && other.startTime < this.endTime;
  }

  /** Slot opcional (null) o con cuota obligatoria (número). */
  get isMandatory(): boolean {
    return this.requiredEmployees !== null && this.requiredEmployees > 0;
  }
}
