/**
 * ShiftTemplateBreak — Domain Aggregate
 *
 * Default de break para un shift template. Tiempos RELATIVOS al inicio
 * del shift — el template no conoce la fecha concreta, así que guarda
 * "offset desde el start + duración" en minutos.
 *
 * Cuando se crea un assignment desde el template, el creator
 * materializa estos defaults a tiempos absolutos (startTime =
 * actualStartTime + offset, endTime = startTime + duration) y los
 * persiste como `ShiftAssignmentBreak`. Si el manager edita los
 * breaks del assignment, NO se propagan back al template — los
 * defaults siguen como originales.
 */
export class ShiftTemplateBreak {
  private constructor(
    public readonly id: string,
    public readonly templateId: string,
    public readonly companyId: string,
    /** Minutos desde el inicio del shift. >= 0. */
    public readonly startOffsetMinutes: number,
    /** Duración del break en minutos. > 0. */
    public readonly durationMinutes: number,
    public readonly isPaid: boolean,
    public readonly reason: string | null,
    public readonly createdAt: Date,
  ) {
    if (startOffsetMinutes < 0) {
      throw new Error(
        'ShiftTemplateBreak.startOffsetMinutes must be >= 0',
      );
    }
    if (durationMinutes <= 0) {
      throw new Error(
        'ShiftTemplateBreak.durationMinutes must be > 0',
      );
    }
  }

  static create(params: {
    id: string;
    templateId: string;
    companyId: string;
    startOffsetMinutes: number;
    durationMinutes: number;
    isPaid?: boolean;
    reason?: string | null;
    createdAt?: Date;
  }): ShiftTemplateBreak {
    return new ShiftTemplateBreak(
      params.id,
      params.templateId,
      params.companyId,
      params.startOffsetMinutes,
      params.durationMinutes,
      params.isPaid ?? false,
      params.reason ?? null,
      params.createdAt ?? new Date(),
    );
  }

  /** Resuelve los tiempos absolutos del break dado el `shiftStart` del
   * assignment. El caller usa esto para crear el `ShiftAssignmentBreak`
   * concreto al instanciar un assignment desde el template. */
  resolveAbsoluteTimes(shiftStart: Date): { startTime: Date; endTime: Date } {
    const startTime = new Date(
      shiftStart.getTime() + this.startOffsetMinutes * 60_000,
    );
    const endTime = new Date(
      startTime.getTime() + this.durationMinutes * 60_000,
    );
    return { startTime, endTime };
  }
}
