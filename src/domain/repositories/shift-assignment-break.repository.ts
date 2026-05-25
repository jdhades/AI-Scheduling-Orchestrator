import type { ShiftAssignmentBreak } from '../aggregates/shift-assignment-break.aggregate';

export const SHIFT_ASSIGNMENT_BREAK_REPOSITORY = Symbol(
  'SHIFT_ASSIGNMENT_BREAK_REPOSITORY',
);

/**
 * IShiftAssignmentBreakRepository — port para persistir y consultar
 * breaks intra-shift. RLS en backend filtra por company_id; el caller
 * pasa companyId redundante para que la query siempre lo incluya
 * explícito (defensive, evita asumir contexto).
 */
export interface IShiftAssignmentBreakRepository {
  /** Upsert por id. */
  save(brk: ShiftAssignmentBreak): Promise<void>;

  /** Borra un break puntual. */
  deleteById(id: string, companyId: string): Promise<void>;

  /** Borra todos los breaks de un assignment. Usado por el cascade
   * lógico cuando el assignment se borra fuera del DB CASCADE (ej.
   * desde el service que orquesta side-effects). */
  deleteByAssignmentId(assignmentId: string, companyId: string): Promise<void>;

  /** Lista los breaks de un assignment, ordenados por startTime ASC. */
  findByAssignmentId(
    assignmentId: string,
    companyId: string,
  ): Promise<ShiftAssignmentBreak[]>;

  /** Lista breaks de varios assignments en un solo round-trip — útil
   * para hidratar la grilla sin N+1 queries. */
  findByAssignmentIds(
    assignmentIds: string[],
    companyId: string,
  ): Promise<ShiftAssignmentBreak[]>;

  /** Encuentra un break por id (para PATCH/DELETE con auth check). */
  findById(id: string, companyId: string): Promise<ShiftAssignmentBreak | null>;
}
