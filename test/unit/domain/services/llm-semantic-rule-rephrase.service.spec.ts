import { LlmSemanticRuleRephraseService } from '../../../../src/domain/services/llm-semantic-rule-rephrase.service';
import type { ILLMService } from '../../../../src/domain/services/llm.service.interface';
import type { LlmResolverService } from '../../../../src/application/services/llm-resolver.service';

/**
 * Helper: arma un mock del resolver que delega al ILLMService pasado.
 * Permite controlar qué responde el LLM sin tocar las dependencias
 * pesadas del resolver real (budget, allowlist, promptHistory).
 */
const makeResolver = (llm: ILLMService): LlmResolverService =>
  ({
    forCompany: jest.fn().mockResolvedValue(llm),
    default: jest.fn().mockReturnValue(llm),
  }) as unknown as LlmResolverService;

const makeLlm = (response: string): ILLMService => ({
  complete: jest.fn().mockResolvedValue(response),
});
const makeFailingLlm = (err: Error): ILLMService => ({
  complete: jest.fn().mockRejectedValue(err),
});

const baseInput = {
  originalText: 'x',
  complexReason: 'y',
  companyId: 'co-1',
};

describe('LlmSemanticRuleRephraseService', () => {
  it('parsea sugerencias del LLM y devuelve hasta 3', async () => {
    const llmResponse = `[
      { "suggestedText": "Pablo no trabaja los lunes", "previewIntent": "block", "explanation": "Sujeto + día concreto" },
      { "suggestedText": "Sofía prefiere turnos de mañana", "previewIntent": "preference", "explanation": "Preferencia explícita" }
    ]`;

    const service = new LlmSemanticRuleRephraseService(
      makeResolver(makeLlm(llmResponse)),
    );

    const result = await service.suggest({
      originalText: 'el día después de pasado mañana es bueno',
      complexReason: 'Fecha relativa sin ancla, no hay sujeto.',
      companyId: 'co-1',
    });

    expect(result).toHaveLength(2);
    expect(result[0].suggestedText).toBe('Pablo no trabaja los lunes');
    expect(result[0].previewIntent).toBe('block');
    expect(result[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result[1].previewIntent).toBe('preference');
  });

  it('respeta el cap de 3 sugerencias aunque el LLM proponga más', async () => {
    const llmResponse = `[${Array.from(
      { length: 5 },
      (_, i) => `
      {"suggestedText":"opcion ${i}","previewIntent":"block","explanation":"x"}
    `,
    ).join(',')}]`;

    const service = new LlmSemanticRuleRephraseService(
      makeResolver(makeLlm(llmResponse)),
    );
    const result = await service.suggest({
      ...baseInput,
      originalText: 'algo',
      complexReason: 'razón',
    });
    expect(result).toHaveLength(3);
  });

  it('cae a [] cuando el LLM falla', async () => {
    const service = new LlmSemanticRuleRephraseService(
      makeResolver(makeFailingLlm(new Error('timeout'))),
    );
    expect(await service.suggest(baseInput)).toEqual([]);
  });

  it('cae a [] cuando el LLM no responde JSON', async () => {
    const service = new LlmSemanticRuleRephraseService(
      makeResolver(makeLlm('lo siento, no puedo ayudarte')),
    );
    expect(await service.suggest(baseInput)).toEqual([]);
  });

  it('descarta items malformados (sin suggestedText) sin tirar el resto', async () => {
    const llmResponse = `[
      { "suggestedText": "Buena", "previewIntent": "block" },
      { "previewIntent": "block", "explanation": "sin texto" },
      { "suggestedText": "También buena" }
    ]`;
    const service = new LlmSemanticRuleRephraseService(
      makeResolver(makeLlm(llmResponse)),
    );
    const result = await service.suggest(baseInput);
    expect(result).toHaveLength(2);
    expect(result[0].suggestedText).toBe('Buena');
    expect(result[1].suggestedText).toBe('También buena');
  });

  it('incluye el complexReason del extractor en el prompt', async () => {
    const completeSpy = jest.fn().mockResolvedValue('[]');
    const service = new LlmSemanticRuleRephraseService(
      makeResolver({ complete: completeSpy }),
    );

    await service.suggest({
      originalText: 'cosa rara',
      complexReason: 'Fecha relativa sin ancla',
      companyId: 'co-1',
    });

    const prompt = completeSpy.mock.calls[0][0] as string;
    expect(prompt).toContain('cosa rara');
    expect(prompt).toContain('Fecha relativa sin ancla');
    expect(prompt).toContain('employeeMatchers');
    expect(prompt).toContain('block');
  });
});
