import { LlmRuleRephraseService } from '../../../../src/domain/services/llm-rule-rephrase.service';
import { PolicyInterpreterRegistry } from '../../../../src/domain/services/policy-interpreter-registry';
import { MinRestDaysPerWeekInterpreter } from '../../../../src/domain/services/policy-interpreters/min-rest-days-per-week.interpreter';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';

const makeLlm = (response: string): ILLMService => ({
  complete: jest.fn().mockResolvedValue(response),
});

const makeFailingLlm = (err: Error): ILLMService => ({
  complete: jest.fn().mockRejectedValue(err),
});

describe('LlmRuleRephraseService', () => {
  let registry: PolicyInterpreterRegistry;
  const interpreters = [
    {
      id: 'min_rest_days_per_week',
      description: 'Días libres mínimos por semana',
    },
  ];

  beforeEach(() => {
    registry = new PolicyInterpreterRegistry([new MinRestDaysPerWeekInterpreter()]);
  });

  it('devuelve sugerencias verificadas cuando el LLM propone reformulaciones que matchean', async () => {
    const llmResponse = `[
      {
        "suggestedText": "Cada empleado debe tener al menos 2 días libres por semana",
        "matchedInterpreter": "min_rest_days_per_week",
        "explanation": "Encaja directamente en el patrón de mínimo días libres semanales"
      },
      {
        "suggestedText": "Los empleados descansan 2 días por semana, sin contar feriados",
        "matchedInterpreter": "min_rest_days_per_week",
        "explanation": "Versión que excluye explícitamente los feriados"
      }
    ]`;

    const service = new LlmRuleRephraseService(makeLlm(llmResponse), registry);

    const result = await service.suggest({
      originalText: 'que descansen aparte del feriado',
      reason: 'no_interpreter_matched',
      interpreters,
    });

    expect(result).toHaveLength(2);
    expect(result[0].suggestedText).toMatch(/2 días libres por semana/);
    expect(result[0].matchedInterpreterId).toBe('min_rest_days_per_week');
    expect(result[0].matchedParams).toEqual({ days: 2, holidayCounts: true });
    expect(result[0].id).toMatch(/^[0-9a-f-]{36}$/i);

    expect(result[1].matchedParams).toEqual({ days: 2, holidayCounts: false });
  });

  it('descarta sugerencias hallucinadas del LLM que no matchean ningún interpreter', async () => {
    const llmResponse = `[
      {
        "suggestedText": "Pablo no trabaja los lunes",
        "matchedInterpreter": "min_rest_days_per_week",
        "explanation": "(LLM se equivocó — esto es una rule de caso particular, no una policy)"
      },
      {
        "suggestedText": "Cada empleado tiene 3 días libres por semana",
        "matchedInterpreter": "min_rest_days_per_week",
        "explanation": "OK"
      }
    ]`;

    const service = new LlmRuleRephraseService(makeLlm(llmResponse), registry);

    const result = await service.suggest({
      originalText: 'cosa rara',
      reason: 'no_interpreter_matched',
      interpreters,
    });

    expect(result).toHaveLength(1);
    expect(result[0].suggestedText).toMatch(/3 días libres por semana/);
    expect(result[0].matchedParams).toEqual({ days: 3, holidayCounts: true });
  });

  it('respeta MAX_SUGGESTIONS=3 aunque el LLM proponga más', async () => {
    const llmResponse = `[
      ${Array.from({ length: 5 }, (_, i) => `{
        "suggestedText": "Cada empleado debe tener al menos ${i + 1} día libre por semana",
        "matchedInterpreter": "min_rest_days_per_week",
        "explanation": "ok"
      }`).join(',')}
    ]`;

    const service = new LlmRuleRephraseService(makeLlm(llmResponse), registry);

    const result = await service.suggest({
      originalText: 'algo',
      reason: 'no_interpreter_matched',
      interpreters,
    });

    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('devuelve [] cuando el LLM falla', async () => {
    const service = new LlmRuleRephraseService(
      makeFailingLlm(new Error('timeout')),
      registry,
    );

    const result = await service.suggest({
      originalText: 'cualquier cosa',
      reason: 'no_interpreter_matched',
      interpreters,
    });

    expect(result).toEqual([]);
  });

  it('devuelve [] cuando el LLM responde algo que no es JSON', async () => {
    const service = new LlmRuleRephraseService(
      makeLlm('lo siento, no puedo responder eso'),
      registry,
    );

    const result = await service.suggest({
      originalText: 'algo',
      reason: 'no_interpreter_matched',
      interpreters,
    });

    expect(result).toEqual([]);
  });

  it('devuelve [] si el catálogo de interpreters está vacío', async () => {
    const llmSpy = jest.fn();
    const service = new LlmRuleRephraseService(
      { complete: llmSpy },
      new PolicyInterpreterRegistry([]),
    );

    const result = await service.suggest({
      originalText: 'algo',
      reason: 'no_interpreter_matched',
      interpreters: [],
    });

    expect(result).toEqual([]);
    expect(llmSpy).not.toHaveBeenCalled(); // no se llama al LLM si no hay hacia donde reformular
  });

  it('incluye el reasonDetail en el prompt cuando viene', async () => {
    const completeSpy = jest.fn().mockResolvedValue('[]');
    const service = new LlmRuleRephraseService(
      { complete: completeSpy },
      registry,
    );

    await service.suggest({
      originalText: 'cosa ambigua',
      reason: 'intent_complex',
      reasonDetail: 'No employee subject specified',
      interpreters,
    });

    const prompt = completeSpy.mock.calls[0][0] as string;
    expect(prompt).toContain('cosa ambigua');
    expect(prompt).toContain('No employee subject specified');
    expect(prompt).toContain('min_rest_days_per_week');
  });
});
