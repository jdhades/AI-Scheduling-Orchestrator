/**
 * PATCH caro: cambia `rule_text` e implica re-embedding + re-extracción de
 * estructura vía LLM. Endpoint separado para que el cliente vea el costo.
 */
export class UpdateSemanticRuleTextCommand {
  constructor(
    public readonly ruleId: string,
    public readonly companyId: string,
    public readonly newText: string,
  ) {}
}
