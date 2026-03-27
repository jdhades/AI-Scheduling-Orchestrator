import { Injectable, Logger, Inject } from '@nestjs/common';
import type { IEmbeddingService } from './embedding.service.interface';
import { EMBEDDING_SERVICE_TOKEN } from './embedding.service.interface';
import type { ISemanticRuleRepository } from '../repositories/semantic-rule.repository.interface';
import { SEMANTIC_RULE_REPOSITORY_TOKEN } from '../repositories/semantic-rule.repository.interface';
import { ConflictResolutionEngine } from './conflict-resolution.engine';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';

/**
 * SemanticRetrievalService — Domain Service
 *
 * Puente entre el motor RAG y el Scheduling Engine.
 *
 * Flujo:
 *   1. Recibe el contexto del turno (texto, fecha, empresa)
 *   2. Convierte ese contexto en un embedding
 *   3. Recupera las top-K reglas más relevantes del pgvector
 *   4. Filtra por umbral de distancia coseno (< 0.35 = relevante)
 *   5. Resuelve conflictos entre reglas via ConflictResolutionEngine
 *   6. Retorna SemanticConstraint[] compatibles con las 3 strategies del E2
 *
 * Resiliencia: si la API de Gemini falla, retorna [] en lugar de bloquear
 * la generación de schedules. El scheduling sigue funcionando sin RAG.
 */
@Injectable()
export class SemanticRetrievalService {
  private readonly logger = new Logger(SemanticRetrievalService.name);

  /** Distancia coseno máxima para considerar una regla relevante (0 = idéntico, 2 = opuesto) */
  static readonly DISTANCE_THRESHOLD = 0.35;

  /** Número máximo de reglas candidatas a recuperar antes de filtrar */
  static readonly TOP_K = 15;

  constructor(
    @Inject(EMBEDDING_SERVICE_TOKEN)
    private readonly embeddingService: IEmbeddingService,
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
    private readonly conflictEngine: ConflictResolutionEngine,
  ) {}

  /**
   * Recupera restricciones semánticas relevantes para un contexto de turno dado.
   *
   * @param shiftContext   Descripción del turno (ej. "turno viernes noche cierre")
   * @param companyId      UUID de la empresa (tenant isolation)
   * @param shiftDate      Fecha del turno (para enriquecer el contexto)
   * @returns              SemanticConstraint[] listos para las Strategies del E2
   */
  async retrieveForShift(params: {
    shiftContext: string;
    companyId: string;
    shiftDate: Date;
  }): Promise<SemanticConstraint[]> {
    if (!params.shiftContext?.trim() || !params.companyId) {
      return [];
    }

    try {
      // 1. Construir prompt de contexto enriquecido
      const contextPrompt = this.buildContextPrompt(
        params.shiftContext,
        params.shiftDate,
      );

      // 2. Generar embedding del contexto
      const queryVector = await this.embeddingService.generate(contextPrompt);

      // 3. Recuperar candidatos del pgvector
      const candidates = await this.ruleRepository.findRelevantRules(
        queryVector,
        params.companyId,
        SemanticRetrievalService.TOP_K,
      );

      // 4. Filtrar por umbral de relevancia
      const relevant = candidates
        .filter((c) => c.distance < SemanticRetrievalService.DISTANCE_THRESHOLD)
        .map((c) => c.rule);

      if (relevant.length === 0) {
        this.logger.log(
          `SemanticRetrievalService: no relevant rules found for context "${contextPrompt.substring(0, 60)}"`,
        );
        return [];
      }

      // 5. Resolver conflictos entre reglas
      const resolved = this.conflictEngine.resolveRules(relevant);

      this.logger.log(
        `SemanticRetrievalService: ${candidates.length} candidates → ${relevant.length} relevant → ${resolved.length} after conflict resolution`,
      );

      // 6. Convertir al contrato SemanticConstraint del E2
      return resolved.map((rule) => ({
        rule: rule.getRuleText(),
        weight: this.priorityToWeight(rule.getPriority().getValue()),
        employeeId: undefined,
        shiftId: undefined,
      }));
    } catch (error) {
      // Resiliencia: el scheduling no se bloquea si el RAG falla
      this.logger.warn(
        `SemanticRetrievalService: failed to retrieve rules (scheduling continues without RAG). Error: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Construye un prompt de contexto enriquecido con información del turno.
   * El enriquecimiento mejora la calidad de la búsqueda semántica.
   */
  private buildContextPrompt(shiftContext: string, date: Date): string {
    const dayName = date.toLocaleDateString('es-ES', { weekday: 'long' });
    const hour = date.getHours();
    const timeOfDay =
      hour >= 22 || hour < 6 ? 'noche' : hour < 12 ? 'mañana' : 'tarde';

    return `Turno de trabajo: ${shiftContext}. Día: ${dayName}. Horario: ${timeOfDay}.`;
  }

  /**
   * Convierte el nivel de prioridad al campo `weight` del contrato SemanticConstraint.
   * Priority 1 (legal) → weight 3 (máximo)
   * Priority 2 (semantic) → weight 2
   * Priority 3 (preference) → weight 1 (mínimo)
   */
  private priorityToWeight(priorityLevel: number): number {
    return Math.max(1, 4 - priorityLevel);
  }
}
