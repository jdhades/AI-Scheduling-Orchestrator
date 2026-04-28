import { SemanticRuleAggregate } from '../aggregates/semantic-rule.aggregate';

/**
 * Resultado de una búsqueda semántica: el aggregate + la distancia coseno.
 * distance = 0: idénticos | distance = 2: completamente opuestos
 * Umbral recomendado: distance < 0.35 para considerar relevante.
 */
export interface SemanticRuleWithDistance {
  rule: SemanticRuleAggregate;
  distance: number;
}

/**
 * Patch para metadata de una SemanticRule — campos que NO requieren
 * re-embedding ni re-extracción de estructura. Para cambiar `rule_text`
 * usar el flujo dedicado (UpdateSemanticRuleTextCommand) que regenera
 * embedding y structure.
 */
export interface SemanticRuleMetadataPatch {
  priorityLevel?: number;
  isActive?: boolean;
  expiresAt?: Date | null;
  branchId?: string | null;
  departmentId?: string | null;
}

/**
 * ISemanticRuleRepository — Port (interface de dominio)
 *
 * Define el contrato de persistencia para reglas semánticas.
 * La implementación concreta (Supabase + pgvector) vive en infraestructura.
 */
export interface ISemanticRuleRepository {
  /**
   * Persiste o actualiza una regla semántica.
   * Usa upsert — si el id ya existe, actualiza.
   */
  save(rule: SemanticRuleAggregate): Promise<void>;

  /**
   * Busca una regla por ID filtrando por empresa (multi-tenant).
   * @returns null si no existe o pertenece a otra empresa
   */
  findById(
    id: string,
    companyId: string,
  ): Promise<SemanticRuleAggregate | null>;

  /**
   * Devuelve todas las reglas activas de una empresa, ordenadas por prioridad.
   */
  findAllByCompany(companyId: string): Promise<SemanticRuleAggregate[]>;

  /**
   * Búsqueda semántica por similitud coseno.
   * Retorna las top-K reglas activas más cercanas al queryVector.
   *
   * @param queryVector  Embedding del contexto del turno (768 dims)
   * @param companyId    Tenant isolation — solo busca en las reglas de esta empresa
   * @param topK         Número máximo de resultados (default: 10)
   */
  findRelevantRules(
    queryVector: number[],
    companyId: string,
    branchId?: string,
    departmentId?: string,
    topK?: number,
  ): Promise<SemanticRuleWithDistance[]>;

  /**
   * Actualiza metadata (priority, is_active, expires_at, branch/department scope).
   * NO toca rule_text ni embedding. Campos undefined no se tocan.
   */
  updateMetadata(
    id: string,
    companyId: string,
    patch: SemanticRuleMetadataPatch,
  ): Promise<void>;

  /**
   * Soft delete — marca la regla como inactiva + deleted_at=NOW().
   * Las reglas con deleted_at!=null no participan en findRelevantRules
   * ni listados.
   */
  softDelete(id: string, companyId: string): Promise<void>;
}

export const SEMANTIC_RULE_REPOSITORY_TOKEN = 'SEMANTIC_RULE_REPOSITORY';
