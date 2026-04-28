/**
 * Devuelve una regla semántica por id + companyId. Retorna null/404 si no
 * existe, pertenece a otro tenant, o fue soft-deleted.
 */
export class GetSemanticRuleByIdQuery {
  constructor(
    public readonly ruleId: string,
    public readonly companyId: string,
  ) {}
}
