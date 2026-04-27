import { Inject, Injectable } from '@nestjs/common';
import {
  COMPANY_POLICY_REPOSITORY,
  type ICompanyPolicyRepository,
} from '../repositories/company-policy.repository';
import type { CompanyPolicy } from '../aggregates/company-policy.aggregate';
import { PolicyInterpreterRegistry } from './policy-interpreter-registry';
import type {
  PolicyEvaluationContext,
  PolicyViolation,
} from './policy-interpreter.interface';

export interface PolicyEvaluationResult {
  /** Violaciones de policies hard. Bloquean la asignación; el solver
   *  debería rechazar el schedule o repararlo antes de publicar. */
  hardViolations: Array<PolicyViolation & { policyId: string }>;
  /** Violaciones de policies soft. El solver puede aceptarlas (con
   *  warning) o repararlas si hay alternativa. */
  softViolations: Array<PolicyViolation & { policyId: string }>;
  /** Policies que NO se pudieron evaluar deterministamente porque no
   *  tienen interpreter asignado (son LLM-only). El caller debería
   *  pasarlas al prompt del LLM en la fase repair. */
  llmOnlyPolicies: CompanyPolicy[];
}

/**
 * PolicyEnforcementService — Domain Service (MVP de integración solver).
 *
 * Pieza ready-to-plug para el WeekScheduleBuilder cuando esté listo
 * para consumir policies. NO invade el solver activo (Phase 13/3.5);
 * provee dos métodos pure-function que el solver llama cuando
 * corresponda:
 *
 *   - evaluate(): corre cada interpreter.apply() contra el schedule
 *     propuesto y agrupa violaciones por severity. Lo policies LLM-only
 *     se devuelven aparte para que el caller decida (típicamente las
 *     pasa al prompt del LLM en fase repair).
 *
 *   - formatForPrompt(): renderiza todas las policies activas a un
 *     bloque NL para el prompt del LLM. Hard / Soft / LLM-only
 *     agrupados.
 *
 * El subsistema completo (load + evaluate + format) requiere SOLO una
 * lectura de DB por generación de schedule. Cacheable in-memory si el
 * caller necesita reusar.
 */
@Injectable()
export class PolicyEnforcementService {
  constructor(
    @Inject(COMPANY_POLICY_REPOSITORY)
    private readonly policyRepo: ICompanyPolicyRepository,
    private readonly registry: PolicyInterpreterRegistry,
  ) {}

  /** Carga + corre interpreters activos contra el schedule propuesto. */
  async evaluate(
    companyId: string,
    ctx: PolicyEvaluationContext,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.policyRepo.findAllActiveByCompany(companyId);
    return this.evaluateLoaded(policies, ctx);
  }

  /**
   * Variante para cuando el caller ya cargó las policies (evita doble
   * lectura DB cuando se combina con formatForPrompt en la misma
   * generación).
   */
  evaluateLoaded(
    policies: CompanyPolicy[],
    ctx: PolicyEvaluationContext,
  ): PolicyEvaluationResult {
    const result: PolicyEvaluationResult = {
      hardViolations: [],
      softViolations: [],
      llmOnlyPolicies: [],
    };

    for (const policy of policies) {
      const interpreterId = policy.getInterpreterId();
      if (!interpreterId) {
        result.llmOnlyPolicies.push(policy);
        continue;
      }
      const interpreter = this.registry.getById(interpreterId);
      if (!interpreter) {
        // El policy fue creado con un interpreter que ya no existe en el
        // registry (ej. dev quitó un patrón). Tratamos como LLM-only.
        result.llmOnlyPolicies.push(policy);
        continue;
      }

      const violations = interpreter.apply(ctx, policy.getParams() as never);
      const tagged = violations.map((v) => ({ ...v, policyId: policy.getId() }));
      if (policy.getSeverity().isHard()) {
        result.hardViolations.push(...tagged);
      } else {
        result.softViolations.push(...tagged);
      }
    }

    return result;
  }

  /**
   * Renderiza las policies activas como bloque NL para el prompt del
   * LLM (fase repair). Las hard van primero, luego soft, luego LLM-only.
   */
  async formatForPrompt(companyId: string): Promise<string> {
    const policies = await this.policyRepo.findAllActiveByCompany(companyId);
    return this.formatLoaded(policies);
  }

  /** Variante sin lectura DB. */
  formatLoaded(policies: CompanyPolicy[]): string {
    const hardLines: string[] = [];
    const softLines: string[] = [];
    const llmOnlyLines: string[] = [];

    for (const policy of policies) {
      const line = this.renderPolicy(policy);
      if (!line) continue;
      const interpreterId = policy.getInterpreterId();
      const isStructured = interpreterId !== null && this.registry.getById(interpreterId) !== null;
      if (!isStructured) {
        llmOnlyLines.push(line);
      } else if (policy.getSeverity().isHard()) {
        hardLines.push(line);
      } else {
        softLines.push(line);
      }
    }

    const sections: string[] = [];
    if (hardLines.length > 0) {
      sections.push(
        ['== Hard Policies (must respect) ==', ...hardLines.map((l) => `- ${l}`)].join('\n'),
      );
    }
    if (softLines.length > 0) {
      sections.push(
        ['== Soft Policies (preferences) ==', ...softLines.map((l) => `- ${l}`)].join('\n'),
      );
    }
    if (llmOnlyLines.length > 0) {
      sections.push(
        [
          '== Policies expressed in natural language (no structured matcher; use your judgment) ==',
          ...llmOnlyLines.map((l) => `- ${l}`),
        ].join('\n'),
      );
    }
    return sections.join('\n\n');
  }

  private renderPolicy(policy: CompanyPolicy): string | null {
    const interpreterId = policy.getInterpreterId();
    if (interpreterId) {
      const interpreter = this.registry.getById(interpreterId);
      if (interpreter) {
        return interpreter.format(policy.getParams() as never);
      }
    }
    // LLM-only o interpreter ausente: usar el texto del manager tal cual.
    return policy.getText();
  }
}
