import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { DeleteSemanticRuleCommand } from '../commands/delete-semantic-rule.command';
import type { ISemanticRuleRepository } from '../../domain/repositories/semantic-rule.repository.interface';
import { SEMANTIC_RULE_REPOSITORY_TOKEN } from '../../domain/repositories/semantic-rule.repository.interface';

/**
 * DeleteSemanticRuleHandler — Command Handler
 *
 * Realiza un soft-delete de la regla semántica.
 * La regla permanece en DB con is_active=false para auditoría.
 */
@CommandHandler(DeleteSemanticRuleCommand)
export class DeleteSemanticRuleHandler implements ICommandHandler<
  DeleteSemanticRuleCommand,
  { deleted: boolean }
> {
  private readonly logger = new Logger(DeleteSemanticRuleHandler.name);

  constructor(
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
  ) {}

  async execute(
    command: DeleteSemanticRuleCommand,
  ): Promise<{ deleted: boolean }> {
    // Verificar que la regla existe y pertenece a la empresa
    const rule = await this.ruleRepository.findById(
      command.ruleId,
      command.companyId,
    );

    if (!rule) {
      this.logger.warn(
        `DeleteSemanticRuleHandler: rule ${command.ruleId} not found for company ${command.companyId}`,
      );
      return { deleted: false };
    }

    await this.ruleRepository.softDelete(command.ruleId, command.companyId);

    this.logger.log(`Semantic rule soft-deleted — id=${command.ruleId}`);
    return { deleted: true };
  }
}
