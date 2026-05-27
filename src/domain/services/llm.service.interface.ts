/**
 * ILLMService — Port de dominio para el servicio LLM.
 *
 * Permite testear el dominio con mocks y cambiar de proveedor
 * (Gemini, OpenAI, local) sin tocar la lógica de negocio.
 */
export const LLM_SERVICE = 'LLM_SERVICE';

/**
 * Options para una call individual al LLM.
 *
 * `model` permite que el resolver per-tenant inyecte el modelo del
 * `companies.llm_model` por call. Si no se pasa, el provider usa su
 * default histórico (qwen3.6-plus, gemini-2.0-flash, etc.) — esto
 * preserva backward-compat con callers que aún no propagan modelo.
 *
 * `signal` (antes 2do positional arg) ahora vive acá; permite cancelar
 * la request HTTP subyacente desde el verify-loop o un job cancel.
 */
export interface LLMCompleteOptions {
  signal?: AbortSignal;
  model?: string;
}

export interface ILLMService {
  /**
   * Envía un prompt al LLM y retorna la respuesta cruda como string.
   * La interpretación del output es responsabilidad del llamador.
   *
   * @throws Error si el LLM no responde o supera el timeout
   */
  complete(prompt: string, options?: LLMCompleteOptions): Promise<string>;
}
