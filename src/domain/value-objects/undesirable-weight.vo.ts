/**
 * UndesirableWeight — Value Object
 *
 * Representa qué tan "pesado" o indeseable es un turno para los empleados.
 * 0 = turno normal, 10 = turno extremadamente indeseable
 *
 * Usado por FairnessCalculator para ponderar la acumulación de carga.
 * Turnos con peso alto reducen más rápido la capacidad de recibir más turnosd difíciles.
 */
export class UndesirableWeight {
    static readonly MIN = 0;
    static readonly MAX = 10;

    private constructor(public readonly value: number) { }

    static create(value: number): UndesirableWeight {
        if (!Number.isFinite(value) || value < UndesirableWeight.MIN || value > UndesirableWeight.MAX) {
            throw new Error(
                `UndesirableWeight must be between ${UndesirableWeight.MIN} and ${UndesirableWeight.MAX}, got ${value}`,
            );
        }
        return new UndesirableWeight(value);
    }

    static normal(): UndesirableWeight { return new UndesirableWeight(0); }
    static moderate(): UndesirableWeight { return new UndesirableWeight(4); }
    static heavy(): UndesirableWeight { return new UndesirableWeight(7); }
    static extreme(): UndesirableWeight { return new UndesirableWeight(10); }

    /**
     * Un turno se considera "pesado" si su peso supera el umbral de 5.
     * Empleados saturados no pueden recibir turnos pesados (FairnessThresholdGuard).
     */
    isHeavy(): boolean {
        return this.value > 5;
    }

    /** Normalizado a [0..1] para usar en fórmulas de scoring */
    normalized(): number {
        return this.value / UndesirableWeight.MAX;
    }
}
