/**
 * DemandWeight — Value Object
 *
 * Representa la urgencia de cubrir un turno específico.
 * 0 = turno opcional, 10 = turno crítico (no puede quedar sin cubrir)
 *
 * Usado por HybridStrategy para priorizar la cobertura de turnos urgentes.
 */
export class DemandWeight {
    static readonly MIN = 0;
    static readonly MAX = 10;

    private constructor(public readonly value: number) { }

    static create(value: number): DemandWeight {
        if (!Number.isFinite(value) || value < DemandWeight.MIN || value > DemandWeight.MAX) {
            throw new Error(
                `DemandWeight must be between ${DemandWeight.MIN} and ${DemandWeight.MAX}, got ${value}`,
            );
        }
        return new DemandWeight(value);
    }

    static low(): DemandWeight { return new DemandWeight(2); }
    static medium(): DemandWeight { return new DemandWeight(5); }
    static high(): DemandWeight { return new DemandWeight(8); }
    static critical(): DemandWeight { return new DemandWeight(10); }

    isCritical(): boolean {
        return this.value >= 9;
    }

    /** Normalizado a [0..1] para usar en fórmulas de scoring */
    normalized(): number {
        return this.value / DemandWeight.MAX;
    }

    isHigherThan(other: DemandWeight): boolean {
        return this.value > other.value;
    }
}
