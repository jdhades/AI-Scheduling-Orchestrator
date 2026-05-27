import { Injectable, Logger } from '@nestjs/common';
import {
  type PolicyEvaluationContext,
  type PolicyInterpreter,
  type PolicyViolation,
} from '../policy-interpreter.interface';
import {
  LlmBudgetExceededException,
  LlmProviderNotAllowedException,
  LlmResolverService,
} from '../../../application/services/llm-resolver.service';

/**
 * Catch-all interpreter que delega la evaluación al LLM en runtime.
 * Pensado para policies que no encajan en ningún interpreter estructurado
 * (ej. patrones rotativos `24×48`, "los senior no trabajan feriados",
 * reglas idiosincráticas de un tenant).
 *
 * Trade-offs explícitos vs los interpreters estructurados:
 *   - Siempre +1 LLM call por evaluación. Caro a escala con muchas
 *     policies hard llm_runtime + muchos intentos del verify-loop.
 *   - El LLM puede no converger entre intentos (devuelve un set distinto
 *     de violaciones cada vez). El cap del verify-loop (MAX_LLM_ATTEMPTS)
 *     limita el daño: tras N intentos cae al determinístico.
 *   - Pensado para `severity=hard` con policies LLM-only que el manager
 *     quiere "enforced si o si". Para `soft` no se enchufa (el text ya
 *     viaja al prompt del LLM-proposer y eso alcanza).
 *
 * El interpreter NUNCA matchea texto desde `findMatch()` — su `matches()`
 * devuelve false. Se enchufa explícitamente cuando el `CompanyPolicyCreator`
 * decide caer al fallback con severity=hard. Eso evita que el registry
 * lo "robe" antes de probar interpreters específicos.
 */

interface LLMRuntimeParams {
  /** Texto crudo del manager. Lo pasamos al LLM en cada `apply`. */
  originalText: string;
  /**
   * Pre-traducción al inglés (opcional). Si está, se usa para el prompt
   * del LLM-proposer y para la evaluación; el `originalText` queda
   * solo para auditoría/display.
   */
  englishText?: string;
}

interface LLMViolationDTO {
  employeeId?: string | null;
  scope?: string | null;
  message?: string | null;
}

@Injectable()
export class LLMRuntimeInterpreter implements PolicyInterpreter<LLMRuntimeParams> {
  readonly id = 'llm_runtime';
  readonly description =
    'Catch-all evaluator: delega la evaluación al LLM en runtime para policies que no encajan en ningún interpreter estructurado. Pensado para severity=hard.';
  readonly catchAll = true;

  private readonly logger = new Logger(LLMRuntimeInterpreter.name);

  constructor(private readonly llmResolver: LlmResolverService) {}

  /**
   * NO matchea desde el registry — el catch-all se enchufa explícitamente
   * desde `CompanyPolicyCreator` para no robarle prioridad a los
   * interpreters estructurados.
   */
  matches(_text: string): boolean {
    return false;
  }

  /**
   * `extractParams` solo se usa cuando `matches()` devolvió true; como
   * acá nunca lo hace, esta implementación es defensive: simplemente
   * guarda el texto crudo. El caller que decide enchufar `llm_runtime`
   * debe llamar `attachInterpreter('llm_runtime', { originalText })`
   * directamente.
   */
  async extractParams(text: string): Promise<LLMRuntimeParams> {
    return { originalText: text };
  }

  async apply(
    ctx: PolicyEvaluationContext,
    params: LLMRuntimeParams,
  ): Promise<PolicyViolation[]> {
    if (ctx.shifts.length === 0) {
      return [];
    }

    if (!ctx.companyId) {
      // Sin companyId no podemos resolver el LLM per-tenant. Fail-open:
      // misma semántica que un LLM failure. El caller (PolicyEnforcementService)
      // ya pasa el companyId siempre; este branch es defensivo para tests
      // que construyen contexts mínimos.
      this.logger.warn(
        'llm_runtime: missing companyId in PolicyEvaluationContext; returning [] (fail-open)',
      );
      return [];
    }

    const policyText = params.englishText ?? params.originalText;
    const prompt = this.buildPrompt(policyText, ctx);
    let raw: string;
    try {
      const llm = await this.llmResolver.forCompany(ctx.companyId, {
        operation: 'policy.llm_runtime.evaluate',
      });
      raw = await llm.complete(prompt);
    } catch (err) {
      // Budget/allowlist → propagar. La generación de horario aborta
      // con 403 — preferimos que el manager vea el bloqueo a que el
      // verify-loop iterativamente intente y consuma budget.
      if (
        err instanceof LlmBudgetExceededException ||
        err instanceof LlmProviderNotAllowedException
      ) {
        throw err;
      }
      // Fail-open para provider errors: no bloqueamos schedules. La
      // policy sigue activa para próximos intentos.
      this.logger.warn(
        `llm_runtime LLM call failed (${(err as Error).message}); returning [] (fail-open)`,
      );
      return [];
    }

    return this.parseViolations(raw, ctx);
  }

  format(params: LLMRuntimeParams): string {
    // Phase 14 — el prompt del LLM-proposer está en inglés; preferimos
    // la traducción si está, fallback al texto original.
    return params.englishText ?? params.originalText;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private buildPrompt(
    policyText: string,
    ctx: PolicyEvaluationContext,
  ): string {
    const shiftsBlock = ctx.shifts
      .map(
        (s) =>
          `  - employeeId=${s.employeeId} | start=${s.startTime.toISOString()} | end=${s.endTime.toISOString()}`,
      )
      .join('\n');

    return `You are a policy verifier for a workforce scheduler.
The manager defined this company-wide policy in natural language:

POLICY: ${policyText}

The proposed schedule has the following shifts (employee-id, UTC start, UTC end):
${shiftsBlock}

Decide which shift assignments — if any — violate the policy.
Use ONLY the policy text and the shift list above; do not invent extra rules.
If a violation is observed, output it in the JSON below; otherwise return an empty list.

Output ONLY a single JSON object, no prose, no code fences:
{
  "violations": [
    {
      "employeeId": "<the employeeId of the violating shift, or null if global>",
      "scope": "<a date YYYY-MM-DD or other temporal anchor; null if global>",
      "message": "<one short sentence stating the violation in English>"
    }
  ]
}`;
  }

  private parseViolations(
    raw: string,
    ctx: PolicyEvaluationContext,
  ): PolicyViolation[] {
    // Strip code fences if any.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
      this.logger.warn(
        'llm_runtime: no JSON object in LLM output; returning []',
      );
      return [];
    }

    let parsed: { violations?: LLMViolationDTO[] };
    try {
      parsed = JSON.parse(candidate.slice(first, last + 1));
    } catch (err) {
      this.logger.warn(
        `llm_runtime: invalid JSON (${(err as Error).message}); returning []`,
      );
      return [];
    }

    const list = Array.isArray(parsed.violations) ? parsed.violations : [];
    const knownEmployees = new Set(ctx.shifts.map((s) => s.employeeId));
    const violations: PolicyViolation[] = [];
    for (const v of list) {
      const message = (v?.message ?? '').trim();
      if (!message) continue;
      const employeeId =
        v?.employeeId && knownEmployees.has(v.employeeId)
          ? v.employeeId
          : undefined;
      const scope = v?.scope ? String(v.scope) : undefined;
      violations.push({ employeeId, scope, message });
    }
    return violations;
  }
}
