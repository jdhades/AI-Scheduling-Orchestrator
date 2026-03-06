import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';

/**
 * IFairnessHistoryRepository — Port (Domain Layer)
 *
 * Persiste y recupera el historial acumulado de fairness por empleado y semana.
 */
export interface IFairnessHistoryRepository {
    /**
     * Devuelve el historial de fairness de todos los empleados de la empresa
     * para la semana indicada (lunes).
     */
    findByWeek(companyId: string, weekStart: Date): Promise<FairnessHistoryVO[]>;

    /**
     * Devuelve el historial de un empleado específico.
     */
    findByEmployeeAndWeek(
        employeeId: string,
        companyId: string,
        weekStart: Date,
    ): Promise<FairnessHistoryVO | null>;

    /**
     * Crea o actualiza el historial de un empleado para la semana.
     */
    upsert(history: FairnessHistoryVO): Promise<void>;

    /**
     * Upsert en batch — eficiente para persistir todos los historiales
     * actualizados tras una ejecución del SchedulingEngine.
     */
    upsertBatch(histories: FairnessHistoryVO[]): Promise<void>;
}

export const FAIRNESS_HISTORY_REPOSITORY = 'FAIRNESS_HISTORY_REPOSITORY';
