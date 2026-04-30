import { Inject, Injectable } from '@nestjs/common';
import {
  CompanyPolicy,
  type PolicyScope,
} from '../aggregates/company-policy.aggregate';
import {
  COMPANY_POLICY_REPOSITORY,
  type ICompanyPolicyRepository,
} from '../repositories/company-policy.repository';
import { PolicyInterpreterRegistry } from './policy-interpreter-registry';
import {
  RULE_REPHRASE_SERVICE,
  type IRuleRephraseService,
  type RephraseSuggestion,
} from './rule-rephrase.service.interface';
import { PolicySeverity } from '../value-objects/policy-severity.vo';

/**
 * CompanyPolicyCreator — Domain Service
 *
 * Encapsula el flow de creación de CompanyPolicy con suggestion-loop
 * (commits 3-4). Antes vivía inline en CompanyPoliciesController; lo
 * extrajimos para que el MessageRouter de WhatsApp pueda reusar la
 * misma lógica sin duplicación.
 *
 * Tres caminos posibles, expresados como discriminated union:
 *  - 'created' + matched      : el registry encontró un interpreter,
 *                                params extraídos, policy persistida.
 *  - 'needs_clarification'    : ningún interpreter matchea pero el LLM
 *                                propuso reformulaciones verificadas.
 *                                NO persiste — caller decide qué hacer.
 *  - 'created' + llm_only     : ningún interpreter + el LLM tampoco
 *                                pudo proponer nada; persistimos como
 *                                LLM-only para no bloquear al manager.
 */

export interface CreateCompanyPolicyInput {
  companyId: string;
  text: string;
  severity: 'hard' | 'soft';
  /** Phase 14.1 — alcance de la policy. Default: tenant-wide. */
  scope?: PolicyScope;
  effectiveFrom?: string;
  createdBy?: string | null;
}

export type CompanyPolicyCreationResult =
  | { status: 'created'; policy: CompanyPolicy; mode: 'matched' | 'llm_only' }
  | {
      status: 'needs_clarification';
      reason: 'no_interpreter_matched';
      suggestions: RephraseSuggestion[];
    };

@Injectable()
export class CompanyPolicyCreator {
  constructor(
    @Inject(COMPANY_POLICY_REPOSITORY)
    private readonly policyRepo: ICompanyPolicyRepository,
    private readonly registry: PolicyInterpreterRegistry,
    @Inject(RULE_REPHRASE_SERVICE)
    private readonly rephraseService: IRuleRephraseService,
  ) {}

  async create(
    input: CreateCompanyPolicyInput,
  ): Promise<CompanyPolicyCreationResult> {
    const text = input.text.trim();

    // Caso 1: interpreter matchea → extrae params y persiste.
    const interpreter = this.registry.findMatch(text);
    if (interpreter) {
      const policy = CompanyPolicy.create({
        companyId: input.companyId,
        text,
        severity: PolicySeverity.create(input.severity),
        scope: input.scope,
        effectiveFrom: input.effectiveFrom,
        createdBy: input.createdBy ?? null,
      });
      const params = await interpreter.extractParams(text);
      policy.attachInterpreter(interpreter.id, params);
      await this.policyRepo.save(policy);
      return { status: 'created', policy, mode: 'matched' };
    }

    // Caso 2: ningún interpreter — pedimos sugerencias verificadas.
    const interpreterHints = this.registry.getAvailableIds().map((id) => {
      const itp = this.registry.getById(id);
      return { id, description: itp?.description ?? '' };
    });
    const suggestions = await this.rephraseService.suggest({
      originalText: text,
      reason: 'no_interpreter_matched',
      interpreters: interpreterHints,
    });

    if (suggestions.length > 0) {
      return {
        status: 'needs_clarification',
        reason: 'no_interpreter_matched',
        suggestions,
      };
    }

    // Caso 3: fallback LLM-only.
    const policy = CompanyPolicy.create({
      companyId: input.companyId,
      text,
      severity: PolicySeverity.create(input.severity),
      scope: input.scope,
      effectiveFrom: input.effectiveFrom,
      createdBy: input.createdBy ?? null,
    });
    await this.policyRepo.save(policy);
    return { status: 'created', policy, mode: 'llm_only' };
  }
}
