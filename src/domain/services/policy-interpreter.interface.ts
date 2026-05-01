/**
 * PolicyInterpreter — Domain Service contract.
 *
 * Un interpreter "entiende" un patrón específico de política tenant-wide.
 * El registry mantiene un set de interpreters; cuando se crea una policy,
 * itera sobre ellos para ver si alguno puede manejar el texto en lenguaje
 * natural. Si matchea, extrae params estructurados y queda enchufado al
 * solver. Si no matchea ningún interpreter, la policy queda LLM-only y
 * solo se pasa al prompt de schedule generation/repair.
 *
 * Este abstracción es la clave del diseño "open + accelerators": el
 * manager nunca elige tipo. Los interpreters son optimizaciones backend.
 */

export const POLICY_INTERPRETERS_TOKEN = Symbol('POLICY_INTERPRETERS');

/** Una asignación que el solver propone (sub-set del schedule). */
export interface PolicyEvaluationShift {
  employeeId: string;
  /** ISO datetime UTC. */
  startTime: Date;
  /** ISO datetime UTC. */
  endTime: Date;
}

/** Contexto que recibe `apply` para evaluar el schedule contra la policy. */
export interface PolicyEvaluationContext {
  shifts: PolicyEvaluationShift[];
  /**
   * Set de fechas (YYYY-MM-DD) consideradas feriado por el tenant para el
   * período evaluado. El caller las inyecta — el interpreter no las
   * descubre por sí mismo.
   */
  holidayDates?: ReadonlySet<string>;
  /**
   * Phase 14.1 — metadata por empleado para resolver el scope de una
   * policy. Si está presente, `PolicyEnforcementService.evaluateLoaded`
   * filtra `shifts` antes de pasarlos al interpreter usando
   * `policy.isApplicableTo(meta)`. Si no está, una policy con scope !=
   * 'company' NO se puede evaluar y se reporta como warning (vuelve a
   * fiar al LLM en el prompt).
   */
  employeeMeta?: ReadonlyMap<
    string,
    { branchId: string | null; departmentId: string | null }
  >;
}

/** Una violación detectada por un interpreter al evaluar el schedule. */
export interface PolicyViolation {
  /** Empleado al que aplica (puede ser undefined si la política es global). */
  employeeId?: string;
  /** Fecha/clave temporal asociada (YYYY-MM-DD o ISO week, depende del interpreter). */
  scope?: string;
  message: string;
}

export interface PolicyInterpreter<TParams = Record<string, unknown>> {
  /** Identificador único y estable (se persiste en company_policies.interpreter_id). */
  readonly id: string;

  /** Descripción humana corta — usada en docs y en la UI de admin. */
  readonly description: string;

  /**
   * Si true, el interpreter NO se ofrece como sugerencia del rephrase
   * service (no tiene sentido proponerle al manager "reformulá hacia
   * llm_runtime"). Sigue siendo invocable por id desde el registry, solo
   * queda fuera de las listas públicas (`getAvailableIds()`).
   */
  readonly catchAll?: boolean;

  /**
   * ¿Este interpreter puede manejar este texto en lenguaje natural?
   * Implementación típica: heurística regex/keyword. NO llamar al LLM acá
   * (esto se evalúa para CADA policy creada; el registry hace una pasada
   * por todos los interpreters).
   */
  matches(text: string): boolean;

  /**
   * Extrae los params estructurados del texto. Solo se invoca si
   * `matches()` devolvió true. Puede usar el LLM internamente (vía
   * inyección en el constructor) cuando la heurística regex no es
   * suficiente.
   */
  extractParams(text: string): Promise<TParams>;

  /**
   * Aplica el constraint al schedule propuesto y devuelve la lista de
   * violaciones. Lista vacía = sin violaciones. La `severity` (hard/soft)
   * la maneja el solver, no el interpreter.
   *
   * Devuelve `Promise<>` para soportar interpreters que invocan al LLM en
   * runtime (catch-all `llm_runtime`). Los interpreters deterministas
   * pueden devolver con `Promise.resolve(...)` sin costo perceptible.
   */
  apply(
    ctx: PolicyEvaluationContext,
    params: TParams,
  ): Promise<PolicyViolation[]>;

  /**
   * Renderiza la policy a una línea en lenguaje natural en inglés —
   * usada en el prompt del LLM de la fase repair / hybrid. Esta línea
   * tiene que ser inequívoca para que el LLM la respete.
   */
  format(params: TParams): string;
}
