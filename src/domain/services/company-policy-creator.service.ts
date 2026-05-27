import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CompanyPolicy,
  type PolicyScope,
} from '../aggregates/company-policy.aggregate';
import {
  COMPANY_POLICY_REPOSITORY,
  type ICompanyPolicyRepository,
} from '../repositories/company-policy.repository';
import { PolicyInterpreterRegistry } from './policy-interpreter-registry';
import { PolicySeverity } from '../value-objects/policy-severity.vo';
import {
  LlmBudgetExceededException,
  LlmProviderNotAllowedException,
  LlmResolverService,
} from '../../application/services/llm-resolver.service';

/**
 * CompanyPolicyCreator — Domain Service
 *
 * Encapsula el flow de creación de CompanyPolicy con suggestion-loop
 * (commits 3-4). Antes vivía inline en CompanyPoliciesController; lo
 * extrajimos para que el MessageRouter de WhatsApp pueda reusar la
 * misma lógica sin duplicación.
 *
 * Dos caminos posibles tras el sprint async-policies (2026-05-26):
 *  - 'created' + matched      : el registry encontró un interpreter,
 *                                params extraídos, policy persistida.
 *  - 'created' + llm_only     : ningún interpreter matchea; persistimos
 *                                como llm_runtime (severity=hard) o
 *                                LLM-only puro (severity=soft). En ambos
 *                                casos preservamos el texto del manager
 *                                tal cual lo escribió.
 *
 * El suggestion-loop "needs_clarification" se eliminó en el mismo sprint
 * — el matcher es fast-path opcional, llm_runtime es el catch-all.
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

export type CompanyPolicyCreationResult = {
  status: 'created';
  policy: CompanyPolicy;
  mode: 'matched' | 'llm_only';
};

@Injectable()
export class CompanyPolicyCreator {
  private readonly logger = new Logger(CompanyPolicyCreator.name);

  constructor(
    @Inject(COMPANY_POLICY_REPOSITORY)
    private readonly policyRepo: ICompanyPolicyRepository,
    private readonly registry: PolicyInterpreterRegistry,
    private readonly llmResolver: LlmResolverService,
  ) {}

  /**
   * Obtiene el LLM client per-tenant via el resolver. Esto da:
   *   · selección de provider/model segun companies.llm_provider
   *   · enforcement de allowlist (LlmProviderNotAllowedException)
   *   · enforcement de budget mensual (LlmBudgetExceededException)
   *   · logging automático en llm_prompt_history
   *
   * Si el caller tira budget exceeded o not-allowed, propagamos el error
   * — el endpoint HTTP responde 403 con mensaje claro. NO hay fallback
   * a env-default: si soporte restringió el tenant, queremos que se
   * note el bloqueo en vez de gastar la cuenta default.
   *
   * (Pragmatic concession: este domain service importa de application/
   * para no duplicar la lógica del resolver. Ver `LlmResolverService`
   * comment — la migración a una abstracción ILlmResolver en domain/
   * queda para cuando aparezca un tercer caller que lo justifique.)
   */
  private async llmCompleteLogged(
    operation: string,
    companyId: string,
    prompt: string,
  ): Promise<string> {
    const llm = await this.llmResolver.forCompany(companyId, { operation });
    return llm.complete(prompt);
  }

  async create(
    input: CreateCompanyPolicyInput,
  ): Promise<CompanyPolicyCreationResult> {
    const text = input.text.trim();

    // Caso 1: interpreter matchea → extrae params, valida que la
    // estructura preserva la intención completa, y persiste.
    //
    // Phase 14 — el matching es ciego a matices del lenguaje natural.
    // Ej. "2 días libres NO CONSECUTIVOS" matchea con
    // `min_rest_days_per_week`, pero el interpreter solo cuenta
    // cantidad — pierde "no consecutivos". Antes de aceptar el match
    // verificamos que no se hayan perdido matices; si los hay y la
    // policy es hard, caemos al catch-all llm_runtime.
    const interpreter = this.registry.findMatch(text);
    if (interpreter) {
      const params = await interpreter.extractParams(text);
      const intentPreserved = await this.matchPreservesIntent({
        companyId: input.companyId,
        text,
        interpreterId: interpreter.id,
        interpreterDescription: interpreter.description,
        extractedParams: params,
      });

      const policy = CompanyPolicy.create({
        companyId: input.companyId,
        text,
        severity: PolicySeverity.create(input.severity),
        scope: input.scope,
        effectiveFrom: input.effectiveFrom,
        createdBy: input.createdBy ?? null,
      });

      if (intentPreserved) {
        policy.attachInterpreter(interpreter.id, params);
        await this.policyRepo.save(policy);
        return { status: 'created', policy, mode: 'matched' };
      }

      // Matices perdidos. Si severity=hard, enchufamos llm_runtime
      // (preserva el texto original). Si severity=soft, queda LLM-only
      // puro — el texto viaja al prompt sin enforcement deterministico.
      if (input.severity === 'hard' && this.registry.getById('llm_runtime')) {
        const englishText = await this.translateToEnglish(
          text,
          input.companyId,
        );
        policy.attachInterpreter('llm_runtime', {
          originalText: text,
          englishText,
        });
      }
      await this.policyRepo.save(policy);
      return { status: 'created', policy, mode: 'llm_only' };
    }

    // Sprint async-policies (2026-05-26): el suggestion loop con
    // LlmRuleRephraseService quedó eliminado. Razón: cada vez que el
    // matcher no entendía un texto, el LLM intentaba reformular hasta
    // que matcheara algún interpreter — agregando hardcoded patterns
    // implícito (cada interpreter es un "patrón conocido"). Modelo
    // ganador: matchers como fast-path opcional, llm_runtime como
    // default universal para todo lo demás. El texto del manager
    // viaja al solver tal cual lo escribió.

    // Caso 2 (antes "3"): fallback LLM-only / llm_runtime.
    //
    // Si la policy es `hard`, enchufamos el catch-all `llm_runtime`
    // para que igual el solver tenga enforcement en runtime (1 LLM call
    // extra por evaluación). Eso transforma la policy de "viaja al
    // prompt y rezamos" a "el verify-loop la chequea cada intento".
    //
    // Para `soft` mantenemos LLM-only puro (interpreterId=null): el
    // texto viaja al prompt en la sección de natural-language, pero no
    // pagamos calls extra por una preferencia que el solver puede ceder.
    const policy = CompanyPolicy.create({
      companyId: input.companyId,
      text,
      severity: PolicySeverity.create(input.severity),
      scope: input.scope,
      effectiveFrom: input.effectiveFrom,
      createdBy: input.createdBy ?? null,
    });

    if (input.severity === 'hard' && this.registry.getById('llm_runtime')) {
      // Pre-traducimos al inglés para que el prompt del LLM-proposer
      // quede consistente (el resto del prompt está en inglés). El
      // texto original se preserva para auditoría / display.
      const englishText = await this.translateToEnglish(text, input.companyId);
      policy.attachInterpreter('llm_runtime', {
        originalText: text,
        englishText,
      });
    }

    await this.policyRepo.save(policy);
    return { status: 'created', policy, mode: 'llm_only' };
  }

  /**
   * Phase 14 — verifica que el matching estructurado preserve la
   * intención completa del manager. Cuando el `findMatch` agarra un
   * texto y `extractParams` produce números, el resto del texto puede
   * tener matices (temporales, condicionales, compuestos) que el
   * interpreter no contempla. Si el LLM detecta esa pérdida, devolvemos
   * `false` para que el creator caiga al catch-all `llm_runtime`.
   *
   * Fail-open: si el LLM falla o devuelve forma inválida, devolvemos
   * `true` (preferimos enforcement determinístico que bloqueo total).
   */
  private async matchPreservesIntent(input: {
    companyId: string;
    text: string;
    interpreterId: string;
    interpreterDescription: string;
    extractedParams: Record<string, unknown>;
  }): Promise<boolean> {
    const prompt = `You are auditing whether a structured policy interpreter would FULLY capture the manager's intent or LOSE NUANCES.

Original policy (manager's natural language):
${input.text}

Proposed structured handler:
- id: ${input.interpreterId}
- description: ${input.interpreterDescription}
- extracted parameters: ${JSON.stringify(input.extractedParams)}

The structured handler enforces ONLY what its description and parameters can express. Anything in the original text that is NOT covered by them will be LOST. Common nuances that get lost:
- temporal distribution (e.g. "not consecutive", "spread out", "every other day")
- conditional applicability (e.g. "except seniors", "except holidays", "after 6 months")
- compound rules (e.g. "and also...", "but only when...")

Decide: does the structured handler with these parameters fully preserve the manager's intent, or does it lose meaningful nuances?

Respond with ONLY a JSON object, no prose, no code fences:
{"fullyCovered": true|false, "reason": "<one short sentence>"}`;

    try {
      const raw = await this.llmCompleteLogged(
        'policy.match_intent',
        input.companyId,
        prompt,
      );
      const m = raw.match(/\{[\s\S]*?\}/);
      if (!m) {
        this.logger.warn(
          'matchPreservesIntent: no JSON in LLM output; defaulting to fullyCovered=true',
        );
        return true;
      }
      const parsed = JSON.parse(m[0]);
      if (typeof parsed?.fullyCovered === 'boolean') {
        if (!parsed.fullyCovered) {
          this.logger.log(
            `matchPreservesIntent: nuances lost on ${input.interpreterId} → fallback a llm_runtime. Reason: ${parsed.reason ?? '(none)'}`,
          );
        }
        return parsed.fullyCovered;
      }
      this.logger.warn(
        `matchPreservesIntent: shape inválida (${JSON.stringify(parsed)}); fallback a true`,
      );
      return true;
    } catch (err) {
      // Budget/allowlist → propagar al endpoint (403 con mensaje
      // claro). Provider error → fail-open: asumimos que la intención
      // está preservada y dejamos al interpreter encargarse.
      if (
        err instanceof LlmBudgetExceededException ||
        err instanceof LlmProviderNotAllowedException
      ) {
        throw err;
      }
      this.logger.warn(
        `matchPreservesIntent failed (${(err as Error).message}); using interpreter`,
      );
      return true;
    }
  }

  /**
   * Traduce el texto del manager a inglés. Si el LLM falla, devuelve el
   * texto original (fail-open: la policy no se bloquea por un fallo de
   * traducción; el prompt queda con texto mixto en el peor caso).
   */
  private async translateToEnglish(
    text: string,
    companyId: string,
  ): Promise<string> {
    const prompt = `Translate the following workforce-scheduling policy to clear, concise English. Keep numbers, durations, names and shift-block patterns intact. Output ONLY the translated sentence, no quotes, no prose, no explanations.

POLICY: ${text}`;
    try {
      const out = await this.llmCompleteLogged(
        'policy.translate',
        companyId,
        prompt,
      );
      const trimmed = out.trim().replace(/^["']|["']$/g, '');
      if (trimmed.length === 0) return text;
      return trimmed;
    } catch (err) {
      // Budget/allowlist → propagar. Provider error → fail-open con
      // el texto original (peor caso: el prompt del solver queda con
      // texto mixto idioma; sigue siendo aplicable).
      if (
        err instanceof LlmBudgetExceededException ||
        err instanceof LlmProviderNotAllowedException
      ) {
        throw err;
      }
      this.logger.warn(
        `translateToEnglish failed (${(err as Error).message}); using original`,
      );
      return text;
    }
  }
}
