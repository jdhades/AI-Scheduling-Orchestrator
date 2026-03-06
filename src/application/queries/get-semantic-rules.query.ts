/**
 * GetSemanticRulesQuery
 *
 * Query CQRS para listar reglas semánticas de una empresa.
 * Read side puro — sin lógica de dominio.
 */
export class GetSemanticRulesQuery {
    constructor(
        public readonly companyId: string,
        public readonly ruleType?: 'restriction' | 'preference' | 'requirement',
    ) { }
}
