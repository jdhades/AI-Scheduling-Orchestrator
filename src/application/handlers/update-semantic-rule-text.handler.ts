import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger, NotFoundException } from '@nestjs/common';
import { UpdateSemanticRuleTextCommand } from '../commands/update-semantic-rule-text.command';
import {
  SEMANTIC_RULE_REPOSITORY_TOKEN,
  type ISemanticRuleRepository,
} from '../../domain/repositories/semantic-rule.repository.interface';
import {
  EMBEDDING_SERVICE_TOKEN,
  type IEmbeddingService,
} from '../../domain/services/embedding.service.interface';
import { RuleStructureExtractor } from '../../domain/services/rule-structure-extractor.service';

/**
 * UpdateSemanticRuleTextHandler
 *
 * Cambia `rule_text` e invalida embedding + structure. Regenera ambos:
 *   1. Fetch aggregate.
 *   2. `aggregate.updateText(newText)` — dispara invalidación interna.
 *   3. Re-embed vía IEmbeddingService.
 *   4. Re-extract structure vía RuleStructureExtractor (LLM).
 *   5. Persistir.
 *
 * Si alguna llamada externa falla, se guarda lo que haya — el log marca
 * el fallo y el manager puede reintentar editando el mismo texto.
 */
@CommandHandler(UpdateSemanticRuleTextCommand)
export class UpdateSemanticRuleTextHandler
  implements ICommandHandler<UpdateSemanticRuleTextCommand>
{
  private readonly logger = new Logger(UpdateSemanticRuleTextHandler.name);

  constructor(
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
    @Inject(EMBEDDING_SERVICE_TOKEN)
    private readonly embeddingService: IEmbeddingService,
    private readonly structureExtractor: RuleStructureExtractor,
  ) {}

  async execute(command: UpdateSemanticRuleTextCommand): Promise<{
    ruleId: string;
    embeddingRegenerated: boolean;
    structureRegenerated: boolean;
  }> {
    const rule = await this.ruleRepository.findById(
      command.ruleId,
      command.companyId,
    );
    if (!rule) {
      throw new NotFoundException(
        `SemanticRule ${command.ruleId} not found in company ${command.companyId}`,
      );
    }

    rule.updateText(command.newText);

    let embeddingRegenerated = false;
    try {
      const vector = await this.embeddingService.generate(command.newText);
      rule.setEmbedding(vector);
      embeddingRegenerated = true;
    } catch (err) {
      this.logger.warn(
        `UpdateSemanticRuleText: embedding regeneration failed — ${(err as Error).message}. Saving without embedding.`,
      );
    }

    const structure = await this.structureExtractor.extract({
      ruleText: command.newText,
    });
    if (structure) rule.setStructure(structure);
    const structureRegenerated = structure !== null;

    await this.ruleRepository.save(rule);

    this.logger.log(
      `SemanticRule text updated — id=${command.ruleId} embeddingRegenerated=${embeddingRegenerated} structureRegenerated=${structureRegenerated}`,
    );

    return {
      ruleId: command.ruleId,
      embeddingRegenerated,
      structureRegenerated,
    };
  }
}
