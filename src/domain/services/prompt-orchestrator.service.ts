import { Injectable, Logger, Inject } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import { LLMScheduleProposalVO } from '../value-objects/llm-schedule-proposal.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import type { WorkingTimePolicyVO } from '../value-objects/working-time-policy.vo';
import { SemanticConstraintInterpreter } from './semantic-constraint-interpreter';
import type { ILLMService } from './llm.service.interface';
import { LLM_SERVICE } from './llm.service.interface';
import {
  ScheduleValidatorService,
  type BusyAssignment,
} from './schedule-validator.service';
import { HybridStrategy } from '../strategies/hybrid.strategy';
import type { VirtualShiftSlot } from '../value-objects/virtual-shift-slot.vo';

export interface OrchestratedResult {
  assignments: ShiftAssignment[];
  /** Slots virtuales que quedaron sin cubrir. */
  unfilledSlots: VirtualShiftSlot[];
  llmAccepted: number;
  algorithmCorrected: number;
  explanation: string;
  warnings: string[];
}

@Injectable()
export class PromptOrchestratorService {
  private readonly logger = new Logger(PromptOrchestratorService.name);
  private readonly CONFIDENCE_THRESHOLD = 0.7;

  constructor(
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
    private readonly validator: ScheduleValidatorService,
    private readonly i18n: I18nService,
  ) {}

  async orchestrate(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    histories: FairnessHistoryVO[];
    companyId: string;
    weekStart: Date;
    semanticRules: SemanticConstraint[];
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
    preResolvedPermits?: Set<string>;
    preResolvedComplexRules?: { ruleId: string; ruleText: string; reason: string }[];
    preResolvedUnstructuredRules?: { ruleId: string; ruleText: string }[];
    locale?: string;
    /**
     * Hint de distribución por slotKey, no cuota obligatoria:
     *  - `N > 0`  → objetivo de ~N empleados en este slot (Phase A)
     *  - `null`   → slot elástico, recibe leftovers del round-robin (Phase B)
     *  - `0`      → explícitamente excluido (no se asigna nadie)
     */
    resolvedCapacities?: Map<string, number | null>;
    /**
     * Asignaciones pre-calculadas por reglas hard (ej. memberships resueltas).
     * Se siembran en `alreadyAssigned` para que el LLM/strategies las respeten.
     */
    preAssignments?: ShiftAssignment[];
  }): Promise<OrchestratedResult> {
    const {
      employees,
      slots,
      histories,
      companyId,
      weekStart,
      semanticRules,
      workingTimePolicies,
      preResolvedPermits,
      preResolvedComplexRules = [],
      preResolvedUnstructuredRules = [],
      locale = 'es',
      resolvedCapacities: passedCapacities,
      preAssignments = [],
    } = params;

    const slotByKey = new Map(slots.map((s) => [s.slotKey, s]));
    const alreadyAssigned = new Map<string, BusyAssignment[]>(
      employees.map((e) => [e.id, []]),
    );

    const llmAssignments: ShiftAssignment[] = [];
    let llmAccepted = 0;
    const slotFillCount = new Map<string, number>();

    // Seed alreadyAssigned + slotFillCount con las asignaciones hard (memberships,
    // overrides manuales, etc.) que ya trae el handler. Estas son inamovibles.
    for (const a of preAssignments) {
      const slot = slotByKey.get(a.slotKey);
      if (!slot) continue;
      const busy = alreadyAssigned.get(a.employeeId) ?? [];
      busy.push({
        slotKey: slot.slotKey,
        startTime: slot.startTime,
        endTime: slot.endTime,
        overlapsWith: (other) => slot.overlapsWith(other),
      });
      alreadyAssigned.set(a.employeeId, busy);
      slotFillCount.set(a.slotKey, (slotFillCount.get(a.slotKey) ?? 0) + 1);
    }
    if (preAssignments.length > 0) {
      this.logger.log(
        `Pre-assignments seeded: ${preAssignments.length} (memberships/overrides)`,
      );
    }

    const resolvedCapacities: Map<string, number | null> =
      passedCapacities ??
      new Map<string, number | null>(slots.map((s) => [s.slotKey, s.requiredEmployees]));
    this.logger.log(
      `CapacityPlanner resolved: ${[...resolvedCapacities.entries()].map(([k, cap]) => `${k.slice(0, 12)}→${cap}`).join(', ')}`,
    );

    const proposal = await this.getLLMProposal({
      employees,
      slots,
      semanticRules,
      weekStart,
      companyId,
      resolvedCapacities,
      workingTimePolicies,
    });

    const interpreterOutput = SemanticConstraintInterpreter.interpret(
      semanticRules,
      employees,
      slots,
    );
    const interpretedResolved = interpreterOutput.filter(
      (c) => c.employeeId || c.shiftId,
    );
    const resolvedConstraints: SemanticConstraint[] = [...interpretedResolved];

    this.logger.log(
      `Resolved constraints (in-prompt): ${interpretedResolved.length} from interpreter (blocks pre-resueltos vienen vía semanticRules del handler)`,
    );

    const multiShiftPermits = new Set<string>(preResolvedPermits ?? []);
    if (multiShiftPermits.size > 0) {
      this.logger.log(`Multi-shift permits: ${multiShiftPermits.size} pre-resolved`);
    }

    // El LLM responde con `shiftId` que en el modelo nuevo es el slotKey.
    const llmProposalMap = new Map<string, any[]>();
    for (const p of proposal.withMinConfidence(this.CONFIDENCE_THRESHOLD).getProposals()) {
      if (!llmProposalMap.has(p.shiftId)) llmProposalMap.set(p.shiftId, []);
      llmProposalMap.get(p.shiftId)!.push(p);
    }

    const coveredByLLM = new Set<string>();

    for (const slot of slots) {
      const proposedAssignments = llmProposalMap.get(slot.slotKey);
      if (!proposedAssignments || proposedAssignments.length === 0) continue;

      // Semántica nueva:
      //   `0`            → slot excluido (ej. feriado) — ignora propuestas del LLM
      //   `N > 0`        → objetivo de distribución: hasta N del LLM, luego pasa a fallback
      //   `null/undef`   → elástico: el LLM puede proponer sin tope; el fallback rellena más
      const targetRaw = resolvedCapacities.get(slot.slotKey);
      const targetCapacity = targetRaw ?? Infinity;

      if (targetRaw === 0) {
        this.logger.log(
          `Slot ${slot.slotKey} has resolved capacity=0 (holiday/exclusion). All LLM proposals ignored.`,
        );
        coveredByLLM.add(slot.slotKey);
        continue;
      }

      let validCount = slotFillCount.get(slot.slotKey) ?? 0; // contar pre-assignments ya hechos
      let intentionallySkipped = false;

      for (const proposedAssignment of proposedAssignments) {
        if (proposedAssignment.employeeId.toUpperCase() === 'NONE') {
          this.logger.debug(
            `Slot ${slot.slotKey} intentionally left empty by LLM (target=${targetRaw ?? 'elastic'}). Reason: ${proposedAssignment.reason}`,
          );
          intentionallySkipped = true;
          break;
        }

        if (validCount >= targetCapacity) {
          this.logger.debug(
            `Slot ${slot.slotKey} reached resolved target (${targetCapacity}). Skipping extra LLM proposals.`,
          );
          break;
        }

        const validationRules = [...semanticRules, ...resolvedConstraints];
        const validation = this.validator.validate(
          slot.slotKey,
          proposedAssignment.employeeId,
          employees,
          slots,
          alreadyAssigned,
          validationRules,
          workingTimePolicies,
          multiShiftPermits,
        );

        if (validation.valid) {
          const assignment = ShiftAssignment.create({
            id: randomUUID(),
            templateId: slot.templateId,
            date: slot.date,
            employeeId: proposedAssignment.employeeId,
            companyId,
            origin: 'membership',
            strategyType: 'hybrid',
            fairnessSnapshot: {},
            actualStartTime: slot.startTime,
            actualEndTime: slot.endTime,
          });

          llmAssignments.push(assignment);
          alreadyAssigned.get(proposedAssignment.employeeId)!.push({
            slotKey: slot.slotKey,
            startTime: slot.startTime,
            endTime: slot.endTime,
            overlapsWith: (other) => slot.overlapsWith(other),
          });
          slotFillCount.set(slot.slotKey, (slotFillCount.get(slot.slotKey) ?? 0) + 1);
          llmAccepted++;
          validCount++;

          this.logger.debug(
            `LLM accepted: slot=${slot.slotKey} employee=${proposedAssignment.employeeId} ` +
              `confidence=${proposedAssignment.confidence.toFixed(2)}`,
          );
        } else {
          this.logger.warn(
            `LLM proposal rejected for slot=${slot.slotKey} employee=${proposedAssignment.employeeId}: ${validation.violations.join('; ')}`,
          );
        }
      }

      // Un slot elástico (targetRaw null/undef) nunca se marca "covered": el
      // fallback round-robin distribuirá los empleados restantes ahí.
      const isElastic = targetRaw === null || targetRaw === undefined;
      if (intentionallySkipped || (!isElastic && validCount >= targetCapacity)) {
        coveredByLLM.add(slot.slotKey);
      }
    }

    // ── STEP 3: Fallback determinístico ───────────────────────────────────
    const remainingSlots = slots.filter((s) => !coveredByLLM.has(s.slotKey));

    let algorithmCorrected = 0;
    const algorithmAssignments: ShiftAssignment[] = [];
    const unfilledSlots: VirtualShiftSlot[] = [];

    if (remainingSlots.length > 0) {
      this.logger.log(
        `Fallback: algorithm covering ${remainingSlots.length} slots not accepted from LLM`,
      );
      algorithmCorrected = remainingSlots.length;

      const strategy = new HybridStrategy();
      const strategyResult = strategy.generate(
        employees,
        remainingSlots,
        histories,
        resolvedConstraints.length > 0 ? resolvedConstraints : semanticRules,
        workingTimePolicies,
        multiShiftPermits,
      );

      const slotByKey = new Map(remainingSlots.map((s) => [s.slotKey, s]));

      for (const a of strategyResult.assignments) {
        const slot = slotByKey.get(a.slotKey);
        if (!slot) continue;
        const empBusy = alreadyAssigned.get(a.employeeId)!;

        if (empBusy.some((bs) => bs.overlapsWith(slot))) {
          this.logger.debug(
            `Algorithm assignment skipped: emp=${a.employeeId.substring(0, 8)} overlaps on ${slot.date}`,
          );
          unfilledSlots.push(slot);
          continue;
        }

        const alreadySameDay = empBusy.some((bs) => bs.startTime.toISOString().split('T')[0] === slot.date);
        if (alreadySameDay && !multiShiftPermits.has(`${a.employeeId}|${slot.date}`)) {
          this.logger.debug(
            `Algorithm assignment skipped: emp=${a.employeeId.substring(0, 8)} already works ${slot.date} (no permit)`,
          );
          unfilledSlots.push(slot);
          continue;
        }

        const currentFill = slotFillCount.get(slot.slotKey) ?? 0;
        const capRaw = resolvedCapacities.get(slot.slotKey);
        // null/undefined → elástico (sin tope); 0 → excluido; N → target blando
        const cap = capRaw ?? Infinity;
        if (cap === 0 || currentFill >= cap) {
          this.logger.debug(
            `Algorithm assignment skipped for slot=${slot.slotKey}: cap=${capRaw} already reached (${currentFill})`,
          );
          continue;
        }

        slotFillCount.set(slot.slotKey, currentFill + 1);
        algorithmAssignments.push(a);
        empBusy.push({
          slotKey: slot.slotKey,
          startTime: slot.startTime,
          endTime: slot.endTime,
          overlapsWith: (other) => slot.overlapsWith(other),
        });
      }
      for (const unfilled of strategyResult.unfilledSlots) {
        unfilledSlots.push(unfilled);
      }
    }

    const allAssignments = [...llmAssignments, ...algorithmAssignments];
    const totalSlots = slots.length;

    // Recompute unfilled: un slot solo está "sin cubrir" si tiene target > 0 y
    // nadie le quedó asignado al final (la strategy puede reportar falsos
    // positivos cuando no conoce los pre-assignments). Los slots elásticos
    // (null) nunca cuentan como unfilled.
    const actuallyUnfilled = slots.filter((s) => {
      const targetRaw = resolvedCapacities.get(s.slotKey);
      if (targetRaw === 0) return false;
      if (targetRaw === null || targetRaw === undefined) return false;
      return (slotFillCount.get(s.slotKey) ?? 0) < targetRaw;
    });
    unfilledSlots.length = 0;
    unfilledSlots.push(...actuallyUnfilled);

    const warnings = this.computeWarnings({
      assignments: allAssignments,
      slots,
      employees,
      unfilledSlots,
      semanticRules,
      resolvedConstraints,
      workingTimePolicies,
      locale,
    });
    for (const r of preResolvedComplexRules) {
      warnings.push(
        this.i18n.t('bot.schedule.warning_complex_rule', {
          lang: locale,
          args: { ruleText: r.ruleText, reason: r.reason },
        }),
      );
    }
    for (const r of preResolvedUnstructuredRules) {
      warnings.push(
        this.i18n.t('bot.schedule.warning_unstructured_rule', {
          lang: locale,
          args: { ruleText: r.ruleText },
        }),
      );
    }
    if (warnings.length > 0) {
      this.logger.warn(
        `Orchestration produced ${warnings.length} warning(s) for manager review`,
      );
      warnings.forEach((w) => this.logger.warn(`  ⚠ ${w}`));
    }

    const explanation = this.buildExplanation({
      totalSlots,
      llmAccepted,
      algorithmCorrected,
      unfilledCount: unfilledSlots.length,
      llmProposedTotal: proposal.count(),
      weekStart,
      locale,
    });

    this.logger.log(
      `Orchestration complete — total=${totalSlots} llmAccepted=${llmAccepted} ` +
        `algorithmCorrected=${algorithmCorrected} unfilled=${unfilledSlots.length} warnings=${warnings.length}`,
    );

    return {
      warnings,
      assignments: allAssignments,
      unfilledSlots,
      llmAccepted,
      algorithmCorrected,
      explanation,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getLLMProposal(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    companyId: string;
    resolvedCapacities: Map<string, number | null>;
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
  }): Promise<LLMScheduleProposalVO> {
    try {
      const prompt = this.buildSchedulingPrompt(params);
      this.logger.debug(
        `LLM prompt (${prompt.length} chars):\n${prompt.slice(0, 2000)}${prompt.length > 2000 ? '\n...[truncated]' : ''}`,
      );
      const rawResponse = await this.llmService.complete(prompt);
      const proposal = LLMScheduleProposalVO.fromLLMResponse(rawResponse);

      this.logger.log(`LLM returned ${proposal.count()} proposed assignments`);
      return proposal;
    } catch (error) {
      this.logger.warn(
        `PromptOrchestrator: LLM call failed, falling back to algorithm. Error: ${(error as Error).message}`,
      );
      return LLMScheduleProposalVO.empty();
    }
  }

  private buildSchedulingPrompt(params: {
    employees: Employee[];
    slots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    companyId: string;
    resolvedCapacities: Map<string, number | null>;
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
  }): string {
    const { employees, slots, semanticRules, weekStart, resolvedCapacities, workingTimePolicies } = params;

    const dateStr = weekStart.toISOString().split('T')[0];

    const employeeSummary = employees
      .slice(0, 20)
      .map((e) => {
        const skills = e.getSkills().map((s) => s.name).join(', ') || 'generic';
        const policy = workingTimePolicies?.get(e.id);
        const limits = policy
          ? ` | Limits: max ${policy.maxHoursPerDay}h/day, ${policy.maxHoursPerWeek}h/week`
          : '';
        return `  - ID: ${e.id} | Skills: [${skills}]${limits}`;
      })
      .join('\n');

    const slotSummary = slots
      .slice(0, 30)
      .map((s) => {
        const capacity = resolvedCapacities.get(s.slotKey) ?? s.requiredEmployees ?? 1;
        return (
          `  - ID: ${s.slotKey} | Template: ${s.templateName} | Required skill: ${s.requiredSkillId ?? 'none'} | ` +
          `Start: ${s.startTime.toISOString()} | End: ${s.endTime.toISOString()} | Required capacity: ${capacity}`
        );
      })
      .join('\n');

    const rulesSummary =
      semanticRules.length > 0
        ? semanticRules
            .map((r, i) => `  ${i + 1}. [P${(r as any).priority ?? '?'}] ${r.rule}`)
            .join('\n')
        : '  (No active semantic rules)';

    return `You are an expert workforce scheduler. Your task is to assign employees to shifts optimally.

WEEK START: ${dateStr}

## AVAILABLE EMPLOYEES (max 20 shown)
${employeeSummary}

## SHIFTS TO COVER (max 30 shown)
${slotSummary}

## SEMANTIC RULES (context — do NOT enforce them yourself)
${rulesSummary}

## IMPORTANT: DO NOT GENERATE BLOCKS OR PERMITS
The restrictions (holidays, days off, double-shift permits) have already been pre-processed by the system from the semantic rules — the validator will apply them automatically. You ONLY need to propose assignments respecting the context shown above. If an assignment of yours violates a rule, it will be rejected automatically.
Do not invent blocks. Do not infer unwritten patterns. If a rule says "Juan off on Monday" but there is no rule about Ana, Ana can work any day.

## INSTRUCTIONS
1. Assign employees to each shift respecting EXACTLY its "Required capacity".
2. There is no "unlimited capacity" concept — each shift has an exact number of people required.
3. If "Required capacity" is 0, the shift MUST NOT be worked by anyone.
4. If capacity > 1, assign EXACTLY that number of employees (multiple objects with the same shiftId).
5. Strictly respect priority-1 semantic rules AND the individual "Limits" of each employee.
6. For each assignment, include a confidence level between 0.0 and 1.0.
7. The "reason" field must be VERY BRIEF (max 8 words) — prioritize tokens for covering all shifts.
8. Write "reason" in the same language used by the rules in "SEMANTIC RULES" above (match the input language).

## RESPONSE FORMAT (STRICT JSON, no text before the JSON)
{
  "assignments": [
    {
      "shiftId": "slot-key-exactly-as-shown-above",
      "employeeId": "uuid-of-the-employee",
      "reason": "brief justification",
      "confidence": 0.95
    }
  ]
}

CRITICAL JSON RULES:
- The "assignments" array MUST contain ONE entry PER SHIFT. Do NOT omit any shift (${slots.length} shifts total).
- If a shift's "Required capacity" is 0, send exactly ONE object with "employeeId": "NONE" for that shift.
- For shifts with capacity > 1, send multiple objects with the same shiftId, one per assigned employee.
- Assign EXACTLY the number indicated in "Required capacity" — no more, no less.`;
  }

  private computeWarnings(params: {
    assignments: ShiftAssignment[];
    slots: VirtualShiftSlot[];
    employees: Employee[];
    unfilledSlots: VirtualShiftSlot[];
    semanticRules: SemanticConstraint[];
    resolvedConstraints: SemanticConstraint[];
    workingTimePolicies?: Map<string, WorkingTimePolicyVO>;
    locale?: string;
  }): string[] {
    const {
      slots,
      employees,
      unfilledSlots,
      semanticRules,
      resolvedConstraints,
      locale = 'es',
    } = params;
    void params.workingTimePolicies;
    void params.assignments;

    const warnings: string[] = [];

    for (const rule of semanticRules.filter((r) => r.weight >= 2)) {
      const interpreted = SemanticConstraintInterpreter.interpret(
        [rule],
        employees,
        slots,
      );
      const resolvedAnyId = interpreted.some((c) => c.employeeId || c.shiftId);
      if (!resolvedAnyId) {
        warnings.push(
          this.i18n.t('bot.schedule.warning_complex_rule', {
            lang: locale,
            args: {
              ruleText: rule.rule,
              reason: (rule as any).complexReason ?? '',
            },
          }),
        );
      }
    }

    const uniqueUnfilled = Array.from(
      new Map(unfilledSlots.map((s) => [s.slotKey, s])).values(),
    );
    for (const slot of uniqueUnfilled) {
      const blockedByHoliday = resolvedConstraints.some(
        (c) => c.weight >= 2 && c.shiftId === slot.slotKey,
      );
      if (blockedByHoliday) continue;
      warnings.push(
        this.i18n.t('bot.schedule.warning_unfilled_shift', {
          lang: locale,
          args: {
            date: slot.date,
            from: slot.startTime.toISOString().slice(11, 16),
            to: slot.endTime.toISOString().slice(11, 16),
          },
        }),
      );
    }

    return warnings;
  }

  private buildExplanation(params: {
    totalSlots: number;
    llmAccepted: number;
    algorithmCorrected: number;
    unfilledCount: number;
    llmProposedTotal: number;
    weekStart: Date;
    locale?: string;
  }): string {
    const {
      totalSlots,
      llmAccepted,
      algorithmCorrected,
      unfilledCount,
      llmProposedTotal,
      weekStart,
      locale = 'es',
    } = params;
    const covered = llmAccepted + algorithmCorrected;
    const dateStr = weekStart.toISOString().split('T')[0];
    const llmFailed = llmProposedTotal === 0 && llmAccepted === 0;

    const parts: string[] = [
      this.i18n.t('bot.schedule.explanation_header', {
        lang: locale,
        args: { date: dateStr, total: totalSlots },
      }),
      llmFailed
        ? this.i18n.t('bot.schedule.explanation_llm_failed', { lang: locale })
        : this.i18n.t('bot.schedule.explanation_llm_ok', {
            lang: locale,
            args: { n: llmAccepted },
          }),
    ];

    if (algorithmCorrected > 0) {
      parts.push(
        this.i18n.t('bot.schedule.explanation_algorithm', {
          lang: locale,
          args: { n: algorithmCorrected },
        }),
      );
    }

    if (unfilledCount > 0) {
      parts.push(
        this.i18n.t('bot.schedule.explanation_unfilled', {
          lang: locale,
          args: { n: unfilledCount },
        }),
      );
    } else {
      parts.push(
        this.i18n.t('bot.schedule.explanation_complete', {
          lang: locale,
          args: { covered, total: totalSlots },
        }),
      );
    }

    return parts.join(' ');
  }
}
