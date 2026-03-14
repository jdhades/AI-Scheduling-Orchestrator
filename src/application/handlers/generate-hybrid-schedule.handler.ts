import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import { PromptOrchestratorService } from '../../domain/services/prompt-orchestrator.service';
import { SemanticRetrievalService } from '../../domain/services/semantic-retrieval.service';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { IFairnessHistoryRepository } from '../../domain/repositories/fairness-history.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { FAIRNESS_HISTORY_REPOSITORY } from '../../domain/repositories/fairness-history.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';
import type { Shift } from '../../domain/aggregates/shift.aggregate';

export interface HybridScheduleResult {
    assignmentsCount: number;
    unfilledShiftsCount: number;
    /** Asignaciones originadas en el LLM (validadas) */
    llmAccepted: number;
    /** Turnos que el algoritmo determinístico cubrió */
    algorithmCorrected: number;
    /** Resumen en lenguaje natural */
    explanation: string;
}

/**
 * GenerateHybridScheduleHandler — Command Handler
 *
 * Orquesta la generación híbrida LLM + algoritmo:
 *   1. Carga datos (empleados, turnos, historial fairness)
 *   2. Recupera reglas semánticas vía RAG (E3)
 *   3. Invoca PromptOrchestratorService (doble verificación)
 *   4. Persiste asignaciones y actualiza historiales de fairness
 *   5. Devuelve métricas enriquecidas con trazabilidad del LLM
 */
@CommandHandler(GenerateHybridScheduleCommand)
export class GenerateHybridScheduleHandler
    implements ICommandHandler<GenerateHybridScheduleCommand, HybridScheduleResult> {

    private readonly logger = new Logger(GenerateHybridScheduleHandler.name);

    constructor(
        @Inject(EMPLOYEE_REPOSITORY)
        private readonly employeeRepository: IEmployeeRepository,
        @Inject(SHIFT_REPOSITORY)
        private readonly shiftRepository: IShiftRepository,
        @Inject(FAIRNESS_HISTORY_REPOSITORY)
        private readonly fairnessRepository: IFairnessHistoryRepository,
        private readonly eventBus: EventBus,
        private readonly semanticRetrievalService: SemanticRetrievalService,
        private readonly promptOrchestrator: PromptOrchestratorService,
        private readonly notificationsGateway: NotificationsGateway,
    ) { }

    async execute(command: GenerateHybridScheduleCommand): Promise<HybridScheduleResult> {
        const weekStart = new Date(`${command.weekStart}T00:00:00.000Z`);

        this.logger.log(
            `Hybrid schedule — company=${command.companyId} week=${command.weekStart}`,
        );

        // 1. Cargar datos en paralelo
        const [employees, shifts, histories] = await Promise.all([
            this.employeeRepository.findAllByCompany(command.companyId),
            this.shiftRepository.findByCompanyAndWeek(command.companyId, weekStart),
            this.fairnessRepository.findByWeek(command.companyId, weekStart),
        ]);

        this.logger.log(
            `Loaded — employees=${employees.length} shifts=${shifts.length}`,
        );

        // 2. RAG: recuperar reglas semánticas relevantes
        const semanticRules = await this.semanticRetrievalService.retrieveForShift({
            shiftContext: `empresa ${command.companyId} semana ${command.weekStart} modo hybrid-prompt`,
            companyId: command.companyId,
            shiftDate: weekStart,
        });

        this.logger.log(`RAG: ${semanticRules.length} semantic rules retrieved`);

        // 3. Orquestar LLM + algoritmo
        const result = await this.promptOrchestrator.orchestrate({
            employees,
            shifts,
            histories,
            companyId: command.companyId,
            weekStart,
            semanticRules,
        });

        // 4. Persistir asignaciones
        await Promise.all(
            result.assignments.map(a => this.shiftRepository.saveAssignment(a)),
        );

        // 5. Actualizar historial de fairness
        const updatedHistories = this.buildUpdatedHistories(
            result.assignments, shifts, histories, weekStart, command.companyId,
        );
        await this.fairnessRepository.upsertBatch(updatedHistories);

        // 6. Notificar al frontend vía WebSocket
        this.notificationsGateway.notifyScheduleGenerated(command.companyId, command.weekStart);

        this.logger.log(
            `Hybrid schedule complete — assignments=${result.assignments.length} ` +
            `llmAccepted=${result.llmAccepted} algorithmCorrected=${result.algorithmCorrected} ` +
            `unfilled=${result.unfilledShifts.length}`,
        );

        return {
            assignmentsCount: result.assignments.length,
            unfilledShiftsCount: result.unfilledShifts.length,
            llmAccepted: result.llmAccepted,
            algorithmCorrected: result.algorithmCorrected,
            explanation: result.explanation,
        };
    }

    private buildUpdatedHistories(
        assignments: ShiftAssignment[],
        shifts: Shift[],
        existingHistories: FairnessHistoryVO[],
        weekStart: Date,
        companyId: string,
    ): FairnessHistoryVO[] {
        const historyMap = new Map<string, FairnessHistoryVO>(
            existingHistories.map(h => [h.employeeId, h]),
        );

        for (const assignment of assignments) {
            const shift = shifts.find(s => s.id === assignment.shiftId);
            if (!shift) continue;

            const current = historyMap.get(assignment.employeeId)
                ?? FairnessHistoryVO.empty(assignment.employeeId, companyId, weekStart);

            historyMap.set(assignment.employeeId, current.addShift(shift.getDuration(), {
                isUndesirable: shift.undesirableWeight.isHeavy(),
                isNight: shift.isNightShift(),
                isWeekend: shift.isWeekendShift(),
            }));
        }

        return [...historyMap.values()];
    }
}
