/**
 * SemanticRuleCreatedEvent — Domain Event
 *
 * Publicado al EventBus cuando se crea una nueva regla semántica.
 * Permite a otros módulos (auditoría, webhooks) reaccionar sin acoplamiento.
 */
export class SemanticRuleCreatedEvent {
  constructor(
    public readonly ruleId: string,
    public readonly companyId: string,
    public readonly ruleText: string,
    public readonly priorityLevel: number,
    public readonly ruleType: string,
    public readonly createdAt: Date,
  ) {}
}
