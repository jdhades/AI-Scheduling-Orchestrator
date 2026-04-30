import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { ShiftMembership } from '../aggregates/shift-membership.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import { SEMANTIC_BLOCKED_ALL } from '../strategies/scheduling-strategy.interface';
import { LLMLineProposerService } from './llm-line-proposer.service';
import { PolicyEnforcementService } from './policy-enforcement.service';
import type { CompanyPolicy } from '../aggregates/company-policy.aggregate';

/** Violación hard detectada por `verify()` en una propuesta del LLM. */
export interface VerifyViolation {
  kind:
    | 'holiday-worked'
    | 'employee-blocked'
    | 'skill-mismatch'
    | 'unknown-employee'
    | 'unknown-template'
    | 'two-shifts-same-day'
    | 'policy-hard-violation';
  employeeId?: string;
  date?: string;
  slotKey?: string;
  policyId?: string;
  message: string;
}

export interface BuildWithRetriesResult extends BuilderResult {
  /** Intentos consumidos (1 = LLM clavó, 2 = corrigió, 3 = cayó a determinístico). */
  attempts: number;
  /** True si el LLM no pudo y se usó el camino determinístico. */
  fellBackToDeterministic: boolean;
}

/**
 * Una línea semanal por empleado: 7 celdas, cada una asignada a un slot
 * concreto o marcada como `rest`. La unidad que el motor itera.
 */
export interface EmployeeWeekLine {
  employeeId: string;
  days: Record<string, VirtualShiftSlot | 'rest' | null>; // key = YYYY-MM-DD
}

export interface BuilderResult {
  assignments: ShiftAssignment[];
  /** Días explícitos de descanso (empleado × fecha) — diagnósticos, no error. */
  restDays: { employeeId: string; date: string; reason: string }[];
  /** Slots con target > 0 que NO llegaron al target (warning al manager). */
  underfilled: { slot: VirtualShiftSlot; target: number; filled: number }[];
  /**
   * Soft violations de policies tenant-wide. NO bloquean la generación
   * — son señales para el manager de que el schedule puede mejorarse.
   * Vacío si no hay PolicyEnforcementService inyectado.
   */
  softPolicyViolations?: Array<{ policyId: string; employeeId?: string; scope?: string; message: string }>;
}

/**
 * WeekScheduleBuilder — Motor employee-first.
 *
 * Reemplaza el loop "iterar slots y buscar quién los llena" por "iterar
 * empleados y construir su línea semanal". La unidad del algoritmo pasa a
 * ser `(empleado, día)`, y para cada celda se decide en 5 pasos
 * (el primero que resuelva gana):
 *
 *   1. Hard BLOCK para el día (feriado SEMANTIC_BLOCKED_ALL) → `rest`.
 *   2. Hard BLOCK/rule específico que afecta al empleado ese día o en un
 *      template puntual → filtra los templates candidatos.
 *   3. Membership activa ese día → preferencia fuerte por ese template
 *      (si sigue siendo elegible tras pasos 1–2).
 *   4. Distribución libre: entre los templates del día que tienen cupo
 *      (target no alcanzado) o son elásticos (requiredEmployees === null),
 *      y para los que el empleado tiene skill + disponibilidad, elegir el
 *      menos saturado. Los elásticos se penalizan ligeramente frente a
 *      targets para priorizar cubrir las cuotas primero.
 *   5. Si ningún template califica → celda queda `rest`.
 *
 * `required_employees` en el template es un hint de distribución, no una
 * cuota rígida. Si hay 5 miembros del Diurno con target=2, todos los 5
 * van al Diurno (membership > target). El warning `underfilled` solo se
 * emite cuando ni memberships ni la distribución libre llegaron al target.
 *
 * La regla hard "un turno por empleado por día (salvo permit)" está
 * garantizada por construcción: cada celda se decide una sola vez.
 */
@Injectable()
export class WeekScheduleBuilder {
  private readonly logger = new Logger(WeekScheduleBuilder.name);
  private static readonly MAX_LLM_ATTEMPTS = 2;

  constructor(
    /**
     * Opcional: si no se inyecta, `buildWithRetries` degrada directamente
     * al camino determinístico. Los tests pueden omitirlo.
     */
    @Optional() private readonly proposer?: LLMLineProposerService,
    /**
     * Opcional (Phase 14): si se inyecta, `buildWithRetries` carga las
     * policies activas del tenant una vez por generación, las renderiza
     * al prompt del LLM (`formatLoaded`) y corre `evaluateLoaded` post
     * propuesta — las hard violations se mergean al `verify()` para que
     * el verify-loop pida al LLM una corrección. Si no se inyecta, el
     * builder se comporta como antes (no policy enforcement).
     */
    @Optional() private readonly policyEnforcement?: PolicyEnforcementService,
  ) {}

  /**
   * Pipeline completo LLM-autoritario + verify + retry + fallback.
   * Llama al proposer, verifica, reintenta con feedback si hay violaciones
   * hard, y como último recurso usa el motor determinístico.
   */
  async buildWithRetries(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    memberships: ShiftMembership[];
    histories: FairnessHistoryVO[];
    semanticRules: SemanticConstraint[];
    /** Textos de reglas unstructured/complex que el LLM sí puede interpretar. */
    rawRuleTexts?: string[];
    multiShiftPermits?: Set<string>;
    weekStart: Date;
    companyId: string;
  }): Promise<BuildWithRetriesResult> {
    // Phase 14: cargar policies UNA vez (1 read DB) y reusarlas durante
    // el verify-loop. Si no hay PolicyEnforcementService, todo el bloque
    // de policies queda neutro.
    const policies: CompanyPolicy[] = this.policyEnforcement
      ? await this.policyEnforcement.loadActivePolicies(params.companyId)
      : [];
    const policyPromptBlock = this.policyEnforcement
      ? this.policyEnforcement.formatLoaded(policies)
      : '';

    // Sin proposer inyectado → directo al determinístico.
    if (!this.proposer) {
      const result = this.build(params);
      const softPolicyViolations = this.evaluatePolicies(result.assignments, params.slots, policies, params.employees).softViolations;
      return { ...result, softPolicyViolations, attempts: 1, fellBackToDeterministic: true };
    }

    let feedback: string | undefined;

    for (let attempt = 1; attempt <= WeekScheduleBuilder.MAX_LLM_ATTEMPTS; attempt++) {
      const llmLines = await this.proposer.proposeLines({
        employees: params.employees,
        slots: params.slots,
        semanticRules: params.semanticRules,
        rawRuleTexts: params.rawRuleTexts,
        weekStart: params.weekStart,
        feedback,
        policyPromptBlock,
      });

      if (llmLines.size === 0) {
        this.logger.warn(
          `LLM proposer devolvió 0 líneas (intento ${attempt}). Saltando a determinístico.`,
        );
        break;
      }

      const candidate = this.applyLines({ ...params, llmLines });
      const baseViolations = this.verify(
        candidate.assignments,
        params.slots,
        params.semanticRules,
        params.employees,
        params.multiShiftPermits,
      );

      // Phase 14: policy hard violations → al mismo bucket de violations
      // (el verify-loop reintenta con feedback unificado).
      const policyEval = this.evaluatePolicies(candidate.assignments, params.slots, policies, params.employees);
      const policyHardAsVerify: VerifyViolation[] = policyEval.hardViolations.map((v) => ({
        kind: 'policy-hard-violation' as const,
        employeeId: v.employeeId,
        date: v.scope,
        policyId: v.policyId,
        message: v.message,
      }));
      const violations = [...baseViolations, ...policyHardAsVerify];

      if (violations.length === 0) {
        this.logger.log(
          `LLM propuesta aceptada en intento ${attempt} (${candidate.assignments.length} asignaciones, ${candidate.restDays.length} rest, ${candidate.underfilled.length} underfilled, ${policyEval.softViolations.length} soft policy).`,
        );
        return {
          ...candidate,
          softPolicyViolations: policyEval.softViolations,
          attempts: attempt,
          fellBackToDeterministic: false,
        };
      }

      this.logger.warn(
        `LLM intento ${attempt} inválido: ${violations.length} violación(es)${
          policyHardAsVerify.length > 0 ? ` (incl. ${policyHardAsVerify.length} de policy)` : ''
        }. ${
          attempt < WeekScheduleBuilder.MAX_LLM_ATTEMPTS ? 'Pidiendo corrección.' : 'Saltando a determinístico.'
        }`,
      );
      for (const v of violations.slice(0, 10)) {
        this.logger.warn(`  • ${v.message}`);
      }

      feedback = this.formatFeedback(violations);
    }

    // Fallback final: builder determinístico (sin llmLines).
    const deterministic = this.build({ ...params, llmLines: undefined });
    const softPolicyViolations = this.evaluatePolicies(deterministic.assignments, params.slots, policies, params.employees).softViolations;
    return {
      ...deterministic,
      softPolicyViolations,
      attempts: WeekScheduleBuilder.MAX_LLM_ATTEMPTS + 1,
      fellBackToDeterministic: true,
    };
  }

  /**
   * Phase 14: corre `policyEnforcement.evaluateLoaded` traduciendo las
   * `ShiftAssignment[]` propuestas a `PolicyEvaluationShift[]` (employeeId
   * + startTime/endTime absolutos derivados del slot). Si no hay servicio
   * inyectado o no hay policies, devuelve un resultado vacío.
   *
   * Phase 14.1 — además construye `employeeMeta` (employeeId → branchId /
   * departmentId) desde `employees` para que el evaluator filtre shifts
   * según el scope de cada policy. Hoy `Employee` aggregate sólo expone
   * `departmentId`; `branchId` queda null hasta que el handler precarge
   * la relación `department → branch` y la inyecte.
   */
  private evaluatePolicies(
    assignments: ShiftAssignment[],
    slots: VirtualShiftSlot[],
    policies: CompanyPolicy[],
    employees: Employee[],
  ): {
    hardViolations: Array<{ policyId: string; employeeId?: string; scope?: string; message: string }>;
    softViolations: Array<{ policyId: string; employeeId?: string; scope?: string; message: string }>;
  } {
    if (!this.policyEnforcement || policies.length === 0) {
      return { hardViolations: [], softViolations: [] };
    }
    const slotByKey = new Map(slots.map((s) => [s.slotKey, s]));
    const evalShifts = assignments
      .map((a) => {
        const slot = slotByKey.get(a.slotKey);
        if (!slot) return null;
        return {
          employeeId: a.employeeId,
          startTime: slot.startTime,
          endTime: slot.endTime,
        };
      })
      .filter((s): s is { employeeId: string; startTime: Date; endTime: Date } => s !== null);

    const employeeMeta = new Map<string, { branchId: string | null; departmentId: string | null }>();
    for (const e of employees) {
      employeeMeta.set(e.id, {
        branchId: null, // TODO: enriquecer con dept→branch lookup en 14.3
        departmentId: e.departmentId ?? null,
      });
    }

    const result = this.policyEnforcement.evaluateLoaded(policies, {
      shifts: evalShifts,
      employeeMeta,
    });
    return {
      hardViolations: result.hardViolations.map(({ policyId, employeeId, scope, message }) => ({
        policyId,
        employeeId,
        scope,
        message,
      })),
      softViolations: result.softViolations.map(({ policyId, employeeId, scope, message }) => ({
        policyId,
        employeeId,
        scope,
        message,
      })),
    };
  }

  build(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    memberships: ShiftMembership[];
    histories: FairnessHistoryVO[];
    /** Bloqueos + asignaciones resueltas por el RAG (weight ≥ 2 son hard). */
    semanticRules: SemanticConstraint[];
    /** `${employeeId}|YYYY-MM-DD` que sí pueden tener más de un turno ese día. */
    multiShiftPermits?: Set<string>;
    /** Propuestas opcionales del LLM (empleado → lista de días→templateId). */
    llmLines?: Map<string, Record<string, string | 'rest'>>;
    /** Fecha de referencia para snapshots de fairness. */
    weekStart: Date;
    companyId: string;
  }): BuilderResult {
    const {
      employees,
      slots,
      memberships,
      histories,
      semanticRules,
      multiShiftPermits,
      llmLines,
      weekStart,
      companyId,
    } = params;

    // ── Estado ────────────────────────────────────────────────────────────
    const liveHistory = new Map<string, FairnessHistoryVO>(
      employees.map((e) => {
        const existing = histories.find((h) => h.employeeId === e.id);
        return [
          e.id,
          existing ?? FairnessHistoryVO.empty(e.id, e.companyId, weekStart),
        ];
      }),
    );

    const slotsByDate = new Map<string, VirtualShiftSlot[]>();
    for (const s of slots) {
      if (!slotsByDate.has(s.date)) slotsByDate.set(s.date, []);
      slotsByDate.get(s.date)!.push(s);
    }
    const fillBySlot = new Map<string, number>();
    const lines = new Map<string, EmployeeWeekLine>();
    for (const emp of employees) {
      const days: Record<string, VirtualShiftSlot | 'rest' | null> = {};
      for (const d of slotsByDate.keys()) days[d] = null;
      lines.set(emp.id, { employeeId: emp.id, days });
    }

    // Pre-índice de memberships por empleado+template para lookup rápido
    const membershipsByEmp = new Map<string, ShiftMembership[]>();
    for (const m of memberships) {
      if (!membershipsByEmp.has(m.employeeId)) membershipsByEmp.set(m.employeeId, []);
      membershipsByEmp.get(m.employeeId)!.push(m);
    }

    const hardRules = semanticRules.filter((c) => c.weight >= 2);

    const assignments: ShiftAssignment[] = [];
    const restDays: BuilderResult['restDays'] = [];

    // ── Orden de empleados: menor score de fairness primero (más descansados).
    const employeeOrder = [...employees].sort((a, b) => {
      const sa = liveHistory.get(a.id)?.computeRawScore() ?? 0;
      const sb = liveHistory.get(b.id)?.computeRawScore() ?? 0;
      return sa - sb;
    });

    for (const emp of employeeOrder) {
      const line = lines.get(emp.id)!;
      const sortedDates = [...slotsByDate.keys()].sort();

      for (const date of sortedDates) {
        const daySlots = slotsByDate.get(date) ?? [];
        const decision = this.decideCell({
          emp,
          date,
          daySlots,
          line,
          fillBySlot,
          memberships: membershipsByEmp.get(emp.id) ?? [],
          hardRules,
          multiShiftPermits,
          llmLines,
        });

        if (decision.type === 'rest') {
          line.days[date] = 'rest';
          restDays.push({ employeeId: emp.id, date, reason: decision.reason });
          continue;
        }

        const slot = decision.slot;
        line.days[date] = slot;
        fillBySlot.set(slot.slotKey, (fillBySlot.get(slot.slotKey) ?? 0) + 1);

        const snapshot = this.snapshotOf(liveHistory);
        assignments.push(
          ShiftAssignment.create({
            id: randomUUID(),
            templateId: slot.templateId,
            date: slot.date,
            employeeId: emp.id,
            companyId,
            origin: decision.origin,
            strategyType: 'hybrid',
            fairnessSnapshot: snapshot,
            actualStartTime: slot.startTime,
            actualEndTime: slot.endTime,
          }),
        );

        const curr = liveHistory.get(emp.id)!;
        liveHistory.set(
          emp.id,
          curr.addShift(slot.getDuration(), {
            isUndesirable: slot.undesirableWeight >= 0.5,
            isNight: slot.isNightShift(),
            isWeekend: slot.isWeekendShift(),
          }),
        );
      }
    }

    // ── Reporte de underfilled (slots con target > 0 sin llegar) ─────────
    const underfilled: BuilderResult['underfilled'] = [];
    for (const s of slots) {
      const target = s.requiredEmployees;
      if (target === null || target === undefined || target <= 0) continue;
      const filled = fillBySlot.get(s.slotKey) ?? 0;
      if (filled < target) underfilled.push({ slot: s, target, filled });
    }

    this.logger.log(
      `WeekScheduleBuilder: ${assignments.length} assignments, ${restDays.length} rest days, ${underfilled.length} underfilled`,
    );

    return { assignments, restDays, underfilled };
  }

  /**
   * Decisión para una celda (empleado × día) siguiendo los 5 pasos.
   */
  private decideCell(params: {
    emp: Employee;
    date: string;
    daySlots: VirtualShiftSlot[];
    line: EmployeeWeekLine;
    fillBySlot: Map<string, number>;
    memberships: ShiftMembership[];
    hardRules: SemanticConstraint[];
    multiShiftPermits?: Set<string>;
    llmLines?: Map<string, Record<string, string | 'rest'>>;
  }):
    | { type: 'rest'; reason: string }
    | { type: 'assign'; slot: VirtualShiftSlot; origin: 'membership' | 'override' | 'exception' } {
    const {
      emp,
      date,
      daySlots,
      line,
      fillBySlot,
      memberships,
      hardRules,
      multiShiftPermits,
      llmLines,
    } = params;

    // Paso 0 (implícito): ya asignado → no sobrescribir. La iteración por
    // línea evita esto de entrada; defensa ante reentradas.
    if (line.days[date] !== null) {
      return { type: 'rest', reason: 'already-decided' };
    }

    // One-shift-per-day: si la línea ya tiene otro día del mismo slot.date
    // (no debería pasar porque iteramos día por día), saltamos.

    // Paso 1 — BLOCK global del día (feriado: SEMANTIC_BLOCKED_ALL sobre
    // cualquier slot del día). Día libre para todos.
    const dayFullyBlocked = daySlots.every((slot) =>
      hardRules.some(
        (c) =>
          c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId === slot.slotKey,
      ),
    );
    if (dayFullyBlocked) {
      return { type: 'rest', reason: 'holiday' };
    }

    // Paso 2 — Filtrar slots elegibles (hard rules + skills + availability).
    const eligible = daySlots.filter((slot) => {
      // Slot totalmente bloqueado
      if (
        hardRules.some(
          (c) => c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId === slot.slotKey,
        )
      ) return false;
      // Empleado bloqueado puntualmente
      if (
        hardRules.some(
          (c) =>
            c.employeeId === emp.id &&
            c.employeeId !== SEMANTIC_BLOCKED_ALL &&
            (!c.shiftId || c.shiftId === slot.slotKey),
        )
      ) return false;
      // Skill requerida
      if (slot.requiredSkillId) {
        const has = emp.getSkills().some((s) => s.id === slot.requiredSkillId);
        if (!has) return false;
      }
      // Disponibilidad estructural
      if (!emp.isAvailable(slot.startTime, slot.endTime)) return false;
      // requiredEmployees === 0 → excluido (feriado por ese template)
      if (slot.requiredEmployees === 0) return false;
      return true;
    });

    if (eligible.length === 0) {
      return { type: 'rest', reason: 'no-eligible-template' };
    }

    // Paso 3a — Membership activa ese día: es regla hard (el manager la
    // configuró explícitamente). Gana sobre sugerencias del LLM.
    const memberOptions = eligible.filter((slot) =>
      memberships.some(
        (m) => m.templateId === slot.templateId && m.isActiveOn(date),
      ),
    );
    if (memberOptions.length > 0) {
      const ranked = memberOptions
        .map((s) => ({ slot: s, fill: fillBySlot.get(s.slotKey) ?? 0 }))
        .sort((a, b) => a.fill - b.fill);
      return { type: 'assign', slot: ranked[0].slot, origin: 'membership' };
    }

    // Paso 3b — Propuesta del LLM (si la hay) para este empleado/día.
    // Solo aceptamos la sugerencia cuando apunta a un slot elegible y no
    // satura un target. `rest` se IGNORA: el LLM no puede forzar descansos
    // sin respaldo de reglas hard (feriado / bloqueos explícitos ya
    // capturados en los pasos 1–2). Si la sugerencia no sirve, seguimos al
    // paso 4 y que la distribución determinística decida.
    const llmPick = llmLines?.get(emp.id)?.[date];
    if (llmPick && llmPick !== 'rest') {
      const suggested = eligible.find((s) => s.templateId === llmPick);
      if (suggested) {
        const fill = fillBySlot.get(suggested.slotKey) ?? 0;
        const target = suggested.requiredEmployees;
        const underOrElastic =
          target === null || target === undefined || fill < target;
        if (underOrElastic) {
          return { type: 'assign', slot: suggested, origin: 'membership' };
        }
      }
    }

    // Paso 4 — Distribución libre con tres prioridades:
    //   (1) target > 0 y fill < target → under-target, rellenar primero
    //   (2) target === null             → elástico, recibe sobrantes
    //   (3) target > 0 y fill >= target → over-target, último recurso
    // Dentro de cada categoría, el menos saturado primero.
    const categoryOf = (slot: VirtualShiftSlot, fill: number): 1 | 2 | 3 => {
      const t = slot.requiredEmployees;
      if (t === null || t === undefined) return 2;
      if (fill < t) return 1;
      return 3;
    };
    const ranked = eligible
      .map((slot) => ({
        slot,
        fill: fillBySlot.get(slot.slotKey) ?? 0,
      }))
      .sort((a, b) => {
        const ca = categoryOf(a.slot, a.fill);
        const cb = categoryOf(b.slot, b.fill);
        if (ca !== cb) return ca - cb;
        return a.fill - b.fill;
      });

    const chosen = ranked[0].slot;

    // Ignore multiShiftPermits here — la regla "un turno por día" la
    // garantiza el propio loop externo (decidimos una celda por día).
    void multiShiftPermits;

    return { type: 'assign', slot: chosen, origin: 'membership' };
  }

  private snapshotOf(live: Map<string, FairnessHistoryVO>): Record<string, number> {
    const snap: Record<string, number> = {};
    for (const [id, h] of live) snap[id] = h.computeRawScore();
    return snap;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Modo LLM-autoritario: `applyLines` aplica literalmente lo que dice el LLM.
  // `verify` comprueba reglas hard y reporta violaciones para el loop.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Toma las líneas del LLM y materializa asignaciones RESPETANDO literalmente
   * lo que dice — incluido `rest`. NO redistribuye. Si la línea no tiene una
   * decisión para una celda (empleado × día), esa celda queda `rest` por omisión.
   */
  applyLines(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    histories: FairnessHistoryVO[];
    llmLines: Map<string, Record<string, string | 'rest'>>;
    weekStart: Date;
    companyId: string;
  }): BuilderResult {
    const { employees, slots, histories, llmLines, weekStart, companyId } = params;

    const slotByKey = new Map<string, VirtualShiftSlot>();
    for (const s of slots) slotByKey.set(`${s.templateId}|${s.date}`, s);

    const dates = new Set(slots.map((s) => s.date));
    const liveHistory = new Map<string, FairnessHistoryVO>(
      employees.map((e) => {
        const existing = histories.find((h) => h.employeeId === e.id);
        return [
          e.id,
          existing ?? FairnessHistoryVO.empty(e.id, e.companyId, weekStart),
        ];
      }),
    );

    const fillBySlot = new Map<string, number>();
    const assignments: ShiftAssignment[] = [];
    const restDays: BuilderResult['restDays'] = [];

    for (const emp of employees) {
      const days = llmLines.get(emp.id) ?? {};
      for (const date of dates) {
        const pick = days[date];
        if (!pick || pick === 'rest') {
          restDays.push({ employeeId: emp.id, date, reason: 'llm-rest' });
          continue;
        }
        const key = `${pick}|${date}`;
        const slot = slotByKey.get(key);
        if (!slot) {
          // El LLM apuntó a un (template, día) que no existe → celda rest.
          restDays.push({ employeeId: emp.id, date, reason: 'llm-unknown-slot' });
          continue;
        }
        const snapshot = this.snapshotOf(liveHistory);
        assignments.push(
          ShiftAssignment.create({
            id: randomUUID(),
            templateId: slot.templateId,
            date: slot.date,
            employeeId: emp.id,
            companyId,
            origin: 'membership',
            strategyType: 'hybrid',
            fairnessSnapshot: snapshot,
            actualStartTime: slot.startTime,
            actualEndTime: slot.endTime,
          }),
        );
        fillBySlot.set(slot.slotKey, (fillBySlot.get(slot.slotKey) ?? 0) + 1);
        const curr = liveHistory.get(emp.id)!;
        liveHistory.set(
          emp.id,
          curr.addShift(slot.getDuration(), {
            isUndesirable: slot.undesirableWeight >= 0.5,
            isNight: slot.isNightShift(),
            isWeekend: slot.isWeekendShift(),
          }),
        );
      }
    }

    const underfilled: BuilderResult['underfilled'] = [];
    for (const s of slots) {
      const target = s.requiredEmployees;
      if (target === null || target === undefined || target <= 0) continue;
      const filled = fillBySlot.get(s.slotKey) ?? 0;
      if (filled < target) underfilled.push({ slot: s, target, filled });
    }

    return { assignments, restDays, underfilled };
  }

  /**
   * Comprueba reglas hard sobre las asignaciones propuestas.
   * Devuelve lista de violaciones (vacía = válido).
   */
  verify(
    assignments: ShiftAssignment[],
    slots: VirtualShiftSlot[],
    semanticRules: SemanticConstraint[],
    employees: Employee[],
    multiShiftPermits?: Set<string>,
  ): VerifyViolation[] {
    const violations: VerifyViolation[] = [];
    const empById = new Map(employees.map((e) => [e.id, e]));
    const slotByKey = new Map(slots.map((s) => [s.slotKey, s]));
    const hardRules = semanticRules.filter((c) => c.weight >= 2);

    // 1. Empleados y templates existen
    for (const a of assignments) {
      if (!empById.has(a.employeeId)) {
        violations.push({
          kind: 'unknown-employee',
          employeeId: a.employeeId,
          message: `Employee ${a.employeeId.slice(0, 8)} does not exist.`,
        });
      }
      if (!slotByKey.has(a.slotKey)) {
        violations.push({
          kind: 'unknown-template',
          slotKey: a.slotKey,
          message: `Shift ${a.slotKey} does not exist.`,
        });
      }
    }

    // 2. Nobody works on a blocked slot (holiday)
    for (const a of assignments) {
      const blocked = hardRules.some(
        (c) => c.employeeId === SEMANTIC_BLOCKED_ALL && c.shiftId === a.slotKey,
      );
      if (blocked) {
        violations.push({
          kind: 'holiday-worked',
          employeeId: a.employeeId,
          date: a.date,
          slotKey: a.slotKey,
          message: `${empById.get(a.employeeId)?.name ?? a.employeeId.slice(0, 8)} is scheduled on ${a.date} but that shift is blocked (holiday).`,
        });
      }
    }

    // 3. Employee-specific hard blocks
    for (const a of assignments) {
      const blocked = hardRules.some(
        (c) =>
          c.employeeId === a.employeeId &&
          c.employeeId !== SEMANTIC_BLOCKED_ALL &&
          (!c.shiftId || c.shiftId === a.slotKey),
      );
      if (blocked) {
        violations.push({
          kind: 'employee-blocked',
          employeeId: a.employeeId,
          date: a.date,
          slotKey: a.slotKey,
          message: `${empById.get(a.employeeId)?.name ?? a.employeeId.slice(0, 8)} is blocked from ${a.slotKey} by a hard rule.`,
        });
      }
    }

    // 4. Required skill
    for (const a of assignments) {
      const slot = slotByKey.get(a.slotKey);
      const emp = empById.get(a.employeeId);
      if (!slot || !emp) continue;
      if (slot.requiredSkillId) {
        const has = emp.getSkills().some((s) => s.id === slot.requiredSkillId);
        if (!has) {
          violations.push({
            kind: 'skill-mismatch',
            employeeId: a.employeeId,
            slotKey: a.slotKey,
            message: `${emp.name} does not have the skill required by ${slot.templateName}.`,
          });
        }
      }
    }

    // 5. One shift per employee per day (unless permit)
    const byEmpDay = new Map<string, ShiftAssignment[]>();
    for (const a of assignments) {
      const key = `${a.employeeId}|${a.date}`;
      if (!byEmpDay.has(key)) byEmpDay.set(key, []);
      byEmpDay.get(key)!.push(a);
    }
    for (const [key, list] of byEmpDay) {
      if (list.length > 1 && !multiShiftPermits?.has(key)) {
        const emp = empById.get(list[0].employeeId);
        violations.push({
          kind: 'two-shifts-same-day',
          employeeId: list[0].employeeId,
          date: list[0].date,
          message: `${emp?.name ?? list[0].employeeId.slice(0, 8)} has ${list.length} shifts on ${list[0].date}.`,
        });
      }
    }

    return violations;
  }

  private formatFeedback(violations: VerifyViolation[]): string {
    const lines = ['Your previous attempt violated the following hard rules:'];
    for (const v of violations.slice(0, 20)) {
      lines.push(`  - ${v.message}`);
    }
    lines.push(
      '',
      'Produce a new proposal that specifically fixes these problems.',
      'Respect ALL rules — fixing only one is not enough.',
    );
    return lines.join('\n');
  }
}
