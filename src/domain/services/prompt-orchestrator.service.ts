import { Injectable, Logger, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Employee } from '../aggregates/employee.aggregate';
import type { Shift } from '../aggregates/shift.aggregate';
import { ShiftAssignment } from '../aggregates/shift-assignment.aggregate';
import type { FairnessHistoryVO } from '../value-objects/fairness-history.vo';
import { LLMScheduleProposalVO } from '../value-objects/llm-schedule-proposal.vo';
import type { SemanticConstraint } from '../strategies/scheduling-strategy.interface';
import type { ILLMService } from './llm.service.interface';
import { LLM_SERVICE } from './llm.service.interface';
import { ScheduleValidatorService } from './schedule-validator.service';
import { HybridStrategy } from '../strategies/hybrid.strategy';
import { ShiftCapacityPlannerService } from './shift-capacity-planner.service';

// ─── Result Types ──────────────────────────────────────────────────────────────

export interface OrchestratedResult {
  assignments: ShiftAssignment[];
  unfilledShifts: Shift[];
  /** Cuántas asignaciones propuso correctamente el LLM */
  llmAccepted: number;
  /** Cuántas asignaciones corrigió el algoritmo determinístico */
  algorithmCorrected: number;
  /** Resumen en lenguaje natural del proceso */
  explanation: string;
}

/**
 * PromptOrchestratorService — Servicio de dominio (núcleo del Prompt Orchestrator)
 *
 * Implementa el flujo de verificación doble:
 *
 *   1. Construye un prompt estructurado con el contexto completo del scheduling
 *   2. Envía el prompt al LLM (Gemini) para obtener una propuesta de asignaciones
 *   3. Valida CADA asignación propuesta contra las restricciones duras del sistema
 *   4. Acepta las válidas y usa el algoritmo determinístico (HybridStrategy) para
 *      cubrir los turnos inválidos o no propuestos por el LLM
 *   5. Devuelve el resultado final con trazabilidad completa
 *
 * **Garantía de seguridad:** el horario final NUNCA viola restricciones duras,
 * aunque el LLM proponga algo incorrecto. El algoritmo siempre cubre la diferencia.
 *
 * **Resiliencia:** si el LLM falla, el orquestador delega completamente en el
 * algoritmo determinístico y retorna el horario sin interrupción.
 */
@Injectable()
export class PromptOrchestratorService {
  private readonly logger = new Logger(PromptOrchestratorService.name);

  /** Umbral mínimo de confianza del LLM para aceptar una propuesta */
  private readonly CONFIDENCE_THRESHOLD = 0.7;

  constructor(
    @Inject(LLM_SERVICE)
    private readonly llmService: ILLMService,
    private readonly validator: ScheduleValidatorService,
    private readonly capacityPlanner: ShiftCapacityPlannerService,
  ) {}

  /**
   * Orquesta la generación híbrida LLM + algoritmo para un set de turnos.
   */
  async orchestrate(params: {
    employees: Employee[];
    shifts: Shift[];
    histories: FairnessHistoryVO[];
    companyId: string;
    weekStart: Date;
    semanticRules: SemanticConstraint[];
  }): Promise<OrchestratedResult> {
    const {
      employees,
      shifts,
      histories,
      companyId,
      weekStart,
      semanticRules,
    } = params;

    // Estado compartido: turnos ya asignados por empleado (para validación de solapamientos)
    const alreadyAssigned = new Map<string, { id: string; startTime: Date; endTime: Date; overlapsWith: (other: Shift) => boolean }[]>(
      employees.map((e) => [e.id, []]),
    );

    const llmAssignments: ShiftAssignment[] = [];
    let llmAccepted = 0;

    // ── STEP 0: Pre-computar capacidades concretas ────────────────────────
    // Elimina el concepto de "Ilimitada" antes de llegar al LLM.
    const resolvedCapacities = this.capacityPlanner.plan({
      employees,
      shifts,
      semanticRules,
    });
    this.logger.log(
      `CapacityPlanner resolved: ${[...resolvedCapacities.entries()].map(([id, cap]) => `${id.substring(0, 6)}→${cap}`).join(', ')}`,
    );

    // ── STEP 1: Obtener propuesta del LLM ─────────────────────────────────
    const proposal = await this.getLLMProposal({
      employees,
      shifts,
      semanticRules,
      weekStart,
      companyId,
      resolvedCapacities,
    });

    // Mapa de shiftId → array de asignaciones propuestas por el LLM
    const llmProposalMap = new Map<string, any[]>();
    for (const p of proposal.withMinConfidence(this.CONFIDENCE_THRESHOLD).getProposals()) {
      if (!llmProposalMap.has(p.shiftId)) {
        llmProposalMap.set(p.shiftId, []);
      }
      llmProposalMap.get(p.shiftId)!.push(p);
    }

    // ── STEP 2: Validar propuestas del LLM ────────────────────────────────
    const coveredByLLM = new Set<string>();

    for (const shift of shifts) {
      const proposedAssignments = llmProposalMap.get(shift.id);
      if (!proposedAssignments || proposedAssignments.length === 0) continue;

      // Capacidad resuelta: usa el valor del planner (ya no existe "Ilimitada")
      const targetCapacity = resolvedCapacities.get(shift.id) ?? 1;

      // Feriado / capacidad cero: ignorar TODAS las propuestas del LLM para este turno.
      // El turno quedará marcado como cubierto con 0 asignaciones (correcto).
      if (targetCapacity === 0) {
        this.logger.log(
          `Shift ${shift.id} has resolved capacity=0 (holiday/exclusion). All LLM proposals ignored.`,
        );
        coveredByLLM.add(shift.id);
        continue;
      }

      let validCount = 0;
      let intentionallySkipped = false;

      for (const proposedAssignment of proposedAssignments) {
        // Special case: LLM intentionally skipped this shift due to semantic rules
        if (proposedAssignment.employeeId.toUpperCase() === 'NONE') {
          this.logger.debug(`Shift ${shift.id} intentionally left empty by LLM (capacity=${targetCapacity}). Reason: ${proposedAssignment.reason}`);
          intentionallySkipped = true;
          break; // Stop evaluating other proposals for this shift
        }

        // Respetar la capacidad resuelta por el planner
        if (validCount >= targetCapacity) {
          this.logger.debug(`Shift ${shift.id} reached resolved capacity (${targetCapacity}). Skipping extra LLM proposals.`);
          break;
        }

        const validation = this.validator.validate(
          shift.id,
          proposedAssignment.employeeId,
          employees,
          shifts,
          alreadyAssigned,
          semanticRules,
        );

        if (validation.valid) {
          // ✅ LLM propuesta válida → aceptar
          const assignment = ShiftAssignment.create({
            id: randomUUID(),
            shiftId: shift.id,
            employeeId: proposedAssignment.employeeId,
            companyId,
            strategyType: 'hybrid',
            fairnessSnapshot: {},
          });

          llmAssignments.push(assignment);
          alreadyAssigned.get(proposedAssignment.employeeId)!.push({
            id: shift.id,
            startTime: shift.startTime,
            endTime: shift.endTime,
            overlapsWith: (other: Shift) => shift.overlapsWith(other),
          });
          llmAccepted++;
          validCount++;

          this.logger.debug(
            `LLM accepted: shift=${shift.id} employee=${proposedAssignment.employeeId} ` +
              `confidence=${proposedAssignment.confidence.toFixed(2)}`,
          );
        } else {
          this.logger.warn(
            `LLM proposal rejected for shift=${shift.id} employee=${proposedAssignment.employeeId}: ${validation.violations.join('; ')}`,
          );
        }
      }

      // El turno está cubierto si alcanzó la cuota resuelta, o si el LLM lo omitió intencionalmente.
      // Si la cuota es 0 (feriado), el turno se marca como cubierto automáticamente.
      if (
        intentionallySkipped ||
        targetCapacity === 0 ||
        validCount >= targetCapacity
      ) {
        coveredByLLM.add(shift.id);
      }
    }

    // ── STEP 3: Fallback determinístico para turnos no cubiertos ──────────
    const remainingShifts = shifts.filter((s) => !coveredByLLM.has(s.id));
    const remainingEmployees = employees.filter((e) => {
      // Los empleados ya asignados pueden seguir participando (si no hay overlap)
      return true;
    });

    let algorithmCorrected = 0;
    let algorithmAssignments: ShiftAssignment[] = [];
    let unfilledShifts: Shift[] = [];

    if (remainingShifts.length > 0) {
      this.logger.log(
        `Fallback: algorithm covering ${remainingShifts.length} shifts not accepted from LLM`,
      );
      algorithmCorrected = remainingShifts.length;

      const strategy = new HybridStrategy();
      const strategyResult = strategy.generate(
        remainingEmployees,
        remainingShifts,
        histories,
        semanticRules,
      );

      // Filtro posterior: asegurar que las asignaciones del algoritmo no se solapen con las del LLM
      for (const a of strategyResult.assignments) {
        const shift = shifts.find((s) => s.id === a.shiftId)!;
        const empBusy = alreadyAssigned.get(a.employeeId)!;
        if (empBusy.some((bs) => bs.overlapsWith(shift))) {
          unfilledShifts.push(shift);
          continue;
        }
        algorithmAssignments.push(a);
        empBusy.push({
          id: shift.id,
          startTime: shift.startTime,
          endTime: shift.endTime,
          overlapsWith: (other: Shift) => shift.overlapsWith(other),
        }); // Evitar futuros solapamientos en caso de que hubiese
      }
      unfilledShifts.push(...strategyResult.unfilledShifts);
    }

    const allAssignments = [...llmAssignments, ...algorithmAssignments];
    const totalShifts = shifts.length;
    const coveredShifts = allAssignments.length;

    const explanation = this.buildExplanation({
      totalShifts,
      llmAccepted,
      algorithmCorrected,
      unfilledCount: unfilledShifts.length,
      llmProposedTotal: proposal.count(),
      weekStart,
    });

    this.logger.log(
      `Orchestration complete — total=${totalShifts} llmAccepted=${llmAccepted} ` +
        `algorithmCorrected=${algorithmCorrected} unfilled=${unfilledShifts.length}`,
    );

    return {
      assignments: allAssignments,
      unfilledShifts,
      llmAccepted,
      algorithmCorrected,
      explanation,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getLLMProposal(params: {
    employees: Employee[];
    shifts: Shift[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    companyId: string;
    resolvedCapacities: Map<string, number>;
  }): Promise<LLMScheduleProposalVO> {
    try {
      const prompt = this.buildSchedulingPrompt(params);
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

  /**
   * Construye el prompt de scheduling con contexto completo.
   *
   * El prompt sigue las mejores prácticas de prompting para LLMs de scheduling:
   * - Rol explícito del LLM
   * - Restricciones enumeradas claramente
   * - Formato de salida JSON ESTRICTO
   * - Pide confianza por asignación para filtrado posterior
   */
  private buildSchedulingPrompt(params: {
    employees: Employee[];
    shifts: Shift[];
    semanticRules: SemanticConstraint[];
    weekStart: Date;
    companyId: string;
    resolvedCapacities: Map<string, number>;
  }): string {
    const { employees, shifts, semanticRules, weekStart, resolvedCapacities } = params;

    const dateStr = weekStart.toLocaleDateString('es-ES', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const employeeSummary = employees
      .slice(0, 20)
      .map(
        (e) =>
          `  - ID: ${e.id} | Skills: [${
            e
              .getSkills()
              .map((s) => s.name)
              .join(', ') || 'genérico'
          }]`,
      )
      .join('\n');

    const shiftSummary = shifts
      .slice(0, 30)
      .map((s) => {
        const capacity = resolvedCapacities.get(s.id) ?? s.requiredEmployees ?? 1;
        return (
          `  - ID: ${s.id} | Skill requerida: ${s.requiredSkillId ?? 'ninguna'} | ` +
          `Inicio: ${s.startTime.toISOString()} | Fin: ${s.endTime.toISOString()} | Capacidad requerida: ${capacity}`
        );
      })
      .join('\n');

    const rulesSummary =
      semanticRules.length > 0
        ? semanticRules
            .map(
              (r, i) =>
                `  ${i + 1}. [P${(r as any).priority ?? '?'}] ${r.rule}`,
            )
            .join('\n')
        : '  (No hay reglas semánticas activas)';

    return `Eres un experto en planificación de horarios laborales. Tu tarea es asignar empleados a turnos de manera óptima.

SEMANA: ${dateStr}

## EMPLEADOS DISPONIBLES (máx. 20 mostrados)
${employeeSummary}

## TURNOS A CUBRIR (máx. 30 mostrados)
${shiftSummary}

## RESTRICCIONES SEMÁNTICAS (DEBES respetarlas)
${rulesSummary}

## INSTRUCCIONES
1. Asigna empleados a cada turno respetando EXACTAMENTE su "Capacidad requerida".
2. NO existe el concepto de capacidad ilimitada. Cada turno tiene un número exacto de personas requeridas.
3. Si la "Capacidad requerida" es 0 (por feriado u otra restricción), el turno NO debe ser trabajado por nadie.
4. Si la capacidad es mayor que 1, debes asignar EXACTAMENTE ese número de empleados (múltiples objetos con el mismo shiftId).
5. Respeta ESTRICTAMENTE las reglas semánticas con prioridad 1.
6. Para cada asignación, indica un nivel de confianza entre 0.0 y 1.0.

## FORMATO DE RESPUESTA (JSON ESTRICTO, sin texto adicional antes del JSON)
{
  "assignments": [
    {
      "shiftId": "uuid-del-turno",
      "employeeId": "uuid-del-empleado",
      "reason": "Breve justificación en español",
      "confidence": 0.95
    }
  ]
}

IMPORTANTE (REGLAS DE VIDA O MUERTE PARA EL CUMPLIMIENTO DEL JSON):
- El arreglo "assignments" DEBE CONTENER UNA RESPUESTA PARA CADA UNO DE LOS ${shifts.length} TURNOS. BAJO NINGUNA CIRCUNSTANCIA puedes omitir la salida de un turno en el JSON.
- Si la "Capacidad requerida" de un turno es 0, DEBES enviar exactamente un objeto con "employeeId": "NONE" para ese turno.
- Para turnos con capacidad > 1, envía múltiples objetos con el mismo shiftId, uno por empleado asignado.
- Asigna EXACTAMENTE el número indicado en "Capacidad requerida", ni uno más ni uno menos.`;
  }

  private buildExplanation(params: {
    totalShifts: number;
    llmAccepted: number;
    algorithmCorrected: number;
    unfilledCount: number;
    llmProposedTotal: number;
    weekStart: Date;
  }): string {
    const {
      totalShifts,
      llmAccepted,
      algorithmCorrected,
      unfilledCount,
      llmProposedTotal,
      weekStart,
    } = params;
    const covered = llmAccepted + algorithmCorrected;

    const dateStr = weekStart.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });

    const llmFailed = llmProposedTotal === 0 && llmAccepted === 0;
    const parts: string[] = [
      `📅 Horario generado para la semana del ${dateStr} (${totalShifts} turno(s) solicitados).`,
      llmFailed
        ? 'LLM no pudo generar propuestas. El algoritmo determinístico cubrió todos los turnos.'
        : `El LLM (Qwen) analizó y asignó ${llmAccepted} turnos bajo cumplimiento de reglas.`,
    ];

    if (algorithmCorrected > 0) {
      parts.push(
        `El algoritmo determinístico cubrió ${algorithmCorrected} turno(s) adicional(es).`,
      );
    }

    if (unfilledCount > 0) {
      parts.push(
        `${unfilledCount} turno(s) quedaron sin cubrir por falta de candidatos disponibles.`,
      );
    } else {
      parts.push(
        `Cobertura completa: ${covered}/${totalShifts} turnos asignados.`,
      );
    }

    return parts.join(' ');
  }
}
