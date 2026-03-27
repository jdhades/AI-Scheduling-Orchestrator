/**
 * CreateSemanticRuleCommand
 *
 * Disparado por el RuleController cuando el Admin crea una nueva regla semántica.
 * El handler se encarga de: validar → crear aggregate → generar embedding → persistir.
 */
export class CreateSemanticRuleCommand {
  constructor(
    public readonly companyId: string,
    public readonly ruleText: string,
    public readonly priorityLevel: 1 | 2 | 3,
    public readonly ruleType: 'restriction' | 'preference' | 'requirement',
    public readonly createdBy?: string,
    public readonly metadata?: Record<string, unknown>,
  ) {}
}
