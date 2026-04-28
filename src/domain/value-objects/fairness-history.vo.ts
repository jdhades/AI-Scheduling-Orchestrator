/**
 * FairnessHistoryVO — Value Object
 *
 * Encapsula el historial acumulado de carga de un empleado para una semana.
 * Usado por FairnessCalculator para computar el FairnessScore y por las
 * estrategias para ordenar candidatos por menor carga.
 *
 * Inmutable — cada operación devuelve un nuevo VO.
 */
export class FairnessHistoryVO {
  private constructor(
    public readonly employeeId: string,
    public readonly companyId: string,
    public readonly weekStart: Date,
    public readonly hoursWorked: number,
    public readonly undesirableCount: number,
    public readonly nightShiftCount: number,
    public readonly weekendCount: number,
    public readonly voluntaryExtraShifts: number,
  ) {}

  static create(props: {
    employeeId: string;
    companyId: string;
    weekStart: Date;
    hoursWorked?: number;
    undesirableCount?: number;
    nightShiftCount?: number;
    weekendCount?: number;
    voluntaryExtraShifts?: number;
  }): FairnessHistoryVO {
    return new FairnessHistoryVO(
      props.employeeId,
      props.companyId,
      props.weekStart,
      props.hoursWorked ?? 0,
      props.undesirableCount ?? 0,
      props.nightShiftCount ?? 0,
      props.weekendCount ?? 0,
      props.voluntaryExtraShifts ?? 0,
    );
  }

  static empty(
    employeeId: string,
    companyId: string,
    weekStart: Date,
  ): FairnessHistoryVO {
    return FairnessHistoryVO.create({ employeeId, companyId, weekStart });
  }

  /**
   * Score de fairness según la fórmula determinística del FairnessCalculator:
   *   (undesirableCount × 2.0) + (nightShiftCount × 1.5) + (weekendCount × 1.2)
   *   - (voluntaryExtraShifts × 0.5)
   *
   * Devuelve el raw score (sin normalizar a 0–1000).
   */
  computeRawScore(): number {
    return (
      this.undesirableCount * 2.0 +
      this.nightShiftCount * 1.5 +
      this.weekendCount * 1.2 -
      this.voluntaryExtraShifts * 0.5
    );
  }

  /**
   * Devuelve un nuevo historial registrando la adición de un turno.
   */
  addShift(
    hoursWorked: number,
    opts: {
      isUndesirable: boolean;
      isNight: boolean;
      isWeekend: boolean;
      isVoluntary?: boolean;
    },
  ): FairnessHistoryVO {
    return new FairnessHistoryVO(
      this.employeeId,
      this.companyId,
      this.weekStart,
      this.hoursWorked + hoursWorked,
      this.undesirableCount + (opts.isUndesirable ? 1 : 0),
      this.nightShiftCount + (opts.isNight ? 1 : 0),
      this.weekendCount + (opts.isWeekend ? 1 : 0),
      this.voluntaryExtraShifts + (opts.isVoluntary ? 1 : 0),
    );
  }
}
