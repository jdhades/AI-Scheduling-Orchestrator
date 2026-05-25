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

  /**
   * Carga las policies activas del tenant. Útil cuando el caller necesita
   * combinar `formatLoaded` + `evaluateLoaded` con una sola lectura DB
   * (ej. el `WeekScheduleBuilder` durante la generación de horario).
   */
  async loadActivePolicies(companyId: string): Promise<CompanyPolicy[]> {
    return this.policyRepo.findAllActiveByCompany(companyId);
  }

  /** Carga + corre interpreters activos contra el schedule propuesto. */
  async evaluate(
    companyId: string,
    ctx: PolicyEvaluationContext,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.loadActivePolicies(companyId);
    return this.evaluateLoaded(policies, ctx);
  }

  /**
   * Variante para cuando el caller ya cargó las policies (evita doble
   * lectura DB cuando se combina con formatForPrompt en la misma
   * generación).
   */
  async evaluateLoaded(
    policies: CompanyPolicy[],
    ctx: PolicyEvaluationContext,
  ): Promise<PolicyEvaluationResult> {
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

      // Phase 14.1 — filtrar shifts por scope antes de invocar el
      // interpreter. company-wide pasa todos los shifts; el resto exige
      // employeeMeta para resolver branch/department.
      const scopedShifts = this.filterShiftsByScope(ctx, policy);
      if (scopedShifts === null) {
        // No teníamos employeeMeta para este scope — degradar a LLM-only
        // antes que evaluar mal y bloquear schedules.
        result.llmOnlyPolicies.push(policy);
        continue;
      }

      const scopedCtx: PolicyEvaluationContext = {
        ...ctx,
        shifts: scopedShifts,
      };
      const violations = await interpreter.apply(scopedCtx, policy.getParams());
      const tagged = violations.map((v) => ({
        ...v,
        policyId: policy.getId(),
      }));
      if (policy.getSeverity().isHard()) {
        result.hardViolations.push(...tagged);
      } else {
        result.softViolations.push(...tagged);
      }
    }

    return result;
  }

  /**
   * Phase 14.1 — devuelve los shifts a los que la policy aplica según su
   * scope. Devuelve `null` si el scope requiere `employeeMeta` y no fue
   * provisto (caller decide si degradar a LLM-only).
   */
  private filterShiftsByScope(
    ctx: PolicyEvaluationContext,
    policy: CompanyPolicy,
  ): PolicyEvaluationContext['shifts'] | null {
    const scope = policy.getScope();
    if (scope.type === 'company') {
      return ctx.shifts;
    }
    if (!ctx.employeeMeta) {
      return null; // scope requiere meta, no la tenemos
    }
    return ctx.shifts.filter((s) => {
      const meta = ctx.employeeMeta!.get(s.employeeId);
      if (!meta) return false;
      return policy.isApplicableTo({
        id: s.employeeId,
        branchId: meta.branchId,
        departmentId: meta.departmentId,
      });
    });
  }

  /**
   * Renderiza las policies activas como bloque NL para el prompt del
   * LLM (fase repair). Las hard van primero, luego soft, luego LLM-only.
   *
   * Phase 14.1: si se pasa `scopeNames` (Map<scopeId, displayName>), el
   * render incluye el nombre legible del branch/department/employee al
   * que aplica la policy. Sin ese map se renderiza el id crudo (fallback
   * para tests / callers que no necesitan UX).
   */
  async formatForPrompt(
    companyId: string,
    scopeNames?: ReadonlyMap<string, string>,
  ): Promise<string> {
    const policies = await this.policyRepo.findAllActiveByCompany(companyId);
    return this.formatLoaded(policies, scopeNames);
  }

  /** Variante sin lectura DB. Devuelve string vacío si no hay policies. */
  formatLoaded(
    policies: CompanyPolicy[],
    scopeNames?: ReadonlyMap<string, string>,
  ): string {
    const hardLines: string[] = [];
    const softLines: string[] = [];
    const llmOnlyLines: string[] = [];

    for (const policy of policies) {
      const line = this.renderPolicy(policy);
      if (!line) continue;
      const scopePrefix = this.renderScopePrefix(policy, scopeNames);
      const decorated = scopePrefix ? `${scopePrefix} ${line}` : line;
      const interpreterId = policy.getInterpreterId();
      const isStructured =
        interpreterId !== null && this.registry.getById(interpreterId) !== null;
      if (!isStructured) {
        llmOnlyLines.push(decorated);
      } else if (policy.getSeverity().isHard()) {
        hardLines.push(decorated);
      } else {
        softLines.push(decorated);
      }
    }

    const sections: string[] = [];
    if (hardLines.length > 0) {
      sections.push(
        [
          '== Hard Policies (must respect) ==',
          ...hardLines.map((l) => `- ${l}`),
        ].join('\n'),
      );
    }
    if (softLines.length > 0) {
      sections.push(
        [
          '== Soft Policies (preferences) ==',
          ...softLines.map((l) => `- ${l}`),
        ].join('\n'),
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

  /**
   * Phase 14.1 — devuelve un prefijo legible para el scope (`[scope=...]`)
   * o null si la policy aplica a toda la empresa (no hace falta
   * decoración).
   */
  private renderScopePrefix(
    policy: CompanyPolicy,
    scopeNames?: ReadonlyMap<string, string>,
  ): string | null {
    const scope = policy.getScope();
    if (scope.type === 'company') return null;
    const id = scope.id!;
    const name = scopeNames?.get(id) ?? id;
    return `[applies to ${scope.type} "${name}"]`;
  }

  private renderPolicy(policy: CompanyPolicy): string | null {
    const interpreterId = policy.getInterpreterId();
    if (interpreterId) {
      const interpreter = this.registry.getById(interpreterId);
      if (interpreter) {
        return interpreter.format(policy.getParams());
      }
    }
    // LLM-only o interpreter ausente: usar el texto del manager tal cual.
    return policy.getText();
  }
}
