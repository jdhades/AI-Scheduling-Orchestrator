/**
 * FairnessThresholdGuard — Domain Service
 *
 * Protege a los empleados de recibir más turnos pesados cuando su
 * fairness score acumulado supera el límite configurado por empresa.
 */
export class FairnessThresholdGuard {
    static readonly DEFAULT_MAX = 700;    // de 1000
    static readonly ABSOLUTE_MAX = 1000;

    constructor(private readonly maxDeviation: number = FairnessThresholdGuard.DEFAULT_MAX) {
        if (maxDeviation < 0 || maxDeviation > FairnessThresholdGuard.ABSOLUTE_MAX) {
            throw new Error(
                `maxDeviation must be between 0 and ${FairnessThresholdGuard.ABSOLUTE_MAX}, got ${maxDeviation}`,
            );
        }
    }

    /**
     * ¿Puede el empleado recibir un turno pesado (undesirableWeight > 5)?
     */
    canReceiveHeavyShift(scoreValue: number): boolean {
        return scoreValue <= this.maxDeviation;
    }

    /**
     * Filtra los candidatos que aún tienen capacidad para turnos pesados.
     * @param candidates Mapa employeeId → scoreValue
     */
    filterEligible(candidates: Map<string, number>): string[] {
        const result: string[] = [];
        for (const [employeeId, score] of candidates) {
            if (this.canReceiveHeavyShift(score)) {
                result.push(employeeId);
            }
        }
        return result;
    }

    get threshold(): number {
        return this.maxDeviation;
    }
}
