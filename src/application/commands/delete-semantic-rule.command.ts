/**
 * DeleteSemanticRuleCommand
 *
 * Soft-delete de una regla semántica. La regla permanece en DB para auditoría
 * pero deja de participar en recuperaciones RAG.
 */
export class DeleteSemanticRuleCommand {
  constructor(
    public readonly ruleId: string,
    public readonly companyId: string,
  ) {}
}
