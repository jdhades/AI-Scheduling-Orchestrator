import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type { SchedulingStrategy, SemanticConstraint, StrategyResult } from './scheduling-strategy.interface';

/**
 * FairnessOptimizedStrategy — Strategy Pattern
 *
 * Objetivo: distribuir cargas pesadas (nocturnos, fines de semana, indeseables)
 * de forma equitativa entre todos los empleados.
 *
 * Algoritmo:
 *   1. Para cada turno (ordenados por undesirableWeight DESC — más pesados primero)
 *   2. Filtrar candidatos con skill válido y sin solapamiento
 *   3. Ordenar candidatos por menor fairness score acumulado (más descansados primero)
 *   4. Asignar al primero de la lista
 *   5. Actualizar el score en memoria para la siguiente iteración
 *      → garantiza que si A recibe un turno duro, B será considerado antes en el siguiente
 *
 * Complejidad: O(n log n) — el sort de candidatos es dominante.
 */
export class FairnessOptimizedStrategy implements SchedulingStrategy {
    readonly type = 'fairness' as const;

    generate(
        employees: Employee[],
        shifts: Shift[],
        histories: FairnessHistoryVO[],
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _semanticRules?: SemanticConstraint[],
    ): StrategyResult {
        // Historial mutable en memoria — se actualiza en c/asignación
        const liveHistory = new Map<string, FairnessHistoryVO>(
            employees.map(e => {
                const existing = histories.find(h => h.employeeId === e.id);
                return [e.id, existing ?? FairnessHistoryVO.empty(e.id, e.companyId, new Date())];
            }),
        );

        // Pre-indexar employees por skill
        const skillIndex = this.buildSkillIndex(employees);
        const busySlots = new Map<string, Shift[]>();
        for (const e of employees) busySlots.set(e.id, []);

        const assignments: ShiftAssignment[] = [];
        const unfilledShifts: Shift[] = [];

        // Turnos más pesados primero — maximiza distribución equitativa de carga
        const sortedShifts = [...shifts].sort(
            (a, b) => b.undesirableWeight.value - a.undesirableWeight.value,
        );

        for (const shift of sortedShifts) {
            const candidates = this.getCandidates(shift, skillIndex, busySlots);

            if (candidates.length === 0) {
                unfilledShifts.push(shift);
                continue;
            }

            // Ordenar por menor raw score (más descansados primero)
            const ranked = candidates.sort((a, b) => {
                const scoreA = liveHistory.get(a.id)?.computeRawScore() ?? 0;
                const scoreB = liveHistory.get(b.id)?.computeRawScore() ?? 0;
                return scoreA - scoreB;
            });

            const winner = ranked[0];
            busySlots.get(winner.id)!.push(shift);

            // Snapshot del estado ANTES de asignar
            const snapshot = this.buildSnapshot(liveHistory);

            assignments.push(ShiftAssignment.create({
                id: randomUUID(),
                shiftId: shift.id,
                employeeId: winner.id,
                companyId: shift.companyId,
                strategyType: this.type,
                fairnessSnapshot: snapshot,
            }));

            // Actualizar historial en memoria para la siguiente iteración
            const currentHistory = liveHistory.get(winner.id)!;
            liveHistory.set(winner.id, currentHistory.addShift(shift.getDuration(), {
                isUndesirable: shift.undesirableWeight.isHeavy(),
                isNight: shift.isNightShift(),
                isWeekend: shift.isWeekendShift(),
            }));
        }

        return { assignments, unfilledShifts };
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
            : [...new Set([...skillIndex.values()].flat())];

        return pool.filter(emp => {
            const busy = busySlots.get(emp.id) ?? [];
            return !busy.some(s => s.overlapsWith(shift));
        });
    }

    private buildSnapshot(liveHistory: Map<string, FairnessHistoryVO>): Record<string, number> {
        const snap: Record<string, number> = {};
        for (const [id, h] of liveHistory) snap[id] = h.computeRawScore();
        return snap;
    }
}
