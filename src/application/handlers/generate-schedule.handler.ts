import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { GenerateScheduleCommand } from '../commands/generate-schedule.command';
import { ScheduleAggregate } from '../../domain/aggregates/schedule.aggregate';
import { CostOptimizedStrategy } from '../../domain/strategies/cost-optimized.strategy';
import { FairnessOptimizedStrategy } from '../../domain/strategies/fairness-optimized.strategy';
import { HybridStrategy } from '../../domain/strategies/hybrid.strategy';
import type { SchedulingStrategy } from '../../domain/strategies/scheduling-strategy.interface';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { IFairnessHistoryRepository } from '../../domain/repositories/fairness-history.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { FAIRNESS_HISTORY_REPOSITORY } from '../../domain/repositories/fairness-history.repository';
import { ScheduleQualityReport } from '../../domain/services/schedule-quality-analyzer.service';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';
import type { Shift } from '../../domain/aggregates/shift.aggregate';
import { SemanticRetrievalService } from '../../domain/services/semantic-retrieval.service';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';

export interface GenerateScheduleResult {
  assignmentsCount: number;
  unfilledShiftsCount: number;
  quality: ScheduleQualityReport;
}

/**
 * GenerateScheduleHandler — Command Handler
 *
 * Orquesta la generación de un horario completo:
 *   1. Carga empleados, turnos e historial de fairness
 *   2. Instancia la estrategia solicitada
 *   3. Delega en ScheduleAggregate.generate()
 *   4. Valida invariantes
 *   5. Persiste asignaciones y actualiza historiales
 */
@CommandHandler(GenerateScheduleCommand)
export class GenerateScheduleHandler implements ICommandHandler<
  GenerateScheduleCommand,
  GenerateScheduleResult
> {
  private readonly logger = new Logger(GenerateScheduleHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
    @Inject(SHIFT_REPOSITORY)
    private readonly shiftRepository: IShiftRepository,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepository: IFairnessHistoryRepository,
    private readonly eventBus: EventBus,
    private readonly semanticRetrievalService: SemanticRetrievalService,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async execute(
    command: GenerateScheduleCommand,
  ): Promise<GenerateScheduleResult> {
    const weekStart = new Date(`${command.weekStart}T00:00:00.000Z`);

    this.logger.log(
      `Generating schedule — company=${command.companyId} week=${command.weekStart} strategy=${command.strategyType}`,
    );

    // 1. Cargar datos
    let [employees, shifts, histories] = await Promise.all([
      this.employeeRepository.findAllByCompany(command.companyId),
      this.shiftRepository.findByCompanyAndWeek(command.companyId, weekStart),
      this.fairnessRepository.findByWeek(command.companyId, weekStart),
    ]);

    if (command.shiftTemplateId) {
      shifts = shifts.filter((s) => s.templateId === command.shiftTemplateId);
      this.logger.log(`Filtered shifts to template ${command.shiftTemplateId} — ${shifts.length} remain`);
    }

    this.logger.log(
      `Loaded — employees=${employees.length} shifts=${shifts.length} histories=${histories.length}`,
    );

    // 2. Seleccionar estrategia
    const strategy = this.selectStrategy(command.strategyType);

    // 2b. Recuperar reglas semánticas relevantes via RAG (Escenario 3)
    // Si el servicio falla, semanticRules = [] y el scheduling continúa normalmente
    const semanticRules = await this.semanticRetrievalService.retrieveForShift({
      shiftContext: `empresa ${command.companyId} semana ${command.weekStart} estrategia ${command.strategyType}`,
      companyId: command.companyId,
      shiftDate: weekStart,
    });

    if (semanticRules.length > 0) {
      this.logger.log(
        `RAG: ${semanticRules.length} semantic rules applied to schedule generation`,
      );
    }

    // 3. Crear aggregate y generar
    const scheduleAggregate = ScheduleAggregate.create(
      command.companyId,
      weekStart,
    );
    scheduleAggregate.generate(employees, shifts, histories, strategy, {
      maxFairnessDeviation: command.maxFairnessDeviation,
      semanticConstraints: semanticRules,
    });

    // 4. Validar invariantes (solapamientos, etc.)
    const validation = scheduleAggregate.validate(shifts);
    if (!validation.valid) {
      this.logger.error(
        `Schedule invariant violations: ${validation.violations.join(', ')}`,
      );
      throw new Error(
        `Schedule generated with violations: ${validation.violations[0]}`,
      );
    }

    // 5. Persistir asignaciones
    const assignments = scheduleAggregate.assignments;
    const unfilledShifts = scheduleAggregate.unfilledShifts;

    await Promise.all(
      assignments.map((a) => this.shiftRepository.saveAssignment(a)),
    );

    // 6. Actualizar historial de fairness
    const updatedHistories = this.buildUpdatedHistories(
      assignments,
      shifts,
      histories,
      weekStart,
      command.companyId,
    );
    await this.fairnessRepository.upsertBatch(updatedHistories);

    // 7. Publicar eventos del aggregate al EventBus
    scheduleAggregate
      .getUncommittedEvents()
      .forEach((event) => this.eventBus.publish(event));
    scheduleAggregate.commit();

    // 8. Notificar al frontend vía WebSocket
    this.notificationsGateway.notifyScheduleGenerated(
      command.companyId,
      command.weekStart,
    );

    const quality = scheduleAggregate.result!.quality;

    this.logger.log(
      `Schedule generated — assignments=${assignments.length} unfilled=${unfilledShifts.length} ` +
        `coverage=${quality.demandCoveragePercent}% fairnessVariance=${quality.fairnessVariance.toFixed(2)}`,
    );

    return {
      assignmentsCount: assignments.length,
      unfilledShiftsCount: unfilledShifts.length,
      quality,
    };
  }

  private selectStrategy(type: string): SchedulingStrategy {
    switch (type) {
      case 'cost':
        return new CostOptimizedStrategy();
      case 'fairness':
        return new FairnessOptimizedStrategy();
      case 'hybrid':
      default:
        return new HybridStrategy();
    }
  }

  private buildUpdatedHistories(
    assignments: ShiftAssignment[],
    shifts: Shift[],
    existingHistories: FairnessHistoryVO[],
    weekStart: Date,
    companyId: string,
  ): FairnessHistoryVO[] {
    const historyMap = new Map<string, FairnessHistoryVO>(
      existingHistories.map((h) => [h.employeeId, h]),
    );

    for (const assignment of assignments) {
      const shift = shifts.find((s) => s.id === assignment.shiftId);
      if (!shift) continue;

      const current =
        historyMap.get(assignment.employeeId) ??
        FairnessHistoryVO.empty(assignment.employeeId, companyId, weekStart);

      historyMap.set(
        assignment.employeeId,
        current.addShift(shift.getDuration(), {
          isUndesirable: shift.undesirableWeight.isHeavy(),
          isNight: shift.isNightShift(),
          isWeekend: shift.isWeekendShift(),
        }),
      );
    }

    return [...historyMap.values()];
  }
}
