import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LLM_SERVICE, type ILLMService } from './llm.service.interface';
import {
  type IRuleRephraseService,
  type RephraseInput,
  type RephraseSuggestion,
} from './rule-rephrase.service.interface';
import { PolicyInterpreterRegistry } from './policy-interpreter-registry';

/**
 * LlmRuleRephraseService
 *
 * Implementa el suggestion-loop pidiendo al LLM 2-3 reformulaciones del
 * texto original orientadas a alguno de los interpreters disponibles.
 * Para cada sugerencia, verifica empíricamente contra el registry que
 * realmente matchee — descarta hallucinations.
 *
 * Si todo falla devuelve []. El caller decide qué hacer (típicamente:
 * persistir la policy como LLM-only y avisar al manager).
 */
@Injectable()
export class LlmRuleRephraseService implements IRuleRephraseService {
  private readonly logger = new Logger(LlmRuleRephraseService.name);
  private static readonly MAX_SUGGESTIONS = 3;

  constructor(
    @Inject(LLM_SERVICE) private readonly llm: ILLMService,
    private readonly registry: PolicyInterpreterRegistry,
  ) {}

  async suggest(input: RephraseInput): Promise<RephraseSuggestion[]> {
    if (input.interpreters.length === 0) {
      // Sin patterns disponibles, no hay nada hacia donde reformular.
      return [];
    }

    const prompt = this.buildPrompt(input);

    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (error) {
      this.logger.warn(
        `LlmRuleRephraseService: LLM call failed for "${input.originalText.substring(0, 60)}". Error: ${(error as Error).message}`,
      );
      return [];
    }

    const candidates = this.parseLlmResponse(raw);
    if (candidates === null) return [];

    // Verificación empírica: la sugerencia tiene que matchear realmente.
    // Si el LLM dijo "X" pero ningún interpreter matchea X, no la
    // ofrecemos al usuario — sería poner trampas.
    const verified: RephraseSuggestion[] = [];
    for (const cand of candidates.slice(
      0,
      LlmRuleRephraseService.MAX_SUGGESTIONS,
    )) {
      const matched = this.registry.findMatch(cand.suggestedText);
      if (!matched) {
        this.logger.debug(
          `LlmRuleRephraseService: descartada sugerencia "${cand.suggestedText}" — no matchea ningún interpreter.`,
        );
        continue;
      }
      // El LLM puede haber sugerido un interpreter distinto al que
      // realmente matchea — usamos el verificado.
      let params: Record<string, unknown>;
      try {
        params = await matched.extractParams(cand.suggestedText);
      } catch (error) {
        this.logger.debug(
          `LlmRuleRephraseService: extractParams falló para "${cand.suggestedText}". Error: ${(error as Error).message}`,
        );
        continue;
      }
      verified.push({
        id: randomUUID(),
        suggestedText: cand.suggestedText,
        matchedInterpreterId: matched.id,
        matchedParams: params,
        explanation:
          typeof cand.explanation === 'string' && cand.explanation.length > 0
            ? cand.explanation
            : `Esta versión se ajusta al patrón "${matched.id}".`,
      });
    }

    return verified;
  }

  private buildPrompt(input: RephraseInput): string {
    const interpreterCatalog = input.interpreters
      .map((it, i) => `  ${i + 1}. ${it.id}: ${it.description}`)
      .join('\n');

    const reasonExplanation = (() => {
      if (input.reason === 'no_interpreter_matched') {
        return 'El sistema no encontró un patrón estructurado para aplicar esta política.';
      }
      return (
        'El extractor de estructura marcó esta regla como ambigua o no estructurable' +
        (input.reasonDetail ? `. Motivo: ${input.reasonDetail}` : '.')
      );
    })();

    return [
      'Sos un asistente que ayuda a un manager a reformular políticas de empresa para',
      'que el sistema de scheduling pueda aplicarlas automáticamente.',
      '',
      `Texto original del manager: "${input.originalText}"`,
      '',
      `Por qué no se pudo aplicar tal cual: ${reasonExplanation}`,
      '',
      'Patrones disponibles que el sistema sí puede aplicar deterministamente:',
      interpreterCatalog,
      '',
      'Proponé entre 2 y 3 reformulaciones del texto original que:',
      '- Preserven la intención del manager.',
      '- Encajen exactamente en uno de los patrones disponibles arriba.',
      '- Estén escritas en español claro y sin ambigüedad.',
      '',
      'Respondé SOLO con un JSON array (sin texto extra), siguiendo este shape:',
      '[',
      '  {',
      '    "suggestedText": "<reformulación en español>",',
      '    "matchedInterpreter": "<id del patrón>",',
      '    "explanation": "<por qué esta versión sí se puede aplicar>"',
      '  }',
      ']',
    ].join('\n');
  }

  private parseLlmResponse(raw: string): Array<{
    suggestedText: string;
    matchedInterpreter?: string;
    explanation?: string;
  }> | null {
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      this.logger.warn(
        `LlmRuleRephraseService: respuesta del LLM sin array JSON. Raw: ${raw.substring(0, 200)}`,
      );
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(arrayMatch[0]);
    } catch (error) {
      this.logger.warn(
        `LlmRuleRephraseService: JSON inválido. Error: ${(error as Error).message}`,
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
            matchedInterpreter:
              typeof obj.matchedInterpreter === 'string'
                ? obj.matchedInterpreter
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
