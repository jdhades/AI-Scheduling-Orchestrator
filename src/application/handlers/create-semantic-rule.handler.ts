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

export interface CreateSemanticRuleResult {
    id: string;
    embeddingGenerated: boolean;
}

/**
 * CreateSemanticRuleHandler — Command Handler
 *
 * Flujo:
 *   1. Crear SemanticRuleAggregate (valida texto, prioridad, tipo)
 *   2. Generar embedding via IEmbeddingService
 *   3. Persistir en pgvector via ISemanticRuleRepository
 *   4. Publicar SemanticRuleCreatedEvent al EventBus
 */
@CommandHandler(CreateSemanticRuleCommand)
export class CreateSemanticRuleHandler
    implements ICommandHandler<CreateSemanticRuleCommand, CreateSemanticRuleResult> {

    private readonly logger = new Logger(CreateSemanticRuleHandler.name);

    constructor(
        @Inject(EMBEDDING_SERVICE_TOKEN)
        private readonly embeddingService: IEmbeddingService,
        @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
        private readonly ruleRepository: ISemanticRuleRepository,
        private readonly eventBus: EventBus,
    ) { }

    async execute(command: CreateSemanticRuleCommand): Promise<CreateSemanticRuleResult> {
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
        });

        // 2. Generar embedding (puede fallar si la API está caída)
        let embeddingGenerated = false;
        try {
            const vector = await this.embeddingService.generate(command.ruleText);
            rule.setEmbedding(vector);
            embeddingGenerated = true;
        } catch (error) {
            // La regla se persiste sin embedding — puede re-procesarse después
            this.logger.warn(
                `CreateSemanticRuleHandler: embedding generation failed, rule saved without vector. Error: ${(error as Error).message}`,
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

        this.logger.log(`Semantic rule created — id=${id} embeddingGenerated=${embeddingGenerated}`);
        return { id, embeddingGenerated };
    }
}
