import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SemanticRuleAggregate } from '../../domain/aggregates/semantic-rule.aggregate';
import type { ISemanticRuleRepository, SemanticRuleWithDistance } from '../../domain/repositories/semantic-rule.repository.interface';

/**
 * SupabaseSemanticRuleRepository — Infrastructure Repository
 *
 * Implementación de ISemanticRuleRepository usando Supabase + pgvector.
 *
 * La búsqueda semántica (findRelevantRules) usa la función RPC `find_relevant_rules`
 * definida en la migration del Escenario 3, que ejecuta la query de distancia coseno
 * con aislamiento por empresa explícito.
 */
@Injectable()
export class SupabaseSemanticRuleRepository implements ISemanticRuleRepository {
    constructor(
        @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    ) { }

    async save(rule: SemanticRuleAggregate): Promise<void> {
        const embedding = rule.getEmbedding();

        const { error } = await this.supabase.from('semantic_rules').upsert({
            id: rule.getId(),
            company_id: rule.getCompanyId(),
            rule_text: rule.getRuleText(),
            // pgvector espera el formato "[v1,v2,...,vN]"
            embedding: embedding ? embedding.toPgVectorString() : null,
            priority_level: rule.getPriority().getValue(),
            rule_type: rule.getRuleType().getValue(),
            created_by: rule.getCreatedBy(),
            is_active: rule.getIsActive(),
            metadata: rule.getMetadata(),
        });

        if (error) {
            throw new Error(`SemanticRuleRepository.save failed: ${error.message}`);
        }
    }

    async findById(id: string, companyId: string): Promise<SemanticRuleAggregate | null> {
        const { data, error } = await this.supabase
            .from('semantic_rules')
            .select('*')
            .eq('id', id)
            .eq('company_id', companyId)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null; // not found
            throw new Error(`SemanticRuleRepository.findById failed: ${error.message}`);
        }

        return data ? this.toDomain(data) : null;
    }

    async findAllByCompany(companyId: string): Promise<SemanticRuleAggregate[]> {
        const { data, error } = await this.supabase
            .from('semantic_rules')
            .select('*')
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('priority_level', { ascending: true })
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`SemanticRuleRepository.findAllByCompany failed: ${error.message}`);
        }

        return (data ?? []).map((row) => this.toDomain(row));
    }

    /**
     * Búsqueda semántica por similitud coseno usando la RPC `find_relevant_rules`.
     * Solo retorna reglas activas con embedding generado de la misma empresa.
     */
    async findRelevantRules(
        queryVector: number[],
        companyId: string,
        topK = 10,
    ): Promise<SemanticRuleWithDistance[]> {
        const vectorStr = `[${queryVector.join(',')}]`;

        const { data, error } = await this.supabase.rpc('find_relevant_rules', {
            query_vector: vectorStr,
            company_id_param: companyId,
            top_k: topK,
        });

        if (error) {
            throw new Error(`SemanticRuleRepository.findRelevantRules failed: ${error.message}`);
        }

        return (data ?? []).map((row: Record<string, unknown>) => ({
            rule: this.toDomain(row),
            distance: row.distance as number,
        }));
    }

    async softDelete(id: string, companyId: string): Promise<void> {
        const { error } = await this.supabase
            .from('semantic_rules')
            .update({ is_active: false })
            .eq('id', id)
            .eq('company_id', companyId);

        if (error) {
            throw new Error(`SemanticRuleRepository.softDelete failed: ${error.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Mapeo de persistencia al dominio
    // -------------------------------------------------------------------------

    private toDomain(row: Record<string, unknown>): SemanticRuleAggregate {
        return SemanticRuleAggregate.fromPersistence({
            id: row.id as string,
            company_id: row.company_id as string,
            rule_text: row.rule_text as string,
            // pgvector retorna el vector como array de números en la respuesta JSON
            embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : null,
            priority_level: row.priority_level as number,
            rule_type: row.rule_type as string,
            created_by: (row.created_by as string) ?? null,
            is_active: row.is_active as boolean,
            metadata: (row.metadata as Record<string, unknown>) ?? {},
            created_at: row.created_at as string,
        });
    }
}
