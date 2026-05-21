import { CommandHandler, EventBus, ICommandHandler } from '@nestjs/cqrs';
import { Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
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
import {
  SHIFT_TEMPLATE_BREAK_REPOSITORY,
  type IShiftTemplateBreakRepository,
} from '../../domain/repositories/shift-template-break.repository';
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
import { ScheduleGenerationLockService } from '../../domain/services/schedule-generation-lock.service';
import { CompanyPreferencesService } from '../services/company-preferences.service';
import { weekStartOf } from '../../domain/shared/week';

export interface HybridScheduleResult {
  assignmentsCount: number;
  unfilledShiftsCount: number;
  llmAccepted: number;
  algorithmCorrected: number;
  explanation: string;
  warnings: string[];
  /**
   * Tokens consumidos durante este run (LLM-proposer + catch-all
   * llm_runtime + traducción de rules). NO incluye los del clasificador
   * de WhatsApp (esos calls viven fuera del scope del handler).
   */
  llmUsage?: { calls: number; prompt: number; completion: number; total: number };
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
    @Inject(SHIFT_TEMPLATE_BREAK_REPOSITORY)
    private readonly templateBreakRepository: IShiftTemplateBreakRepository,
    @Inject(SHIFT_MEMBERSHIP_REPOSITORY)
    private readonly membershipRepository: IShiftMembershipRepository,
    @Inject('SUPABASE_CLIENT')
    private readonly supabase: SupabaseClient,
    private readonly llmUsageTracker: LLMUsageTracker,
    private readonly lockService: ScheduleGenerationLockService,
    private readonly companyPreferences: CompanyPreferencesService,
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
    // Phase 4 — token único para este intento. Lo guardamos en
    // `acquired_by` así el cancel del controller puede pre-liberar
    // sin pisar a futuros jobs (release con token = race-safe).
    // Async path pasa el jobId; sync path genera UUID.
    const lockToken = command.lockToken ?? randomUUID();
    const weekStartsOn = await this.companyPreferences.getWeekStartsOn(
      command.companyId,
    );
    // Fase 0 async migration — lock por (companyId, weekStart) para
    // rechazar disparos concurrentes. Si ya hay un run activo,
    // `acquire` lanza ScheduleGenerationLockedException; el caller
    // (REST controller / WhatsApp router) la traduce al user.
    await this.lockService.acquire(
      command.companyId,
      command.weekStart,
      lockToken,
      weekStartsOn,
    );
    try {
      const { result, usage } = await this.llmUsageTracker.run(() =>
        this.runGeneration(command, weekStartsOn, lockToken),
      );
      this.logger.log(
        `📊 Hybrid schedule LLM usage — calls=${usage.calls} ` +
          `prompt=${usage.prompt} completion=${usage.completion} total=${usage.total}`,
      );
      return { ...result, llmUsage: usage };
    } finally {
      // Release con token: si el cancel ya liberó (pre-release), o
      // si otro job ya tomó el lock con un token distinto, este
      // delete no afecta nada — la query filtra por acquired_by.
      await this.lockService.release(
        command.companyId,
        command.weekStart,
        weekStartsOn,
        lockToken,
      );
    }
  }

  private async runGeneration(
    command: GenerateHybridScheduleCommand,
    weekStartsOn: 'sunday' | 'monday',
    jobId: string,
  ): Promise<HybridScheduleResult> {
    const weekStart = weekStartOf(
      new Date(`${command.weekStart}T00:00:00.000Z`),
      weekStartsOn,
    );
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    this.logger.log(
      `Hybrid schedule — company=${command.companyId} week=${weekStartStr} (from input ${command.weekStart})`,
    );

    const [allEmployees, allTemplates, histories] = await Promise.all([
      this.employeeRepository.findAllByCompany(command.companyId),
      this.shiftTemplateRepository.findAllByCompany(command.companyId),
      this.fairnessRepository.findByWeek(command.companyId, weekStart),
    ]);

    // Phase 14 — empleados sin departamento NO se schedulean.
    // El manager transversal (dept=null) es ejemplo canónico.
    const employeesWithDept = allEmployees.filter((e) => e.departmentId);
    const skippedNoDept = allEmployees.length - employeesWithDept.length;
    if (skippedNoDept > 0) {
      this.logger.log(
        `Excluded ${skippedNoDept} employee(s) without department from scheduling`,
      );
    }

    // Si llegó departmentId (ej. flow conversacional o filtro manual),
    // restringimos empleados Y templates a ese departamento.
    const employees = command.departmentId
      ? employeesWithDept.filter((e) => e.departmentId === command.departmentId)
      : employeesWithDept;

    const activeTemplates = allTemplates.filter((t) => t.isActive);
    const deptScopedTemplates = command.departmentId
      ? activeTemplates.filter((t) => t.departmentId === command.departmentId)
      : activeTemplates;
    const templates = command.shiftTemplateId
      ? deptScopedTemplates.filter((t) => t.id === command.shiftTemplateId)
      : deptScopedTemplates;
    if (command.departmentId) {
      this.logger.log(
        `Filtered to department ${command.departmentId} — employees=${employees.length} templates=${templates.length}`,
      );
    }
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

    // Sprint Add-a-break F3: para que FairnessHistory refleje las horas
    // EFECTIVAMENTE trabajadas (no las gross), agregamos al builder un
    // map `templateId → minutos totales de break unpaid`. El slot
    // descuenta esos minutos al sumar al `hoursWorked`. Los breaks
    // paid no se restan — esos cuentan como trabajo a efectos de carga.
    const unpaidMinutesByTemplate = await this.buildUnpaidBreakMap(
      command.companyId,
    );

    const buildResult = await this.weekScheduleBuilder.buildWithRetries({
      employees,
      slots,
      memberships,
      histories,
      semanticRules,
      rawRuleTexts,
      multiShiftPermits: resolved.multiShiftPermits,
      weekStart,
      weekStartsOn,
      companyId: command.companyId,
      jobId,
      runDepartmentId: command.departmentId,
      signal: command.signal,
      locale: command.locale,
      unpaidMinutesByTemplate,
    });

    // Cancel-check antes de tocar BD: si llegó cancel mientras corría
    // build (o entre build y persist), no escribimos nada y dejamos
    // que el lock release del finally limpie. El job se marca cancelled.
    if (command.signal?.aborted) {
      throw new Error('Job cancelled before persisting assignments');
    }

    const allAssignments = buildResult.assignments;

    // Phase 14 — si el run está acotado (a un depto o a un template
    // puntual), borramos SOLO las assignments de los templates que
    // efectivamente vamos a regenerar. Eso preserva schedules de OTROS
    // departamentos / templates de la misma semana.
    const isScopedRun =
      command.departmentId !== undefined ||
      command.shiftTemplateId !== undefined;
    const templateIdsToWipe = isScopedRun
      ? templates.map((t) => t.id)
      : undefined;
    const deletedCount = await this.assignmentRepository.deleteByDateRange(
      command.companyId,
      weekStartStr,
      weekEndStr,
      templateIdsToWipe,
    );
    this.logger.log(
      `Cleared ${deletedCount} previous assignments for week ${weekStartStr}–${weekEndStr}` +
        (isScopedRun
          ? ` (scoped to ${templateIdsToWipe!.length} template(s))`
          : ''),
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
      unpaidMinutesByTemplate,
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
    // Phase 14 — el builder agrega warnings cuando el verify-loop best-of-three
    // tuvo que aceptar una propuesta con violations (LLM no convergió).
    if (buildResult.policyWarnings && buildResult.policyWarnings.length > 0) {
      warnings.push(...buildResult.policyWarnings);
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
    _existingHistories: FairnessHistoryVO[],
    weekStart: Date,
    companyId: string,
    unpaidMinutesByTemplate: ReadonlyMap<string, number>,
  ): FairnessHistoryVO[] {
    // Cada regeneración SOBRESCRIBE la fairness de la semana — la
    // fila es proyección de las assignments actuales, no acumulado
    // histórico. Empezamos desde `empty()` por (empleado, semana);
    // si reusábamos `_existingHistories`, las re-generaciones sumaban
    // hasta valores imposibles (ej. 1032h/semana = 6× la realidad).
    // El parámetro queda en la firma por compat con calls existentes.
    const historyMap = new Map<string, FairnessHistoryVO>();
    const slotByKey = new Map(slots.map((s) => [s.slotKey, s]));

    for (const assignment of assignments) {
      const slot = slotByKey.get(assignment.slotKey);
      if (!slot) continue;

      const current =
        historyMap.get(assignment.employeeId) ??
        FairnessHistoryVO.empty(assignment.employeeId, companyId, weekStart);

      historyMap.set(
        assignment.employeeId,
        // Sprint Add-a-break F3: descontamos el tiempo de breaks unpaid
        // del template — el empleado no cobra esos minutos, así que
        // no deben sumar a su "carga" para fairness.
        current.addShift(slot.getWorkedHours(unpaidMinutesByTemplate), {
          isUndesirable: slot.undesirableWeight >= 0.5,
          isNight: slot.isNightShift(),
          isWeekend: slot.isWeekendShift(),
        }),
      );
    }

    return [...historyMap.values()];
  }

  /**
   * Sprint Add-a-break F3: precomputa `templateId → minutos totales de
   * break unpaid` para descontarlo de `hoursWorked` al construir la
   * FairnessHistory. Paid breaks NO se restan — el empleado los cobra,
   * son parte de la carga laboral a efectos de fairness.
   *
   * Una query al inicio de la generación, indexada por templateId.
   * Si el template no tiene defaults, no aparece en el map → 0 min
   * descontados (= comportamiento legacy pre-sprint).
   */
  private async buildUnpaidBreakMap(
    companyId: string,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    // Repo expone findByTemplateId, no un "all by company". Para
    // mantener una sola query lectiva por generación, iteramos
    // templates en paralelo (cada uno es 1 SELECT). Para 10-30
    // templates típicos esto es O(<50ms) en local.
    const templates = await this.shiftTemplateRepository.findAllByCompany(
      companyId,
    );
    const lists = await Promise.all(
      templates.map((t) =>
        this.templateBreakRepository.findByTemplateId(t.id, companyId),
      ),
    );
    for (let i = 0; i < templates.length; i++) {
      const unpaidMin = lists[i]
        .filter((b) => !b.isPaid)
        .reduce((s, b) => s + b.durationMinutes, 0);
      if (unpaidMin > 0) out.set(templates[i].id, unpaidMin);
    }
    return out;
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
    locale: string,
  ): string {
    const d = weekStart.toISOString().split('T')[0];
    // English por default (idioma canónico del sistema). 'es' para
    // managers hispanos — flow WhatsApp/UI lo pasa via locale del
    // empleado o request. Cualquier otro código → inglés (fallback).
    const isEs = locale.toLowerCase().startsWith('es');
    const parts = isEs
      ? [
          `Horario generado para la semana del ${d}: ${total} asignaciones.`,
          `Días libres: ${rests}.`,
        ]
      : [
          `Schedule generated for the week of ${d}: ${total} assignments.`,
          `Days off: ${rests}.`,
        ];
    if (underfilled > 0) {
      parts.push(
        isEs
          ? `${underfilled} slot(s) bajo su target.`
          : `${underfilled} slot(s) below target.`,
      );
    }
    return parts.join(' ');
  }
}
