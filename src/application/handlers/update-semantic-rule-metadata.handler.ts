import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { UpdateSemanticRuleMetadataCommand } from '../commands/update-semantic-rule-metadata.command';
import {
  SEMANTIC_RULE_REPOSITORY_TOKEN,
  type ISemanticRuleRepository,
} from '../../domain/repositories/semantic-rule.repository.interface';

@CommandHandler(UpdateSemanticRuleMetadataCommand)
export class UpdateSemanticRuleMetadataHandler implements ICommandHandler<UpdateSemanticRuleMetadataCommand> {
  constructor(
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
  ) {}

  async execute(command: UpdateSemanticRuleMetadataCommand): Promise<void> {
    const existing = await this.ruleRepository.findById(
      command.ruleId,
      command.companyId,
    );
    if (!existing) {
      throw new NotFoundException(
        `SemanticRule ${command.ruleId} not found in company ${command.companyId}`,
      );
    }
    await this.ruleRepository.updateMetadata(
      command.ruleId,
      command.companyId,
      command.patch,
    );
  }
}
