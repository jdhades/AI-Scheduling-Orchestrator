/**
 * RuleEmbedding — Value Object
 *
 * Encapsula el vector de embeddings generado por Gemini text-embedding-004.
 *
 * Características:
 *   - Dimensión fija: 768 (text-embedding-004 de Google Gemini)
 *   - Todos los valores deben ser números finitos (no NaN, no Infinity)
 *   - Inmutable — el vector no puede modificarse una vez creado
 *
 * Por qué 768 dimensiones:
 *   Gemini text-embedding-004 produce vectores de 768 dims con soporte multilingüe
 *   optimizado para búsqueda semántica. Compatible con el índice ivfflat de pgvector.
 */
export class RuleEmbedding {
    /** Dimensiones del modelo text-embedding-004 de Gemini */
    static readonly DIMENSIONS = 768;

    private constructor(private readonly vector: ReadonlyArray<number>) { }

    /**
     * Crea un RuleEmbedding desde un array de números.
     * @throws Error si la dimensión no es 768 o si contiene valores no finitos
     */
    static create(vector: number[]): RuleEmbedding {
        if (vector.length !== RuleEmbedding.DIMENSIONS) {
            throw new Error(
                `Invalid embedding dimensions: ${vector.length}. Expected ${RuleEmbedding.DIMENSIONS} (Gemini text-embedding-004)`,
            );
        }

        const hasInvalidValues = vector.some((v) => !Number.isFinite(v));
        if (hasInvalidValues) {
            throw new Error('Embedding vector contains non-finite values (NaN or Infinity)');
        }

        return new RuleEmbedding([...vector]);
    }

    /**
     * Crea un embedding vacío (todos ceros).
     * Útil para tests y como estado inicial antes de llamar a la API.
     */
    static empty(): RuleEmbedding {
        return new RuleEmbedding(new Array<number>(RuleEmbedding.DIMENSIONS).fill(0));
    }

    /**
     * Retorna una copia del vector de números.
     * Se retorna copia para preservar la inmutabilidad.
     */
    getVector(): number[] {
        return [...this.vector];
    }

    /** Número de dimensiones (siempre 768) */
    getDimensions(): number {
        return this.vector.length;
    }

    /**
     * Convierte el vector al formato de string que espera pgvector.
     * Ejemplo: "[0.1,0.2,...,0.768]"
     */
    toPgVectorString(): string {
        return `[${this.vector.join(',')}]`;
    }

    /**
     * Calcula la similitud coseno entre dos embeddings (0 = opuesto, 1 = idéntico).
     * Útil para comparaciones en tests sin necesidad de DB.
     */
    cosineSimilarity(other: RuleEmbedding): number {
        const a = this.vector;
        const b = other.vector;

        let dot = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    equals(other: RuleEmbedding): boolean {
        return this.vector.every((v, i) => v === other.vector[i]);
    }

    toString(): string {
        return `RuleEmbedding(${RuleEmbedding.DIMENSIONS}dims)`;
    }
}
