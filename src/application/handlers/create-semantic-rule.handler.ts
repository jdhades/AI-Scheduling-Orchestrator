import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateSemanticRuleCommand } from '../commands/create-semantic-rule.command';
import { SemanticRuleAggregate } from '../../domain/aggregates/semantic-rule.aggregate';
import { RulePriority } from '../../domain/value-objects/rule-priority.vo';
import { RuleType } from '../../domain/value-objects/rule-type.vo';
import { SemanticRuleCreatedEvent } from '../../domain/events/semantic-rule-created.event';
import type { IEmbeddingService } from '../../domain/services/embedding.service.interface';
import type { ISemanticRuleRepository } from '../../domain/repositories/semantic-rule.repository.interface';
import { EMBEDDING_SERVICE_TOKEN } from '../../domain/services/embedding.service.interface';
import { SEMANTIC_RULE_REPOSITORY_TOKEN } from '../../domain/repositories/semantic-rule.repository.interface';
import { RuleStructureExtractor } from '../../domain/services/rule-structure-extractor.service';

export interface CreateSemanticRuleResult {
  id: string;
  embeddingGenerated: boolean;
  /** true when the rule was NOT persisted because a near-duplicate already exists */
  isDuplicate: boolean;
  /** UUID of the existing rule that is semantically equivalent (only set when isDuplicate=true) */
  duplicateOfId?: string;
  /** true si el LLM pudo extraer estructura — falso si falló o la marcó como complex */
  structureExtracted: boolean;
  /** Intent resuelto por el LLM (block, permit-multi-shift, preference, complex) o undefined */
  intent?: string;
}

/**
 * CreateSemanticRuleHandler — Command Handler
 *
 * Flujo:
 *   1. Crear SemanticRuleAggregate (valida texto, prioridad, tipo)
 *   2. Generar embedding via IEmbeddingService
 *   2.5 Verificar duplicado semántico (distancia coseno < DEDUP_DISTANCE_THRESHOLD)
 *       → Si duplicado: retornar sin persistir {isDuplicate: true}
 *   3. Persistir en pgvector via ISemanticRuleRepository
 *   4. Publicar SemanticRuleCreatedEvent al EventBus
 */
@CommandHandler(CreateSemanticRuleCommand)
export class CreateSemanticRuleHandler implements ICommandHandler<
  CreateSemanticRuleCommand,
  CreateSemanticRuleResult
> {
  private readonly logger = new Logger(CreateSemanticRuleHandler.name);

  /**
   * Umbral de distancia coseno para considerar dos reglas duplicadas semánticamente.
   * - 0.00 = texto idéntico
   * - 0.12 = paráfrasis directas (elegido conservadoramente para evitar falsos positivos)
   * - 0.35 = umbral de retrieval (relevancia para scheduling)
   */
  private static readonly DEDUP_DISTANCE_THRESHOLD = 0.12;

  constructor(
    @Inject(EMBEDDING_SERVICE_TOKEN)
    private readonly embeddingService: IEmbeddingService,
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
    private readonly eventBus: EventBus,
    private readonly structureExtractor: RuleStructureExtractor,
  ) {}

  async execute(
    command: CreateSemanticRuleCommand,
  ): Promise<CreateSemanticRuleResult> {
    const id = randomUUID();

    this.logger.log(
      `Creating semantic rule — company=${command.companyId} priority=${command.priorityLevel} type=${command.ruleType}`,
    );

    // 1. Crear aggregate (valida invariantes de dominio)
    const rule = SemanticRuleAggregate.create({
      id,
      ruleText: command.ruleText,
      priority: RulePriority.create(command.priorityLevel),
      ruleType: RuleType.create(command.ruleType),
      companyId: command.companyId,
      createdBy: command.createdBy,
      metadata: command.metadata,
      expiresAt: command.expiresAt ?? null,
      branchId: command.branchId ?? undefined,
      departmentId: command.departmentId ?? undefined,
    });

    // 2. Generar embedding (puede fallar si la API está caída)
    let embeddingGenerated = false;
    let vector: number[] | null = null;
    try {
      vector = await this.embeddingService.generate(command.ruleText);
      rule.setEmbedding(vector);
      embeddingGenerated = true;
    } catch (error) {
      // La regla se persiste sin embedding — puede re-procesarse después
      this.logger.warn(
        `CreateSemanticRuleHandler: embedding generation failed, rule saved without vector. Error: ${(error as Error).message}`,
      );
    }

    // 2.5 Verificar duplicado semántico (solo si tenemos embedding)
    if (vector !== null) {
      try {
        const nearDuplicates = await this.ruleRepository.findRelevantRules(
          vector,
          command.companyId,
          command.branchId ?? undefined,
          command.departmentId ?? undefined,
          1, // solo necesitamos el más cercano
        );

        if (
          nearDuplicates.length > 0 &&
          nearDuplicates[0].distance < CreateSemanticRuleHandler.DEDUP_DISTANCE_THRESHOLD
        ) {
          const existing = nearDuplicates[0].rule;
          this.logger.warn(
            `CreateSemanticRuleHandler: duplicate detected — new rule is too similar to existing ` +
            `rule ${existing.getId()} (distance=${nearDuplicates[0].distance.toFixed(4)}). Rule NOT persisted.`,
          );
          return {
            id: existing.getId(),
            embeddingGenerated: false,
            isDuplicate: true,
            duplicateOfId: existing.getId(),
            structureExtracted: existing.hasStructure(),
            intent: existing.getStructure()?.intent,
          };
        }
      } catch (error) {
        // Si la búsqueda de duplicados falla, continuamos con la creación
        // (mejor un falso negativo que bloquear la operación)
        this.logger.warn(
          `CreateSemanticRuleHandler: duplicate check failed, proceeding with creation. Error: ${(error as Error).message}`,
        );
      }
    }

    // 2.6 Extraer estructura con LLM (analiza el texto UNA vez y guarda el resultado)
    const structure = await this.structureExtractor.extract({
      ruleText: command.ruleText,
    });
    if (structure) {
      rule.setStructure(structure);
    } else {
      this.logger.warn(
        `CreateSemanticRuleHandler: structure extraction failed for "${command.ruleText.substring(0, 60)}" — rule saved without structure. Manager debe revisar si se aplica bien.`,
      );
    }

    // 3. Persistir
    await this.ruleRepository.save(rule);

    // 4. Publicar evento de dominio
    this.eventBus.publish(
      new SemanticRuleCreatedEvent(
        rule.getId(),
        rule.getCompanyId(),
        rule.getRuleText(),
        rule.getPriority().getValue(),
        rule.getRuleType().getValue(),
        rule.getCreatedAt(),
      ),
    );

    this.logger.log(
      `Semantic rule created — id=${id} embeddingGenerated=${embeddingGenerated} structureExtracted=${structure !== null} intent=${structure?.intent ?? 'n/a'}`,
    );
    return {
      id,
      embeddingGenerated,
      isDuplicate: false,
      structureExtracted: structure !== null,
      intent: structure?.intent,
    };
  }
}
