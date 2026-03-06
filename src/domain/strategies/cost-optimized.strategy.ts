import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type { SchedulingStrategy, SemanticConstraint, StrategyResult } from './scheduling-strategy.interface';

/**
 * CostOptimizedStrategy — Strategy Pattern
 *
 * Objetivo: minimizar el costo de la nómina semanal.
 *
 * Algoritmo (Greedy por costo):
 *   1. Para cada turno, filtrar candidatos con el skill requerido
 *   2. Ordenar por nivel de experiencia ASC (Junior < Intermediate < Senior)
 *      → usar el recurso más económico suficiente para el turno
 *   3. Aplicar penalización del 20% si el fairness score supera threshold
 *   4. Asignar al candidato de menor costo efectivo
 *   5. Marcar empleado como ocupado en ese slot para evitar solapamientos
 *
 * Complejidad: O(n log n) por turno — pre-indexación de skills con Map.
 */
export class CostOptimizedStrategy implements SchedulingStrategy {
    readonly type = 'cost' as const;

    private static readonly EXPERIENCE_COST: Record<string, number> = {
        junior: 1,
        intermediate: 2,
        senior: 3,
    };

    private static readonly FAIRNESS_PENALTY_THRESHOLD = 600; // de 1000
    private static readonly FAIRNESS_PENALTY_FACTOR = 1.2;  // +20%

    generate(
        employees: Employee[],
        shifts: Shift[],
        histories: FairnessHistoryVO[],
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _semanticRules?: SemanticConstraint[],
    ): StrategyResult {
        // Índice de historial por employeeId — O(1) lookup
        const historyIndex = new Map<string, FairnessHistoryVO>(
            histories.map(h => [h.employeeId, h]),
        );

        // Snapshot de scores actuales para embeber en c/asignación
        const snapshot = this.buildSnapshot(histories);

        // Rastrear ocupación: employeeId → slots asignados
        const busySlots = new Map<string, Shift[]>();
        for (const e of employees) busySlots.set(e.id, []);

        // Pre-indexar employees por skill: skillId → Employee[]
        const skillIndex = this.buildSkillIndex(employees);

        const assignments: ShiftAssignment[] = [];
        const unfilledShifts: Shift[] = [];

        // Ordenar turnos por demandScore DESC (cubrir los más críticos primero)
        const sortedShifts = [...shifts].sort(
            (a, b) => b.demandScore.value - a.demandScore.value,
        );

        for (const shift of sortedShifts) {
            const candidates = this.getCandidates(shift, skillIndex, busySlots);

            if (candidates.length === 0) {
                unfilledShifts.push(shift);
                continue;
            }

            // Ordenar por costo efectivo (base + penalización por fairness)
            const ranked = candidates.sort((a, b) => {
                const costA = this.effectiveCost(a, historyIndex.get(a.id));
                const costB = this.effectiveCost(b, historyIndex.get(b.id));
                return costA - costB;
            });

            const winner = ranked[0];
            busySlots.get(winner.id)!.push(shift);

            assignments.push(ShiftAssignment.create({
                id: randomUUID(),
                shiftId: shift.id,
                employeeId: winner.id,
                companyId: shift.companyId,
                strategyType: this.type,
                fairnessSnapshot: { ...snapshot },
            }));
        }

        return { assignments, unfilledShifts };
    }

    private effectiveCost(employee: Employee, history?: FairnessHistoryVO): number {
        const baseCost = CostOptimizedStrategy.EXPERIENCE_COST[
            employee.experienceMonths >= 24 ? 'senior'
                : employee.experienceMonths >= 6 ? 'intermediate'
                    : 'junior'
        ] ?? 1;

        const rawScore = history?.computeRawScore() ?? 0;
        const fairnessMultiplier = rawScore > CostOptimizedStrategy.FAIRNESS_PENALTY_THRESHOLD
            ? CostOptimizedStrategy.FAIRNESS_PENALTY_FACTOR
            : 1;

        return baseCost * fairnessMultiplier;
    }

    private buildSkillIndex(employees: Employee[]): Map<string, Employee[]> {
        const index = new Map<string, Employee[]>();
        for (const emp of employees) {
            for (const skill of emp.getSkills()) {
                if (!index.has(skill.id)) index.set(skill.id, []);
                index.get(skill.id)!.push(emp);
            }
        }
        return index;
    }

    private getCandidates(
        shift: Shift,
        skillIndex: Map<string, Employee[]>,
        busySlots: Map<string, Shift[]>,
    ): Employee[] {
        const pool = shift.requiredSkillId
            ? (skillIndex.get(shift.requiredSkillId) ?? [])
            : [...skillIndex.values()].flat();

        return pool.filter(emp => {
            const busy = busySlots.get(emp.id) ?? [];
            return !busy.some(s => s.overlapsWith(shift));
        });
    }

    private buildSnapshot(histories: FairnessHistoryVO[]): Record<string, number> {
        const snap: Record<string, number> = {};
        for (const h of histories) snap[h.employeeId] = h.computeRawScore();
        return snap;
    }
}
