import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject, NotFoundException } from '@nestjs/common';
import { GetSemanticRuleByIdQuery } from '../queries/get-semantic-rule-by-id.query';
import {
  SEMANTIC_RULE_REPOSITORY_TOKEN,
  type ISemanticRuleRepository,
} from '../../domain/repositories/semantic-rule.repository.interface';

@QueryHandler(GetSemanticRuleByIdQuery)
export class GetSemanticRuleByIdHandler implements IQueryHandler<GetSemanticRuleByIdQuery> {
  constructor(
    @Inject(SEMANTIC_RULE_REPOSITORY_TOKEN)
    private readonly ruleRepository: ISemanticRuleRepository,
  ) {}

  async execute(query: GetSemanticRuleByIdQuery): Promise<unknown> {
    const rule = await this.ruleRepository.findById(
      query.ruleId,
      query.companyId,
    );
    if (!rule) {
      throw new NotFoundException(
        `SemanticRule ${query.ruleId} not found in company ${query.companyId}`,
      );
    }
    return {
      id: rule.getId(),
      companyId: rule.getCompanyId(),
      ruleText: rule.getRuleText(),
      priorityLevel: rule.getPriority().getValue(),
      ruleType: rule.getRuleType().getValue(),
      isActive: rule.getIsActive(),
      expiresAt: rule.getExpiresAt()?.toISOString() ?? null,
      branchId: rule.getBranchId() ?? null,
      departmentId: rule.getDepartmentId() ?? null,
      hasEmbedding: rule.hasEmbedding(),
      hasStructure: rule.hasStructure(),
      structure: rule.getStructure(),
      metadata: rule.getMetadata(),
      createdAt: rule.getCreatedAt().toISOString(),
      createdBy: rule.getCreatedBy(),
    };
  }
}
