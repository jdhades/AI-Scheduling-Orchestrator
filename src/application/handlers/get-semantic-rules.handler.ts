import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { GetSemanticRulesQuery } from '../queries/get-semantic-rules.query';
import type { ISemanticRuleRepository } from '../../domain/repositories/semantic-rule.repository.interface';
import { SEMANTIC_RULE_REPOSITORY_TOKEN } from '../../domain/repositories/semantic-rule.repository.interface';

export interface SemanticRuleDto {
  id: string;
  ruleText: string;
  priorityLevel: number;
  priorityLabel: string;
  ruleType: string;
  hasEmbedding: boolean;
  isActive: boolean;
  createdAt: string;
}

/**
 * GetSemanticRulesHandler — Query Handler
 *
 * Read side puro: lista las reglas semánticas activas de la empresa,
 * opcionalmente filtradas por tipo. No hay lógica de dominio.
 */
@QueryHandler(GetSemanticRulesQuery)
export class GetSemanticRulesHandler implements IQueryHandler<
  GetSemanticRulesQuery,
  SemanticRuleDto[]
> {
  constructor(
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
  ) {}

  async execute(query: GetSemanticRulesQuery): Promise<SemanticRuleDto[]> {
    const rules = await this.ruleRepository.findAllByCompany(query.companyId);

    const filtered = query.ruleType
      ? rules.filter((r) => r.getRuleType().getValue() === query.ruleType)
      : rules;

    return filtered.map((rule) => ({
      id: rule.getId(),
      ruleText: rule.getRuleText(),
      priorityLevel: rule.getPriority().getValue(),
      priorityLabel: rule.getPriority().toLabel(),
      ruleType: rule.getRuleType().getValue(),
      hasEmbedding: rule.hasEmbedding(),
      isActive: rule.getIsActive(),
      createdAt: rule.getCreatedAt().toISOString(),
    }));
  }
}
