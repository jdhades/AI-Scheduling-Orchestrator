/**
 * GenerateHybridScheduleCommand
 *
 * Extiende el scheduling estándar con el modo "prompt-hybrid":
 * el LLM propone y el algoritmo verifica/corrige.
 *
 * Parámetros idénticos al GenerateScheduleCommand base:
 * reutilizamos los mismos DTOs y validaciones de companyId/weekStart.
 */
export class GenerateHybridScheduleCommand {
  constructor(
    public readonly companyId: string,
    public readonly weekStart: string, // ISO date 'YYYY-MM-DD'
    public readonly maxFairnessDeviation?: number,
    public readonly shiftTemplateId?: string,
    /** 2-letter locale for explanations/warnings ('es', 'en', ...). Default 'es'. */
    public readonly locale?: string,
  ) {}
}
