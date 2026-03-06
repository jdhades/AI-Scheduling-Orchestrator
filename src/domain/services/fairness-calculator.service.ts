import { FairnessScore } from '../value-objects/fairness-score.vo';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';

/**
 * FairnessCalculator — Domain Service
 *
 * Calcula el FairnessScore de un empleado usando la fórmula determinística:
 *
 *   raw = (undesirableCount × 2.0)
 *       + (nightShiftCount  × 1.5)
 *       + (weekendCount     × 1.2)
 *       - (voluntaryExtraShifts × 0.5)
 *
 * El raw score se normaliza a [0..1000] usando el techo teórico máximo de la semana.
 *
 * Propiedades garantizadas:
 *   - Determinístico: mismos inputs → mismo output siempre
 *   - Reproducible: se puede re-calcular desde el historial
 *   - Snapshotable: se captura en ShiftAssignment.fairnessSnapshot
 */
export class FairnessCalculator {
    /**
     * Techo teórico: máximo raw score posible en 7 días (21 turnos indeseables = 42)
     * Usado para normalizar a 0–1000.
     */
    private static readonly THEORETICAL_MAX = 42;

    /**
     * Calcula el FairnessScore normalizado para un empleado.
     */
    compute(history: FairnessHistoryVO): FairnessScore {
        const raw = history.computeRawScore();
        const clamped = Math.max(0, raw); // no negativos por turnos voluntarios
        const normalized = Math.round((clamped / FairnessCalculator.THEORETICAL_MAX) * FairnessScore.MAX);
        const bounded = Math.min(normalized, FairnessScore.MAX);

        return FairnessScore.create(bounded);
    }

    /**
     * Calcula el score de todos los empleados y devuelve un mapa employeeId → FairnessScore.
     */
    computeAll(histories: FairnessHistoryVO[]): Map<string, FairnessScore> {
        const result = new Map<string, FairnessScore>();
        for (const history of histories) {
            result.set(history.employeeId, this.compute(history));
        }
        return result;
    }

    /**
     * Calcula la varianza de fairness entre empleados.
     * Métrica de calidad: menor varianza = distribución más equitativa.
     */
    computeVariance(scores: FairnessScore[]): number {
        if (scores.length === 0) return 0;

        const values = scores.map(s => s.value);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const squaredDiffs = values.map(v => Math.pow(v - mean, 2));

        return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    }

    /**
     * Construye un snapshot de scores para embedder en ShiftAssignment.
     */
    buildSnapshot(histories: FairnessHistoryVO[]): Record<string, number> {
        const snap: Record<string, number> = {};
        for (const h of histories) {
            snap[h.employeeId] = this.compute(h).value;
        }
        return snap;
    }
}
