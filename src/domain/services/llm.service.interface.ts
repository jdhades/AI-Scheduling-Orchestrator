/**
 * ILLMService — Port de dominio para el servicio LLM.
 *
 * Permite testear el dominio con mocks y cambiar de proveedor
 * (Gemini, OpenAI, local) sin tocar la lógica de negocio.
 */
export const LLM_SERVICE = 'LLM_SERVICE';

export interface ILLMService {
    /**
     * Envía un prompt al LLM y retorna la respuesta cruda como string.
     * La interpretación del output es responsabilidad del llamador.
     *
     * @throws Error si el LLM no responde o supera el timeout
     */
    complete(prompt: string): Promise<string>;
}
