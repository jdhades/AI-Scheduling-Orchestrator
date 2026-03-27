/**
 * IEmbeddingService — Port (interface de dominio)
 *
 * Define el contrato para convertir texto en vectores de embeddings.
 * La implementación concreta (Gemini) vive en la capa de infraestructura,
 * permitiendo cambiar el proveedor sin tocar el dominio.
 */
export interface IEmbeddingService {
  /**
   * Convierte un texto en un vector de embeddings.
   * @param text Texto a vectorizar (min 1 char, max 1000 chars)
   * @returns Vector de 768 dimensiones (Gemini text-embedding-004)
   * @throws Error si la API falla o el texto está vacío
   */
  generate(text: string): Promise<number[]>;

  /**
   * Convierte múltiples textos en paralelo.
   * Útil para batch processing de reglas al inicializar.
   */
  generateBatch(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_SERVICE_TOKEN = 'EMBEDDING_SERVICE';
