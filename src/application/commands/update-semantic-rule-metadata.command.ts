import type { SemanticRuleMetadataPatch } from '../../domain/repositories/semantic-rule.repository.interface';

/**
 * PATCH barato sobre campos de metadata. NO toca rule_text ni embedding.
 */
export class UpdateSemanticRuleMetadataCommand {
  constructor(
    public readonly ruleId: string,
    public readonly companyId: string,
    public readonly patch: SemanticRuleMetadataPatch,
  ) {}
}
