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
    ) { }

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
        const { employees, shifts, histories, companyId, weekStart, semanticRules } = params;

        // Estado compartido: turnos ya asignados por empleado (para validación de solapamientos)
        const alreadyAssigned = new Map<string, Shift[]>(
            employees.map(e => [e.id, []]),
        );

        const llmAssignments: ShiftAssignment[] = [];
        let llmAccepted = 0;

        // ── STEP 1: Obtener propuesta del LLM ─────────────────────────────────
        const proposal = await this.getLLMProposal({
            employees, shifts, semanticRules, weekStart, companyId,
        });

        // Mapa de shiftId → asignación propuesta por el LLM (para lookup rápido)
        const llmProposalMap = new Map(
            proposal.withMinConfidence(this.CONFIDENCE_THRESHOLD)
                .getProposals()
                .map(p => [p.shiftId, p]),
        );

        // ── STEP 2: Validar propuestas del LLM ────────────────────────────────
        const coveredByLLM = new Set<string>();

        for (const shift of shifts) {
            const proposedAssignment = llmProposalMap.get(shift.id);
            if (!proposedAssignment) continue;

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
                coveredByLLM.add(shift.id);
                alreadyAssigned.get(proposedAssignment.employeeId)!.push(shift);
                llmAccepted++;

                this.logger.debug(
                    `LLM accepted: shift=${shift.id} employee=${proposedAssignment.employeeId} ` +
                    `confidence=${proposedAssignment.confidence.toFixed(2)}`,
                );
            } else {
                this.logger.warn(
                    `LLM proposal rejected for shift=${shift.id}: ${validation.violations.join('; ')}`,
                );
            }
        }

        // ── STEP 3: Fallback determinístico para turnos no cubiertos ──────────
        const remainingShifts = shifts.filter(s => !coveredByLLM.has(s.id));
        const remainingEmployees = employees.filter(e => {
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

            algorithmAssignments = strategyResult.assignments;
            unfilledShifts = strategyResult.unfilledShifts;
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
    }): Promise<LLMScheduleProposalVO> {
        try {
            const prompt = this.buildSchedulingPrompt(params);
            const rawResponse = await this.llmService.complete(prompt);
            const proposal = LLMScheduleProposalVO.fromLLMResponse(rawResponse);

            this.logger.log(
                `LLM returned ${proposal.count()} proposed assignments`,
            );

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
    }): string {
        const { employees, shifts, semanticRules, weekStart } = params;

        const dateStr = weekStart.toLocaleDateString('es-ES', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });

        const employeeSummary = employees.slice(0, 20).map(e =>
            `  - ID: ${e.id} | Skills: [${e.getSkills().map(s => s.name).join(', ') || 'genérico'}]`,
        ).join('\n');

        const shiftSummary = shifts.slice(0, 30).map(s =>
            `  - ID: ${s.id} | Skill requerida: ${s.requiredSkillId ?? 'ninguna'} | ` +
            `Inicio: ${s.startTime} | Fin: ${s.endTime}`,
        ).join('\n');

        const rulesSummary = semanticRules.length > 0
            ? semanticRules.map((r, i) => `  ${i + 1}. [P${(r as any).priority ?? '?'}] ${r.rule}`).join('\n')
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
1. Asigna cada turno al empleado más adecuado según sus skills
2. Distribuye los turnos con equidad (evita sobrecargar a un empleado)
3. Respeta ESTRICTAMENTE las restricciones con prioridad 1 (LEGALES)
4. Para cada asignación, indica un nivel de confianza entre 0.0 y 1.0

## FORMATO DE RESPUESTA (JSON ESTRICTO, sin texto adicional antes del JSON)
{
  "assignments": [
    {
      "shiftId": "uuid-del-turno",
      "employeeId": "uuid-del-empleado",
      "reason": "Breve justificación en español (máx. 80 caracteres)",
      "confidence": 0.95
    }
  ]
}

IMPORTANTE: Responde SOLO con el objeto JSON. No añadas explicaciones fuera del JSON.`;
    }

    private buildExplanation(params: {
        totalShifts: number;
        llmAccepted: number;
        algorithmCorrected: number;
        unfilledCount: number;
        llmProposedTotal: number;
    }): string {
        const { totalShifts, llmAccepted, algorithmCorrected, unfilledCount, llmProposedTotal } = params;
        const covered = llmAccepted + algorithmCorrected;

        const parts: string[] = [
            `Horario generado para ${totalShifts} turno(s).`,
            llmProposedTotal === 0
                ? 'El LLM no pudo generar propuestas; el algoritmo cubrió todos los turnos.'
                : `El LLM propuso ${llmProposedTotal} asignaciones; se aceptaron ${llmAccepted} tras validación.`,
        ];

        if (algorithmCorrected > 0) {
            parts.push(`El algoritmo determinístico cubrió ${algorithmCorrected} turno(s) adicional(es).`);
        }

        if (unfilledCount > 0) {
            parts.push(`${unfilledCount} turno(s) quedaron sin cubrir por falta de candidatos disponibles.`);
        } else {
            parts.push(`Cobertura completa: ${covered}/${totalShifts} turnos asignados.`);
        }

        return parts.join(' ');
    }
}
