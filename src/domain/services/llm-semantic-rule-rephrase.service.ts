import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  LlmBudgetExceededException,
  LlmProviderNotAllowedException,
  LlmResolverService,
} from '../../application/services/llm-resolver.service';
import {
  type ISemanticRuleRephraseService,
  type SemanticRuleRephraseInput,
  type SemanticRuleSuggestion,
} from './semantic-rule-rephrase.service.interface';

/**
 * LlmSemanticRuleRephraseService
 *
 * Implementa el suggestion-loop para SemanticRule. El LLM recibe el
 * texto ambiguo + complexReason + el catálogo de matchers del schema
 * y devuelve 2-3 reformulaciones. No pre-verifica (ver doc del
 * interface).
 *
 * Post sprint llm-enforcement (2026-05-27): el LLM lo obtenemos via
 * LlmResolverService — eso aplica provider/model per-tenant + budget +
 * allowlist. Si el tenant excedió budget o el modelo no está allowed,
 * la excepción propaga al handler y termina el flow (la sugerencia
 * queda en lista vacía, comportamiento idéntico al de un LLM fail).
 */
@Injectable()
export class LlmSemanticRuleRephraseService implements ISemanticRuleRephraseService {
  private readonly logger = new Logger(LlmSemanticRuleRephraseService.name);
  private static readonly MAX_SUGGESTIONS = 3;

  constructor(private readonly llmResolver: LlmResolverService) {}

  async suggest(
    input: SemanticRuleRephraseInput,
  ): Promise<SemanticRuleSuggestion[]> {
    const prompt = this.buildPrompt(input);

    let raw: string;
    try {
      const llm = await this.llmResolver.forCompany(input.companyId, {
        operation: 'rule.rephrase_suggest',
      });
      raw = await llm.complete(prompt);
    } catch (error) {
      // Budget/allowlist → propagar (el manager debe ver el 403).
      // Resto → fail-open: sugerencias vacías es la semántica histórica
      // ante un LLM call problemático.
      if (
        error instanceof LlmBudgetExceededException ||
        error instanceof LlmProviderNotAllowedException
      ) {
        throw error;
      }
      this.logger.warn(
        `LlmSemanticRuleRephraseService: LLM call failed for "${input.originalText.substring(0, 60)}". Error: ${(error as Error).message}`,
      );
      return [];
    }

    const candidates = this.parseLlmResponse(raw);
    if (candidates === null) return [];

    return candidates
      .slice(0, LlmSemanticRuleRephraseService.MAX_SUGGESTIONS)
      .map((cand) => ({
        id: randomUUID(),
        suggestedText: cand.suggestedText,
        explanation:
          typeof cand.explanation === 'string' && cand.explanation.length > 0
            ? cand.explanation
            : 'Reformulación más concreta en términos del schema.',
        previewIntent:
          typeof cand.previewIntent === 'string'
            ? cand.previewIntent
            : undefined,
      }));
  }

  private buildPrompt(input: SemanticRuleRephraseInput): string {
    return [
      'Sos un asistente que ayuda a un manager a reformular una regla de scheduling',
      'para que el sistema pueda aplicarla deterministicamente.',
      '',
      `Texto original del manager: "${input.originalText}"`,
      '',
      `Por qué la regla actual es ambigua: ${input.complexReason}`,
      '',
      'El sistema solo puede aplicar reglas que se expresan con estos matchers:',
      '  - employeeMatchers : a quién aplica (empleado específico, grupo, o todos)',
      '  - dateMatchers     : qué fechas (fecha concreta, día de la semana, o rango)',
      '  - hourRangeMatchers: qué franja horaria',
      '  - shiftNameMatchers: qué shift_template puntual',
      '',
      'Y solo soporta estos intents:',
      '  - block               : prohibición ("X no puede trabajar Y")',
      '  - permit-multi-shift  : excepción que habilita doble turno',
      '  - preference          : preferencia suave ("X prefiere Y")',
      '',
      'Proponé entre 2 y 3 reformulaciones del texto original que:',
      '- Preserven la intención del manager.',
      '- Sean concretas en términos de los matchers e intents arriba.',
      '- Estén escritas en español claro y sin ambigüedad.',
      '- Eviten ser counting/distribution rules ("N días por semana") —',
      '  esas pertenecen al sistema de Políticas, no a Reglas semánticas.',
      '',
      'Respondé SOLO con un JSON array (sin texto extra):',
      '[',
      '  {',
      '    "suggestedText": "<reformulación en español>",',
      '    "previewIntent": "<block | permit-multi-shift | preference>",',
      '    "explanation": "<por qué esta versión sí se puede aplicar>"',
      '  }',
      ']',
    ].join('\n');
  }

  private parseLlmResponse(raw: string): Array<{
    suggestedText: string;
    previewIntent?: string;
    explanation?: string;
  }> | null {
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      this.logger.warn(
        `LlmSemanticRuleRephraseService: respuesta del LLM sin JSON. Raw: ${raw.substring(0, 200)}`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch (error) {
      this.logger.warn(
        `LlmSemanticRuleRephraseService: JSON inválido. Error: ${(error as Error).message}`,
      );
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    return parsed.flatMap((item) => {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { suggestedText?: unknown }).suggestedText === 'string'
      ) {
        const obj = item as Record<string, unknown>;
        return [
          {
            suggestedText: obj.suggestedText as string,
            previewIntent:
              typeof obj.previewIntent === 'string'
                ? obj.previewIntent
                : undefined,
            explanation:
              typeof obj.explanation === 'string' ? obj.explanation : undefined,
          },
        ];
      }
      return [];
    });
  }
}
