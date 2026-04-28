import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { GenerateHybridScheduleCommand } from '../commands/generate-hybrid-schedule.command';
import { SemanticRetrievalService } from '../../domain/services/semantic-retrieval.service';
import { StructuredRuleResolver } from '../../domain/services/structured-rule-resolver.service';
import { WorkingTimePolicyResolver } from '../../domain/services/working-time-policy.resolver';
import {
  WorkingTimePolicyVO,
  type WorkingTimePolicyOverrides,
} from '../../domain/value-objects/working-time-policy.vo';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { ShiftSlotGeneratorService } from '../../domain/services/shift-slot-generator.service';
import { WeekScheduleBuilder } from '../../domain/services/week-schedule-builder.service';
import type { IShiftTemplateRepository } from '../../domain/repositories/shift-template.repository';
import type { VirtualShiftSlot } from '../../domain/value-objects/virtual-shift-slot.vo';
import type { IEmployeeRepository } from '../../domain/repositories/employee.repository';
import type { IShiftAssignmentRepository } from '../../domain/repositories/shift-assignment.repository';
import type { IShiftMembershipRepository } from '../../domain/repositories/shift-membership.repository';
import type { IFairnessHistoryRepository } from '../../domain/repositories/fairness-history.repository';
import { EMPLOYEE_REPOSITORY } from '../../domain/repositories/employee.repository';
import { SHIFT_ASSIGNMENT_REPOSITORY } from '../../domain/repositories/shift-assignment.repository';
import { SHIFT_MEMBERSHIP_REPOSITORY } from '../../domain/repositories/shift-membership.repository';
import { FAIRNESS_HISTORY_REPOSITORY } from '../../domain/repositories/fairness-history.repository';
import { ShiftAssignment } from '../../domain/aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../../domain/value-objects/fairness-history.vo';
import type { Employee } from '../../domain/aggregates/employee.aggregate';
import { LLMUsageTracker } from '../../infrastructure/observability/llm-usage-tracker.service';

export interface HybridScheduleResult {
  assignmentsCount: number;
  unfilledShiftsCount: number;
  llmAccepted: number;
  algorithmCorrected: number;
  explanation: string;
  warnings: string[];
}

/**
 * GenerateHybridScheduleHandler — Command Handler
 *
 * Orquesta la generación híbrida LLM + algoritmo SOBRE slots virtuales:
 *   1. Carga empleados, templates activos y fairness history
 *   2. Materializa slots virtuales para la semana (no persistidos)
 *   3. Recupera reglas semánticas vía RAG y resuelve structure → constraints
 *   4. Invoca PromptOrchestratorService (doble verificación LLM + strategy)
 *   5. Persiste ShiftAssignments (única fuente de verdad en BD)
 *   6. Actualiza historial de fairness
 */
@CommandHandler(GenerateHybridScheduleCommand)
export class GenerateHybridScheduleHandler
  implements ICommandHandler<GenerateHybridScheduleCommand, HybridScheduleResult>
{
  private readonly logger = new Logger(GenerateHybridScheduleHandler.name);

  constructor(
    @Inject(EMPLOYEE_REPOSITORY)
    private readonly employeeRepository: IEmployeeRepository,
    @Inject(SHIFT_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepository: IShiftAssignmentRepository,
    @Inject(FAIRNESS_HISTORY_REPOSITORY)
    private readonly fairnessRepository: IFairnessHistoryRepository,
    private readonly eventBus: EventBus,
    private readonly semanticRetrievalService: SemanticRetrievalService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly structuredRuleResolver: StructuredRuleResolver,
    private readonly shiftSlotGenerator: ShiftSlotGeneratorService,
    private readonly weekScheduleBuilder: WeekScheduleBuilder,
    @Inject('SHIFT_TEMPLATE_REPOSITORY')
    private readonly shiftTemplateRepository: IShiftTemplateRepository,
    @Inject(SHIFT_MEMBERSHIP_REPOSITORY)
    private readonly membershipRepository: IShiftMembershipRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly llmUsageTracker: LLMUsageTracker,
  ) {
    void this.eventBus;
  }

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
      maxHoursPerDay:
        companyRes.data?.default_max_hours_per_day != null
          ? Number(companyRes.data.default_max_hours_per_day)
          : null,
      maxHoursPerWeek:
        companyRes.data?.default_max_hours_per_week != null
          ? Number(companyRes.data.default_max_hours_per_week)
          : null,
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
    const { result, usage } = await this.llmUsageTracker.run(() =>
      this.runGeneration(command),
    );
    this.logger.log(
      `📊 Hybrid schedule LLM usage — calls=${usage.calls} ` +
        `prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`,
    );
    return result;
  }

  private async runGeneration(
    command: GenerateHybridScheduleCommand,
  ): Promise<HybridScheduleResult> {
    const rawDate = new Date(`${command.weekStart}T00:00:00.000Z`);
    const dayOfWeek = rawDate.getUTCDay();
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(rawDate);
    weekStart.setUTCDate(weekStart.getUTCDate() - daysToSubtract);
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    this.logger.log(
      `Hybrid schedule — company=${command.companyId} week=${weekStartStr} (from input ${command.weekStart})`,
    );

    const [employees, allTemplates, histories] = await Promise.all([
      this.employeeRepository.findAllByCompany(command.companyId),
      this.shiftTemplateRepository.findAllByCompany(command.companyId),
      this.fairnessRepository.findByWeek(command.companyId, weekStart),
    ]);

    const activeTemplates = allTemplates.filter((t) => t.isActive);
    const templates = command.shiftTemplateId
      ? activeTemplates.filter((t) => t.id === command.shiftTemplateId)
      : activeTemplates;
    if (command.shiftTemplateId) {
      this.logger.log(
        `Filtered templates to ${command.shiftTemplateId} — ${templates.length} remain`,
      );
    }

    const slots: VirtualShiftSlot[] = this.shiftSlotGenerator.generateSlotsForWeek(templates, weekStart);

    // Capacidades pasan como HINT al orchestrator/strategies (target de distribución,
    // NO cuota obligatoria). `null` = slot elástico (recibe leftovers del round-robin).
    const resolvedCapacities = new Map<string, number | null>(
      slots.map((s) => [s.slotKey, s.requiredEmployees]),
    );

    const memberships = await this.membershipRepository.findActiveInRange(
      command.companyId,
      weekStartStr,
      weekEndStr,
    );

    this.logger.log(
      `Loaded — employees=${employees.length} slots=${slots.length} memberships=${memberships.length}`,
    );

    const ruleAggregates = await this.semanticRetrievalService
      .retrieveAggregatesForCompany(command.companyId)
      .catch((error) => {
        this.logger.warn(
          `RAG Degradado: No se pudieron recuperar reglas semánticas [${(error as Error).message}]. Continúa sin restricciones.`,
        );
        return [];
      });
    this.logger.log(`RAG: ${ruleAggregates.length} semantic rules retrieved`);

    const resolved = this.structuredRuleResolver.resolve(
      ruleAggregates,
      employees,
      slots,
    );
    // Reglas unstructured/complex ya no son "warning al manager": se pasan
    // al LLM como texto y él las interpreta (ver `rawRuleTexts` abajo).
    // Dejamos logs informativos para trazabilidad.
    if (resolved.complexRules.length > 0) {
      resolved.complexRules.forEach((r) =>
        this.logger.log(`Regla compleja (interpretada por el LLM): "${r.ruleText}" — ${r.reason}`),
      );
    }
    if (resolved.unstructuredRules.length > 0) {
      resolved.unstructuredRules.forEach((r) =>
        this.logger.log(`Regla sin estructura (interpretada por el LLM): "${r.ruleText}"`),
      );
    }

    const semanticRules = resolved.constraints;

    const workingTimePolicies = await this.resolveWorkingTimePolicies(
      command.companyId,
      employees,
    );

    void workingTimePolicies; // policies son informativas en este motor, no aplican caps hard
    void resolvedCapacities; // el builder lee slot.requiredEmployees directo

    // Motor LLM-autoritario con guardarraíles:
    //   1. Se pide al LLM que proponga líneas semanales.
    //   2. Se verifica contra reglas hard (feriado, skill, one-per-day,
    //      target=exact, referencias válidas).
    //   3. Si viola algo, se le pide corregir (máx 2 reintentos totales).
    //   4. Si sigue inválido, cae al motor determinístico como red de seguridad.
    // Reglas textuales que el LLM sí puede interpretar pero el resolver no
    // pudo estructurar (complex/unstructured). Se las pasamos para que el
    // LLM las considere en la propuesta; verify() sigue enforzando solo lo
    // estructurado como hard.
    const rawRuleTexts = [
      ...resolved.unstructuredRules.map((r) => r.ruleText),
      ...resolved.complexRules.map((r) => r.ruleText),
    ];

    const buildResult = await this.weekScheduleBuilder.buildWithRetries({
      employees,
      slots,
      memberships,
      histories,
      semanticRules,
      rawRuleTexts,
      multiShiftPermits: resolved.multiShiftPermits,
      weekStart,
      companyId: command.companyId,
    });

    const allAssignments = buildResult.assignments;

    const deletedCount = await this.assignmentRepository.deleteByDateRange(
      command.companyId,
      weekStartStr,
      weekEndStr,
    );
    this.logger.log(
      `Cleared ${deletedCount} previous assignments for week ${weekStartStr}–${weekEndStr}`,
    );

    await Promise.all(
      allAssignments.map((a) => this.assignmentRepository.save(a)),
    );

    const updatedHistories = this.buildUpdatedHistories(
      allAssignments,
      slots,
      histories,
      weekStart,
      command.companyId,
    );
    await this.fairnessRepository.upsertBatch(updatedHistories);

    this.notificationsGateway.notifyScheduleGenerated(
      command.companyId,
      command.weekStart,
    );

    const warnings: string[] = [];
    for (const u of buildResult.underfilled) {
      warnings.push(
        this.i18nWarnUnderfilled(u.slot, u.target, u.filled, command.locale ?? 'es'),
      );
    }
    // Nota: las reglas complex/unstructured ya NO son warnings al manager —
    // el LLM las procesa como texto libre vía `rawRuleTexts`. Si el manager
    // quiere enforcement garantizado, debe expresarlas en términos
    // estructurables (empleado × día concreto / día-de-semana / etc).

    this.logger.log(
      `Hybrid schedule complete — total=${allAssignments.length} ` +
        `(rest=${buildResult.restDays.length} underfilled=${buildResult.underfilled.length})`,
    );

    const explanation = this.buildExplanation(
      allAssignments.length,
      buildResult.restDays.length,
      buildResult.underfilled.length,
      weekStart,
      command.locale ?? 'es',
    );

    return {
      assignmentsCount: allAssignments.length,
      unfilledShiftsCount: buildResult.underfilled.length,
      llmAccepted: 0,
      algorithmCorrected: allAssignments.length,
      explanation,
      warnings,
    };
  }

  private buildUpdatedHistories(
    assignments: ShiftAssignment[],
    slots: VirtualShiftSlot[],
    existingHistories: FairnessHistoryVO[],
    weekStart: Date,
    companyId: string,
  ): FairnessHistoryVO[] {
    const historyMap = new Map<string, FairnessHistoryVO>(
      existingHistories.map((h) => [h.employeeId, h]),
    );
    const slotByKey = new Map(slots.map((s) => [s.slotKey, s]));

    for (const assignment of assignments) {
      const slot = slotByKey.get(assignment.slotKey);
      if (!slot) continue;

      const current =
        historyMap.get(assignment.employeeId) ??
        FairnessHistoryVO.empty(assignment.employeeId, companyId, weekStart);

      historyMap.set(
        assignment.employeeId,
        current.addShift(slot.getDuration(), {
          isUndesirable: slot.undesirableWeight >= 0.5,
          isNight: slot.isNightShift(),
          isWeekend: slot.isWeekendShift(),
        }),
      );
    }

    return [...historyMap.values()];
  }

  private i18nWarnUnderfilled(
    slot: VirtualShiftSlot,
    target: number,
    filled: number,
    locale: string,
  ): string {
    const isEn = locale.startsWith('en');
    const date = new Date(`${slot.date}T12:00:00Z`);
    const formatted = new Intl.DateTimeFormat(isEn ? 'en-US' : 'es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(date);
    if (isEn) {
      return `${slot.templateName} on ${formatted}: needs ${target} people, ${filled} assigned.`;
    }
    return `${slot.templateName} del ${formatted}: necesitaba ${target} ${target === 1 ? 'persona' : 'personas'}, asignada${filled === 1 ? '' : 's'} ${filled}.`;
  }

  private buildExplanation(
    total: number,
    rests: number,
    underfilled: number,
    weekStart: Date,
    _locale: string,
  ): string {
    const d = weekStart.toISOString().split('T')[0];
    const parts = [
      `Horario generado para la semana del ${d}: ${total} asignaciones.`,
      `Días libres: ${rests}.`,
    ];
    if (underfilled > 0) parts.push(`${underfilled} slot(s) bajo su target.`);
    return parts.join(' ');
  }
}
