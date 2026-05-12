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
    /**
     * Si se setea, el handler filtra templates Y empleados al dado depto
     * (employee.departmentId === departmentId). Combinable con
     * `shiftTemplateId`: éste último restringe aún más a un template
     * concreto del mismo depto.
     */
    public readonly departmentId?: string,
    /**
     * Fase 3 — AbortSignal del job de pg-boss. Si el manager cancela
     * desde el panel mientras el job está `active`, el signal aborta
     * el fetch del LLM y el handler bail-outs limpio (libera lock,
     * salta DB writes, propaga cancelled al worker).
     *
     * Path síncrono lo deja undefined; cancel solo aplica al async.
     */
    public readonly signal?: AbortSignal,
    /**
     * Phase 4 — token de adquisición del lock. Permite release
     * race-safe: si el cancel pre-libera el lock y otro job lo toma
     * después, el handler viejo (al terminar tarde) NO borra el
     * nuevo. Para path async pasar `jobId`; para sync, undefined
     * → handler genera UUID.
     */
    public readonly lockToken?: string,
  ) {}
}
