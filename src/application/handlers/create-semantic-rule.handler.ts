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
import {
  SEMANTIC_RULE_REPHRASE_SERVICE,
  type ISemanticRuleRephraseService,
} from '../../domain/services/semantic-rule-rephrase.service.interface';

/** Sugerencia de reformulación cuando intent=complex y el LLM tiene
 *  alternativas aplicables. Estructuralmente igual a la del policy
 *  rephrase, pero generada por el LLM contra el matcher schema de
 *  SemanticRule. */
export interface CreateSemanticRuleSuggestion {
  id: string;
  suggestedText: string;
  explanation: string;
  previewIntent?: string;
}

export interface CreateSemanticRuleResult {
  id: string;
  embeddingGenerated: boolean;
  /** true when the rule was NOT persisted because a near-duplicate already exists */
  isDuplicate: boolean;
  /** UUID of the existing rule that is semantically equivalent (only set when isDuplicate=true) */
  duplicateOfId?: string;
  /** true si el LLM pudo extraer estructura aplicable (intent != 'complex'). */
  structureExtracted: boolean;
  /** Intent resuelto por el LLM (block, permit-multi-shift, preference, complex) o undefined */
  intent?: string;
  /**
   * Si intent='complex' Y el LLM logró proponer reformulaciones, la
   * regla NO se persiste y `suggestions` trae las alternativas (el
   * frontend muestra el suggestion-loop). Si el LLM falló o no pudo
   * sugerir nada, la regla SE persiste como complex (comportamiento
   * histórico) y `suggestions` queda undefined.
   */
  suggestions?: CreateSemanticRuleSuggestion[];
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
    @Inject(SEMANTIC_RULE_REPHRASE_SERVICE)
    private readonly rephraseService: ISemanticRuleRephraseService,
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
          nearDuplicates[0].distance <
            CreateSemanticRuleHandler.DEDUP_DISTANCE_THRESHOLD
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

    // 2.7 Suggestion-loop: si el LLM marcó la regla como complex pero
    // structure existe, intentamos proponer reformulaciones aplicables.
    // Si el LLM logra sugerencias, NO persistimos — devolvemos las
    // suggestions y el manager re-submitea con el texto elegido.
    // Si el rephrase falla, fallback al comportamiento histórico
    // (persiste como complex con warning visible en la UI).
    if (structure && structure.intent === 'complex') {
      const suggestions = await this.rephraseService.suggest({
        originalText: command.ruleText,
        complexReason:
          structure.complexReason ?? 'La regla no se puede estructurar.',
      });
      if (suggestions.length > 0) {
        this.logger.log(
          `CreateSemanticRuleHandler: complex rule, returning ${suggestions.length} suggestions without persisting.`,
        );
        return {
          id,
          embeddingGenerated,
          isDuplicate: false,
          structureExtracted: false,
          intent: 'complex',
          suggestions,
        };
      }
      this.logger.warn(
        `CreateSemanticRuleHandler: rule complex y rephrase no propuso alternativas; persiste como complex.`,
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
    // structureExtracted = "el scheduler puede aplicarla". Si el LLM
    // devolvió intent=complex, la columna no es null pero la regla no
    // se aplica — para el manager eso equivale a "no extracted".
    const applicable = structure !== null && structure.intent !== 'complex';
    return {
      id,
      embeddingGenerated,
      isDuplicate: false,
      structureExtracted: applicable,
      intent: structure?.intent,
    };
  }
}
