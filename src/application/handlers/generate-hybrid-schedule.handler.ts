import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import { PromptOrchestratorService } from '../../domain/services/prompt-orchestrator.service';
import { SemanticRetrievalService } from '../../domain/services/semantic-retrieval.service';
import { StructuredRuleResolver } from '../../domain/services/structured-rule-resolver.service';
import { WorkingTimePolicyResolver } from '../../domain/services/working-time-policy.resolver';
import {
  WorkingTimePolicyVO,
  type WorkingTimePolicyOverrides,
} from '../../domain/value-objects/working-time-policy.vo';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { InstantiateWeekHandler } from '../commands/instantiate-week/instantiate-week.handler';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import type { IShiftRepository } from '../../domain/repositories/shift.repository';
import type { IFairnessHistoryRepository } from '../../domain/repositories/fairness-history.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { SHIFT_REPOSITORY } from '../../domain/repositories/shift.repository';
import { FAIRNESS_HISTORY_REPOSITORY } from '../../domain/repositories/fairness-history.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';
import type { Employee } from '../../domain/aggregates/employee.aggregate';
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
  /** Avisos para el manager (exceso de horas, turnos sin cubrir, etc.) */
  warnings: string[];
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
export class GenerateHybridScheduleHandler implements ICommandHandler<
  GenerateHybridScheduleCommand,
  HybridScheduleResult
> {
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
    private readonly instantiateWeekHandler: InstantiateWeekHandler,
    private readonly structuredRuleResolver: StructuredRuleResolver,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Resuelve la WorkingTimePolicy de cada empleado mediante merge jerárquico
   * (employee → department → company → fallback del sistema).
   */
  private async resolveWorkingTimePolicies(
    companyId: string,
    employees: Employee[],
  ): Promise<Map<string, WorkingTimePolicyVO>> {
    const [companyRes, deptsRes] = await Promise.all([
      this.supabase
        .from('companies')
        .select('default_max_hours_per_day, default_max_hours_per_week')
        .eq('id', companyId)
        .single(),
      this.supabase
        .from('departments')
        .select('id, max_hours_per_day, max_hours_per_week')
        .eq('company_id', companyId),
    ]);

    const companyOverrides: WorkingTimePolicyOverrides = {
      maxHoursPerDay: companyRes.data?.default_max_hours_per_day != null ? Number(companyRes.data.default_max_hours_per_day) : null,
      maxHoursPerWeek: companyRes.data?.default_max_hours_per_week != null ? Number(companyRes.data.default_max_hours_per_week) : null,
    };

    const deptOverridesById = new Map<string, WorkingTimePolicyOverrides>();
    for (const d of deptsRes.data ?? []) {
      deptOverridesById.set(d.id, {
        maxHoursPerDay: d.max_hours_per_day != null ? Number(d.max_hours_per_day) : null,
        maxHoursPerWeek: d.max_hours_per_week != null ? Number(d.max_hours_per_week) : null,
      });
    }

    const result = new Map<string, WorkingTimePolicyVO>();
    let customCount = 0;
    for (const emp of employees) {
      const dept = emp.departmentId ? deptOverridesById.get(emp.departmentId) : undefined;
      const policy = WorkingTimePolicyResolver.resolve({
        employee: emp.workingTimeOverrides,
        department: dept,
        company: companyOverrides,
      });

      // Log detallado por empleado con origen de cada campo
      const origin = (key: 'maxHoursPerDay' | 'maxHoursPerWeek'): string => {
        if (emp.workingTimeOverrides?.[key] != null) return 'employee';
        if (dept?.[key] != null) return 'department';
        if (companyOverrides[key] != null) return 'company';
        return 'system-fallback';
      };
      this.logger.log(
        `  ${emp.name.padEnd(20)} → max ${policy.maxHoursPerDay}h/día (${origin('maxHoursPerDay')}), ${policy.maxHoursPerWeek}h/semana (${origin('maxHoursPerWeek')})`,
      );

      const hasOverride =
        (emp.workingTimeOverrides &&
          Object.values(emp.workingTimeOverrides).some((v) => v != null)) ||
        (dept && Object.values(dept).some((v) => v != null)) ||
        Object.values(companyOverrides).some((v) => v != null);
      if (hasOverride) customCount++;
      result.set(emp.id, policy);
    }
    this.logger.log(
      `WorkingTimePolicies resolved: ${employees.length} employees (${customCount} with overrides, ${employees.length - customCount} on pure system fallback)`,
    );
    return result;
  }

  async execute(
    command: GenerateHybridScheduleCommand,
  ): Promise<HybridScheduleResult> {
    // Normalize weekStart to Monday (Gemini may send a non-Monday date)
    const rawDate = new Date(`${command.weekStart}T00:00:00.000Z`);
    const dayOfWeek = rawDate.getUTCDay(); // 0=Sun, 1=Mon, ...
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(rawDate);
    weekStart.setUTCDate(weekStart.getUTCDate() - daysToSubtract);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    this.logger.log(
      `Hybrid schedule — company=${command.companyId} week=${weekStartStr} (from input ${command.weekStart})`,
    );

    // 1. Cargar datos en paralelo
    let [employees, shifts, histories] = await Promise.all([
      this.employeeRepository.findAllByCompany(command.companyId),
      this.shiftRepository.findByCompanyAndWeek(command.companyId, weekStart),
      this.fairnessRepository.findByWeek(command.companyId, weekStart),
    ]);

    // 1b. Auto-instantiate from templates if no shifts exist for this week
    if (shifts.length === 0) {
      this.logger.log(`No shifts found for week ${weekStartStr} — auto-instantiating from templates...`);
      const instantiateResult = await this.instantiateWeekHandler.execute({
        companyId: command.companyId,
        weekStart: weekStartStr,
      });
      this.logger.log(`Instantiated ${instantiateResult.generated} shifts from templates`);

      // Reload shifts after instantiation
      shifts = await this.shiftRepository.findByCompanyAndWeek(command.companyId, weekStart);
    }

    if (command.shiftTemplateId) {
      shifts = shifts.filter((s) => s.templateId === command.shiftTemplateId);
      this.logger.log(`Filtered shifts to template ${command.shiftTemplateId} — ${shifts.length} remain`);
    }

    this.logger.log(
      `Loaded — employees=${employees.length} shifts=${shifts.length}`,
    );

    // 2. RAG: recuperar aggregates (con structure si fue extraída por LLM al crearlas)
    const ruleAggregates = await this.semanticRetrievalService
      .retrieveAggregatesForCompany(command.companyId)
      .catch((error) => {
        this.logger.warn(
          `RAG Degradado: No se pudieron recuperar reglas semánticas [${(error as Error).message}]. Continúa sin restricciones.`,
        );
        return [];
      });
    this.logger.log(`RAG: ${ruleAggregates.length} semantic rules retrieved`);

    // 2a. Resolver structure → constraints con IDs concretos (sin NLP en caliente)
    const resolved = this.structuredRuleResolver.resolve(
      ruleAggregates,
      employees,
      shifts,
    );
    if (resolved.complexRules.length > 0) {
      resolved.complexRules.forEach((r) =>
        this.logger.warn(`Regla compleja (requiere supervisión): "${r.ruleText}" — ${r.reason}`),
      );
    }
    if (resolved.unstructuredRules.length > 0) {
      resolved.unstructuredRules.forEach((r) =>
        this.logger.warn(`Regla sin structure (el LLM no la analizó al crearla): "${r.ruleText}"`),
      );
    }

    // Para compatibilidad con el orchestrator actual, pasamos constraints resueltos
    // como semanticRules (ya tienen IDs de empleados/turnos concretos).
    const semanticRules = resolved.constraints;

    // 2b. Resolver working time policies por jerarquía (employee → dept → tenant → fallback)
    const workingTimePolicies = await this.resolveWorkingTimePolicies(
      command.companyId,
      employees,
    );

    // 3. Orquestar LLM + algoritmo
    const result = await this.promptOrchestrator.orchestrate({
      employees,
      shifts,
      histories,
      companyId: command.companyId,
      weekStart,
      semanticRules,
      workingTimePolicies,
      preResolvedPermits: resolved.multiShiftPermits,
      preResolvedComplexRules: resolved.complexRules,
      preResolvedUnstructuredRules: resolved.unstructuredRules,
    });

    // 4. Limpiar asignaciones previas de la semana y persistir las nuevas
    // IMPORTANTE: hay que borrar PRIMERO para que los turnos de feriado (capacity=0,
    // sin nuevas asignaciones) no queden con asignaciones residuales de runs anteriores.
    const deletedCount = await this.shiftRepository.deleteAssignmentsByWeek(
      command.companyId,
      weekStart,
    );
    this.logger.log(`Cleared ${deletedCount} previous assignments for week ${weekStartStr}`);

    await Promise.all(
      result.assignments.map((a) => this.shiftRepository.saveAssignment(a)),
    );

    // 5. Actualizar historial de fairness
    const updatedHistories = this.buildUpdatedHistories(
      result.assignments,
      shifts,
      histories,
      weekStart,
      command.companyId,
    );
    await this.fairnessRepository.upsertBatch(updatedHistories);

    // 6. Notificar al frontend vía WebSocket
    this.notificationsGateway.notifyScheduleGenerated(
      command.companyId,
      command.weekStart,
    );

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
      warnings: result.warnings,
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
