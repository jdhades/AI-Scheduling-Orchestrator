import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LLM_SERVICE, type ILLMService } from './llm.service.interface';
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
 */
@Injectable()
export class LlmSemanticRuleRephraseService implements ISemanticRuleRephraseService {
  private readonly logger = new Logger(LlmSemanticRuleRephraseService.name);
  private static readonly MAX_SUGGESTIONS = 3;

  constructor(@Inject(LLM_SERVICE) private readonly llm: ILLMService) {}

  async suggest(
    input: SemanticRuleRephraseInput,
  ): Promise<SemanticRuleSuggestion[]> {
    const prompt = this.buildPrompt(input);

    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (error) {
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
